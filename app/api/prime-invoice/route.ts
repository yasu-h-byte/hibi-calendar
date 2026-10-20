/**
 * 一次（山岡建設工業など）への請求書 API（2026-10-20）。仕組みは lib/prime-invoice.ts の冒頭と docs/prime-invoice.md。
 *
 * GET  ?ym=YYYYMM                 → その月の請求書（会社×現場ごと）＋ 選べる一次の会社と現場 ＋ 月の一覧
 * GET  ?id=ID                     → 1件（下書き・申請中は 出面との検算 と 承認の有無 も）
 * GET  ?open=ID&i=N               → ファイルを見る署名つきURL（15分）。控除計算書（給与の内訳）は pay.view の人だけ
 * POST multipart/form-data { action:'upload', companyId, siteId, ym, docId?, files[] }
 *      → PDF をサーバーで置き場に置き、読み取って下書きを作る（docId が下書きなら足して読み直す）。
 *        置き場の CORS は本番の URL からの直接 PUT しか許可していないので（Preview で止まる）、この機能は API 経由（1回 4MB まで。画面が分けて送る）
 * POST { action:'update', id, sheets?, invoiceDate? }              → 下書きの数字を手で直す（枚の index ごと）
 * POST { action:'removeFile', id, path }                            → 下書きからファイルを外して読み直す
 * POST { action:'request' | 'withdraw' | 'delete', id }            → 申請・取り下げ・下書きの削除（invoice.request）
 * POST { action:'approve' | 'issue' | 'reject' | 'void', id, reason? } → 承認して発行・直接発行・差し戻し・取り消し（invoice.approve）
 *
 * 給与の鍵: 控除の給与額（個人の給与）は pay.view の無い人には伏せて返す（maskPrimeBundleForViewer）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getApiAuthUser, requireCap, callerCan } from '@/lib/auth'
import { getMainData, getMultiMonthAttData, type MainData } from '@/lib/compute'
import { safeFileName } from '@/lib/staff-docs'
import { hasRole, resolveSiteParties, type CompanyLike } from '@/lib/companies'
import { isWorkTypeSite, parentAndWorkTypeSiteIds } from '@/lib/site-hierarchy'
import { signedReadUrl, deleteFile, deleteFilesWithPrefix, downloadFile, uploadBuffer, getStaffDocsBucket } from '@/lib/storage-admin'
import { extractPdfLines } from '@/lib/pdf-text.server'
import {
  PRIME_INVOICE_ALLOWED_TYPES, PRIME_INVOICE_MAX_FILE_BYTES, PRIME_INVOICE_MAX_FILES, PRIME_INVOICE_DOC_ID_RE,
  looksLikeGcStatement, looksLikeMemo, parseGcStatement, parseMemo, assembleSheets, aggregatePrimeManDays, comparePrimeManDays,
  maskPrimeBundleForViewer, sanitizeSheetEdit, recomputeSheet, primePeriodOf,
  type PrimeInvoiceFile, type PrimeInvoiceBundle, type PrimeSheet, type GcStatement, type MemoParsed,
} from '@/lib/prime-invoice'
import {
  listPrimeBundlesForYm, listPrimeBundlesSummary, getPrimeBundle, createPrimeDraft, updatePrimeDraft,
  requestPrimeInvoice, issuePrimeInvoice, rejectPrimeInvoice, voidPrimeInvoice, deletePrimeDraft, primeApprovalGap,
} from '@/lib/prime-invoice-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STORAGE_PREFIX = 'prime-invoices'

const badDocId = () => NextResponse.json({ error: 'id が不正です' }, { status: 400 })
const isDocId = (v: unknown): v is string => typeof v === 'string' && PRIME_INVOICE_DOC_ID_RE.test(v)
const storageUnavailable = () => NextResponse.json({ error: 'ファイルの置き場に接続できません（サーバー設定を確認してください）' }, { status: 503 })

async function actorOf(request: NextRequest): Promise<{ actor: string; name: string }> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return { actor: 'unknown', name: '' }
  return { actor: String(a.actor), name: a.actor === 'super-admin' ? '代表' : '' }
}

/** 請求先として選べる一次の会社（取引先マスタ roles に prime） */
function primeCompanies(main: MainData): { id: string; name: string }[] {
  return (main.subcons || []).filter(c => hasRole(c as unknown as CompanyLike, 'prime')).map(c => ({ id: c.id, name: c.name }))
}

/** その一次の会社に請求する自社現場（工種サイトでない親現場） */
function primeSitesOf(main: MainData, companyId: string): { id: string; name: string }[] {
  const companies = (main.subcons || []) as unknown as CompanyLike[]
  const tops = (main.sites || []).filter(s => !isWorkTypeSite(s as { parentId?: string }) && !s.archived)
  return tops.filter(s => resolveSiteParties(s as never, companies).billToId === companyId && resolveSiteParties(s as never, companies).siteType === 'direct')
    .map(s => ({ id: s.id, name: s.name }))
}

async function maybeMask(request: NextRequest, b: PrimeInvoiceBundle): Promise<PrimeInvoiceBundle & { wageMasked?: boolean }> {
  return (await callerCan(request, 'pay.view')) ? b : maskPrimeBundleForViewer(b)
}

/** 下書き・申請中の確認: 出面との検算と承認の有無（発行済みは凍結内容を見るだけ） */
async function buildCheck(main: MainData, b: PrimeInvoiceBundle) {
  const p = primePeriodOf(b.ym)
  const att = await getMultiMonthAttData([p.fromYm, p.toYm])
  const familyIds = parentAndWorkTypeSiteIds((main.sites || []) as never[], b.siteId)
  const manDays = aggregatePrimeManDays(main, att.d, att.sd, familyIds, b.ym)
  const memoSheetIndex = b.sheets.findIndex(s => s.memo)
  const memo = memoSheetIndex >= 0 ? b.sheets[memoSheetIndex].memo : null
  const rows = comparePrimeManDays(memo, manDays)
  const approval = await primeApprovalGap(main, b.siteId, manDays.activeDays)
  return { manDays, rows, memoSheetIndex, approval }
}

/** ファイルを読み取り、枚を組み立てる（commit・removeFile で共通） */
async function parseFiles(files: PrimeInvoiceFile[], ctx: { companyName: string; siteName: string }): Promise<{ sheets: PrimeSheet[]; files: PrimeInvoiceFile[]; warnings: string[] }> {
  const statements: { st: GcStatement; file: string }[] = []
  const memos: { memo: MemoParsed; file: string }[] = []
  const out: PrimeInvoiceFile[] = []
  const warnings: string[] = []
  for (const f of files) {
    let lines: string[][] = []
    try {
      lines = await extractPdfLines(await downloadFile(f.path))
    } catch (e) {
      console.error('[prime-invoice] pdf read failed', f.path, e)
      // 理由を画面にも出す（環境の問題＝ライブラリが見つからない等と、ファイルの問題を見分けるため）
      const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160)
      out.push({ ...f, kind: 'other', parseError: `PDF を読めませんでした（${why || '壊れているか、画像だけのスキャンです'}）` })
      continue
    }
    if (lines.length === 0) { out.push({ ...f, kind: 'other', parseError: '文字が入っていない PDF です（スキャン画像）。数字は手で入れてください' }); continue }
    if (looksLikeGcStatement(lines)) {
      const r = parseGcStatement(lines)
      if (!r.ok) { out.push({ ...f, kind: 'statement', parseError: r.error }); continue }
      const st = r.statement
      const core = ctx.companyName.replace(/株式会社|有限会社|\s/g, '')
      if (core && st.contractorName && !st.contractorName.replace(/\s/g, '').includes(core)) warnings.push(`${f.name}: 控えの受注者「${st.contractorName}」が請求先の会社（${ctx.companyName}）と違います`)
      statements.push({ st, file: f.path })
      out.push({ ...f, kind: 'statement', parseError: null })
      continue
    }
    if (looksLikeMemo(lines)) {
      const r = parseMemo(lines)
      if (!r.ok) { out.push({ ...f, kind: 'memo', parseError: r.error }); continue }
      memos.push({ memo: r.memo, file: f.path })
      out.push({ ...f, kind: 'memo', parseError: null })
      continue
    }
    out.push({ ...f, kind: 'other', parseError: '大林組の控えでも山岡の控除計算書でもない PDF です（添付として残します）' })
  }
  const a = assembleSheets(statements, memos)
  return { sheets: a.sheets, files: out, warnings: [...warnings, ...a.warnings] }
}

function parseTarget(body: Record<string, unknown>, main: MainData): { ok: true; companyId: string; companyName: string; siteId: string; siteName: string; ym: string } | { ok: false; error: string } {
  const co = primeCompanies(main).find(c => c.id === body.companyId)
  if (!co) return { ok: false, error: '請求先の一次の会社を選んでください' }
  const site = primeSitesOf(main, co.id).find(s => s.id === body.siteId)
  if (!site) return { ok: false, error: 'どの現場の請求書かを選んでください' }
  if (typeof body.ym !== 'string' || !/^\d{4}(0[1-9]|1[0-2])$/.test(body.ym)) return { ok: false, error: '対象月が不正です' }
  return { ok: true, companyId: co.id, companyName: co.name, siteId: site.id, siteName: site.name, ym: body.ym }
}

export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'invoice.view')
  if (denied) return denied
  const sp = request.nextUrl.searchParams
  try {
    const open = sp.get('open')
    if (open) {
      if (!isDocId(open)) return badDocId()
      const i = Number(sp.get('i') || 0)
      const b = await getPrimeBundle(open)
      if (!b) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
      const f = b.files?.[i]
      if (!f) return NextResponse.json({ error: 'ファイルが見つかりません' }, { status: 404 })
      if (f.kind === 'memo' && !(await callerCan(request, 'pay.view'))) return NextResponse.json({ error: '控除計算書には個人の給与が書かれているため、給与を見られる人だけが開けます' }, { status: 403 })
      if (!getStaffDocsBucket()) return storageUnavailable()
      return NextResponse.json({ url: await signedReadUrl(f.path, f.name) })
    }

    const id = sp.get('id')
    if (id) {
      if (!isDocId(id)) return badDocId()
      const b = await getPrimeBundle(id)
      if (!b) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
      const main = await getMainData()
      const check = (b.status === 'draft' || b.status === 'pending') ? await buildCheck(main, b) : null
      return NextResponse.json({ record: await maybeMask(request, b), check, storageReady: !!getStaffDocsBucket() })
    }

    const ym = sp.get('ym') || ''
    if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym が必要です' }, { status: 400 })
    const [main, records, summary] = await Promise.all([getMainData(), listPrimeBundlesForYm(ym), listPrimeBundlesSummary()])
    const companies = primeCompanies(main)
    const sites = Object.fromEntries(companies.map(c => [c.id, primeSitesOf(main, c.id)]))
    const masked = await Promise.all(records.map(r => maybeMask(request, r)))
    const months: Record<string, number> = {}
    for (const s of summary) months[s.ym] = (months[s.ym] || 0) + 1
    return NextResponse.json({ ym, records: masked, companies, sites, months, storageReady: !!getStaffDocsBucket() })
  } catch (e) {
    console.error('[prime-invoice] GET error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

const REQUEST_ACTIONS = new Set(['upload', 'update', 'removeFile', 'request', 'withdraw', 'delete'])
const APPROVE_ACTIONS = new Set(['approve', 'issue', 'reject', 'void'])

/** multipart（upload）か JSON か */
async function readBody(request: NextRequest): Promise<{ body: Record<string, unknown>; files: File[] } | null> {
  const ct = request.headers.get('content-type') || ''
  if (ct.includes('multipart/form-data')) {
    try {
      const fd = await request.formData()
      const body: Record<string, unknown> = {}
      const files: File[] = []
      fd.forEach((v, k) => {
        if (typeof v === 'string') body[k] = v
        else if (k === 'files') files.push(v)
      })
      return { body, files }
    } catch { return null }
  }
  try { return { body: await request.json(), files: [] } } catch { return null }
}

export async function POST(request: NextRequest) {
  const read = await readBody(request)
  if (!read) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { body, files: formFiles } = read
  const action = String(body.action || '')
  if (!REQUEST_ACTIONS.has(action) && !APPROVE_ACTIONS.has(action)) return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  const denied = await requireCap(request, APPROVE_ACTIONS.has(action) ? 'invoice.approve' : 'invoice.request')
  if (denied) return denied
  const { actor, name: actorName } = await actorOf(request)

  try {
    const main = await getMainData()

    if (action === 'upload') {
      const t = parseTarget(body, main)
      if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 })
      if (formFiles.length === 0) return NextResponse.json({ error: 'ファイルを選んでください' }, { status: 400 })
      if (!getStaffDocsBucket()) return storageUnavailable()
      let cur: PrimeInvoiceBundle | null = null
      let docId: string
      if (typeof body.docId === 'string' && body.docId) {
        if (!isDocId(body.docId)) return badDocId()
        cur = await getPrimeBundle(body.docId)
        if (!cur) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
        if (cur.status !== 'draft') return NextResponse.json({ error: '下書きのときだけファイルを足せます' }, { status: 400 })
        if (cur.companyId !== t.companyId || cur.siteId !== t.siteId || cur.ym !== t.ym) return NextResponse.json({ error: '会社・現場・月が下書きと違います' }, { status: 400 })
        docId = cur.id
      } else {
        docId = randomUUID()
      }
      if ((cur?.files.length || 0) + formFiles.length > PRIME_INVOICE_MAX_FILES) return NextResponse.json({ error: `ファイルは1か月につき${PRIME_INVOICE_MAX_FILES}個までです` }, { status: 400 })
      for (const f of formFiles) {
        const type = f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '')
        if (!PRIME_INVOICE_ALLOWED_TYPES.includes(type)) return NextResponse.json({ error: `PDF だけ入れられます: ${f.name}` }, { status: 400 })
        if (!(f.size > 0) || f.size > PRIME_INVOICE_MAX_FILE_BYTES) return NextResponse.json({ error: `ファイルが大きすぎます: ${f.name}（4MBまで）` }, { status: 400 })
      }
      const prefix = `${STORAGE_PREFIX}/${docId}/`
      const stamp = Date.now().toString(36)
      const added: PrimeInvoiceFile[] = []
      try {
        for (let i = 0; i < formFiles.length; i++) {
          const f = formFiles[i]
          const name = safeFileName(f.name)
          const path = `${prefix}${stamp}-${i}-${name}`
          const buf = Buffer.from(await f.arrayBuffer())
          // 中身が PDF か（拡張子だけ偽っても読まない）
          if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return NextResponse.json({ error: `PDF ではありません: ${f.name}` }, { status: 400 })
          await uploadBuffer(path, buf, 'application/pdf')
          added.push({ path, name, contentType: 'application/pdf', size: buf.length, kind: 'other' })
        }
      } catch (e) {
        console.error('[prime-invoice] upload failed', docId, e)
        if (!cur) await deleteFilesWithPrefix(prefix).catch(() => undefined)
        else await Promise.all(added.map(a => deleteFile(a.path).catch(() => undefined)))
        return NextResponse.json({ error: 'ファイルを置けませんでした（置き場に接続できません）' }, { status: 503 })
      }
      const all = [...(cur?.files || []), ...added]
      const parsed = await parseFiles(all, { companyName: t.companyName, siteName: t.siteName })
      if (cur) {
        const r = await updatePrimeDraft({ id: docId, actor, patch: { sheets: parsed.sheets, files: parsed.files, warnings: parsed.warnings } })
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
        return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
      }
      const r = await createPrimeDraft({ main, docId, ...t, sheets: parsed.sheets, files: parsed.files, warnings: parsed.warnings, actor, actorName: actorName || main.workers.find(w => String(w.id) === actor)?.name || '' })
      if (!r.ok) {
        await deleteFilesWithPrefix(prefix).catch(e => console.error('[prime-invoice] upload cleanup failed', docId, e))
        return NextResponse.json({ error: r.error }, { status: 400 })
      }
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    // ここから下は id が要る
    if (!isDocId(body.id)) return badDocId()
    const id = body.id

    if (action === 'update') {
      const cur = await getPrimeBundle(id)
      if (!cur) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
      if (cur.status !== 'draft') return NextResponse.json({ error: '下書きのときだけ直せます' }, { status: 400 })
      const patch: { sheets?: PrimeSheet[]; invoiceDate?: string } = {}
      if (body.invoiceDate !== undefined) {
        if (typeof body.invoiceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.invoiceDate)) return NextResponse.json({ error: '請求年月日の形式が不正です' }, { status: 400 })
        patch.invoiceDate = body.invoiceDate
      }
      if (body.sheets !== undefined) {
        if (!Array.isArray(body.sheets)) return NextResponse.json({ error: '枚の形が不正です' }, { status: 400 })
        // 給与の控除を直せるのは給与を見られる人だけ（伏せ字のまま 0 で上書きさせない）
        const canPay = await callerCan(request, 'pay.view')
        const next: PrimeSheet[] = []
        for (let i = 0; i < body.sheets.length; i++) {
          const e = sanitizeSheetEdit(body.sheets[i])
          if (!e.ok) return NextResponse.json({ error: `${i + 1}枚目: ${e.error}` }, { status: 400 })
          const base: PrimeSheet = cur.sheets[i] || {
            tradeCode: '', tradeName: '', docNo: '', billDate: '', surveyDate: '', projectName: '', gcAmount: 0, gcTax: 0, gcTotal: 0,
            borrowed: [], wageDeductions: [], base: 0, ratioAmount: 0, amount: 0, tax: 0, total: 0, memoPayable: null, memo: null,
            source: 'manual', warnings: [], statementFile: null, memoFile: null,
          }
          const wage = canPay ? e.sheet.wageDeductions : base.wageDeductions
          const changed = base.gcAmount !== e.sheet.gcAmount || JSON.stringify(base.borrowed) !== JSON.stringify(e.sheet.borrowed) || JSON.stringify(base.wageDeductions) !== JSON.stringify(wage)
          next.push(recomputeSheet({ ...base, ...e.sheet, wageDeductions: wage, source: changed || base.source === 'manual' ? 'manual' : base.source }))
        }
        patch.sheets = next
      }
      const r = await updatePrimeDraft({ id, actor, patch })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    if (action === 'removeFile') {
      const cur = await getPrimeBundle(id)
      if (!cur) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
      if (cur.status !== 'draft') return NextResponse.json({ error: '下書きのときだけファイルを外せます' }, { status: 400 })
      const path = String(body.path || '')
      const f = cur.files.find(x => x.path === path)
      if (!f) return NextResponse.json({ error: 'ファイルが見つかりません' }, { status: 404 })
      if (f.kind === 'memo' && !(await callerCan(request, 'pay.view'))) return NextResponse.json({ error: '控除計算書を外せるのは給与を見られる人だけです' }, { status: 403 })
      if (!getStaffDocsBucket()) return storageUnavailable()
      const rest = cur.files.filter(x => x.path !== path)
      const parsed = rest.length > 0 ? await parseFiles(rest, { companyName: cur.companyName, siteName: cur.siteName }) : { sheets: [], files: [], warnings: [] }
      const r = await updatePrimeDraft({ id, actor, patch: { sheets: parsed.sheets, files: parsed.files, warnings: parsed.warnings } })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      await deleteFile(path).catch(e => console.error('[prime-invoice] file delete failed', path, e))
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    if (action === 'request' || action === 'issue' || action === 'approve') {
      const cur = await getPrimeBundle(id)
      if (!cur) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
      const check = await buildCheck(main, cur)
      const approvalMessage = check.approval.required && (check.approval.foremanMissing || check.approval.finalMissing) ? check.approval.message : null
      const r = action === 'request'
        ? await requestPrimeInvoice({ main, id, actor, approvalMessage })
        : await issuePrimeInvoice({ main, id, actor, approvalMessage })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    if (action === 'reject' || action === 'withdraw') {
      const r = await rejectPrimeInvoice({ id, actor, reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : undefined, withdraw: action === 'withdraw' })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    if (action === 'void') {
      const r = await voidPrimeInvoice({ id, actor, reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : undefined })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      return NextResponse.json({ ok: true, record: await maybeMask(request, r.record) })
    }

    if (action === 'delete') {
      const r = await deletePrimeDraft({ id, actor })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      // 記録を先に消し、ファイルはそのあと消せるだけ消す
      if (getStaffDocsBucket()) await deleteFilesWithPrefix(`${STORAGE_PREFIX}/${id}/`).catch(e => console.error('[prime-invoice] delete files failed', id, e))
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    console.error('[prime-invoice] POST error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
