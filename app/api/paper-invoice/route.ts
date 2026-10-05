/**
 * 紙（手作り）で出した請求書の保管・システムとの見比べ API（2026-10-02）。仕組みは lib/paper-invoice.ts の冒頭を参照。
 *
 * GET  /api/paper-invoice?ym=YYYYMM            → その月の記録 ＋ 会社ごとのシステムの数字（見比べ用）＋ 選べる会社
 * GET  /api/paper-invoice?ym=YYYYMM&lite=1     → その月の記録だけ（請求書・支払の画面の「紙で発行済み」表示用・集計しない）
 * GET  /api/paper-invoice?all=1                → 全部の月の記録（一覧用・見比べなし）
 * GET  /api/paper-invoice?open=ID&i=0          → そのファイルを見るための署名つきURL（15分）
 * POST { action: 'prepare', files:[{name,contentType,size}], ...（commit と同じ項目）} → 項目を確かめてから、置き場のパスと署名つきURL
 *      （まだ記録は作らない。項目が不正なら何もアップロードさせない）
 * POST { action: 'commit', docId, files, companyId, ym, total, subtotal?, tax?, no?, issueDate?, lines?, note? }
 * POST { action: 'update', docId, ...（commit と同じ項目。files 以外）}
 * POST { action: 'discard', docId }              → 登録できなかったアップロードの後片付け（記録が無い docId のファイルだけ消す）
 * POST { action: 'delete', docId }               → ファイルごと削除（invoice.approve）。記録を先に消し、ファイルはそのあと
 *
 * 権限: 見る = invoice.view ／ 登録・修正 = invoice.paper ／ 削除 = invoice.approve（lib/permissions.ts）
 *
 * 一次（山岡建設工業など）へ出した請求書（2026-10-05）: 現場（siteId）必須・工種（trade）任意。見比べは現場ごとの合計 vs 現場の請求額（primeComparisons）。
 * lite=1（請求・支払の一覧の「紙で発行済み」）には一次の分を入れない（応援の請求書の話なので）
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where } from '@/lib/fsdb'
import { getMainData, getMultiMonthAttData, compute, getBillTotal, type MainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { safeFileName, isValidIsoDate } from '@/lib/staff-docs'
import { hasRole, resolveSiteParties, type CompanyLike } from '@/lib/companies'
import { isWorkTypeSite, parentAndWorkTypeSiteIds } from '@/lib/site-hierarchy'
import { HFU_INVOICE_COMPANY_ID } from '@/lib/constants'
import { resolveInvoiceDraft, listPeerInvoicesForYm } from '@/lib/peer-invoice-store'
import {
  PAPER_INVOICE_ALLOWED_TYPES, PAPER_INVOICE_MAX_FILE_BYTES, PAPER_INVOICE_MAX_FILES, PAPER_INVOICE_DOC_ID_RE,
  sanitizePaperLines, comparePaperWithSystem, parsePaperNumber, isBlankNumberInput,
  paperTotalsError, systemDoubleBillingError, mergePaperInvoices, comparePrimeSheets,
  type PrimeSiteComparison, type PaperInvoice, type PaperInvoiceFile, type SystemInvoiceFigures, type PaperComparison,
} from '@/lib/paper-invoice'
import { signedUploadUrl, signedReadUrl, fileMeta, deleteFile, deleteFilesWithPrefix, getStaffDocsBucket } from '@/lib/storage-admin'

export const dynamic = 'force-dynamic'

const COL = 'paperInvoices'
const HFU_LABEL = 'HFU → 日比建設'

/** 入れた人の名前（経営コックピットに出す） */
function byName(by: string, main: MainData): string {
  if (by === 'super-admin') return '代表'
  const id = by.startsWith('worker:') ? by.slice(7) : ''
  return (main.workers || []).find(w => String(w.id) === id)?.name || ''
}

async function actorLabel(request: NextRequest): Promise<string> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return 'unknown'
  return a.actor === 'super-admin' ? 'super-admin' : `worker:${a.actor}`
}

function storageUnavailable() {
  return NextResponse.json({ error: 'ファイルの置き場に接続できません（サーバー設定を確認してください）' }, { status: 503 })
}

/** Firestore に undefined を書かない */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** 請求先として選べる会社: 取引先マスタの「同業（二次）」＋ HFU → 日比建設 ＋ 一次（山岡建設工業など・kind: 'prime'） */
function selectableCompanies(main: MainData): { id: string; name: string; kind: 'peer' | 'prime' }[] {
  const role = (c: unknown, r: 'peer' | 'prime') => hasRole(c as { id: string; name: string; roles?: string[] }, r)
  const peers = (main.subcons || []).filter(c => role(c, 'peer')).map(c => ({ id: c.id, name: c.name, kind: 'peer' as const }))
  const primes = (main.subcons || []).filter(c => role(c, 'prime') && !role(c, 'peer')).map(c => ({ id: c.id, name: c.name, kind: 'prime' as const }))
  return [...peers, { id: HFU_INVOICE_COMPANY_ID, name: HFU_LABEL, kind: 'peer' as const }, ...primes]
}
const isPrimeCompany = (main: MainData, companyId: string) => selectableCompanies(main).some(c => c.id === companyId && c.kind === 'prime')

/** 一次への請求書で選べる現場: 工種サイトでない現場のうち、請求先がその会社のもの（無ければ直の現場ぜんぶ） */
function primeSitesOf(main: MainData, companyId: string): { id: string; name: string }[] {
  const companies = (main.subcons || []) as unknown as CompanyLike[]
  const tops = (main.sites || []).filter(s => !isWorkTypeSite(s as { parentId?: string }))
  const mine = tops.filter(s => resolveSiteParties(s as never, companies).billToId === companyId)
  const list = mine.length > 0 ? mine : tops.filter(s => resolveSiteParties(s as never, companies).siteType === 'direct')
  return list.map(s => ({ id: s.id, name: s.name }))
}

/** 現場の請求額（税抜）。工種サイトに入れた分も足す */
function siteBilling(main: MainData, siteId: string, ym: string): number {
  return parentAndWorkTypeSiteIds((main.sites || []) as never[], siteId).reduce((t, id) => t + getBillTotal(main, id, ym), 0)
}

function snapToList(snap: { forEach: (cb: (d: { id: string; data: () => Record<string, unknown> }) => void) => void }): PaperInvoice[] {
  const out: PaperInvoice[] = []
  snap.forEach(d => out.push({ ...(d.data() as unknown as PaperInvoice), id: d.id }))
  return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.companyName.localeCompare(b.companyName, 'ja') || (a.uploadedAt || '').localeCompare(b.uploadedAt || ''))
}

/** 任意の金額欄。空欄は undefined、読めなければ 'invalid'（全角数字・カンマ・円も読む＝lib/paper-invoice.ts parsePaperNumber） */
const optNum = (v: unknown): number | undefined | 'invalid' => {
  if (isBlankNumberInput(v)) return undefined
  const n = parsePaperNumber(v)
  return Number.isFinite(n) ? Math.round(n) : 'invalid'
}
const badDocId = () => NextResponse.json({ error: 'docId が不正です' }, { status: 400 })
const isDocId = (v: unknown): v is string => typeof v === 'string' && PAPER_INVOICE_DOC_ID_RE.test(v)
const optText = (v: unknown, max: number) => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

/** commit / update の共通の項目チェック */
function parseFields(body: Record<string, unknown>, main: MainData, partial: boolean):
  { ok: true; fields: Partial<PaperInvoice> } | { ok: false; error: string } {
  const f: Partial<PaperInvoice> = {}
  if (!partial || body.companyId !== undefined) {
    const co = selectableCompanies(main).find(c => c.id === body.companyId)
    if (!co) return { ok: false, error: '請求先の会社を選んでください' }
    f.companyId = co.id
    f.companyName = co.name
  }
  if (!partial || body.ym !== undefined) {
    if (typeof body.ym !== 'string' || !/^\d{4}(0[1-9]|1[0-2])$/.test(body.ym)) return { ok: false, error: '対象月が不正です' }
    f.ym = body.ym
  }
  // 一次への請求書は現場が必須（工種は任意）。会社を変えないときは今の会社で見る（update）
  const companyId = (f.companyId ?? (typeof body.currentCompanyId === 'string' ? body.currentCompanyId : '')) as string
  if (companyId && isPrimeCompany(main, companyId)) {
    if (!partial || body.siteId !== undefined || f.companyId !== undefined) {
      const site = primeSitesOf(main, companyId).find(x => x.id === body.siteId)
      if (!site) return { ok: false, error: 'どの現場の請求書かを選んでください' }
      f.siteId = site.id
      f.siteName = site.name
    }
    if (body.trade !== undefined) f.trade = optText(body.trade, 40)
  } else if (f.companyId !== undefined) {
    f.siteId = undefined; f.siteName = undefined; f.trade = undefined
  }
  if (!partial || body.total !== undefined) {
    const t = optNum(body.total)
    if (t === undefined || t === 'invalid' || t <= 0) return { ok: false, error: '税込合計を入れてください' }
    f.total = t
  }
  for (const k of ['subtotal', 'tax'] as const) {
    if (body[k] === undefined) continue
    const n = optNum(body[k])
    if (n === 'invalid') return { ok: false, error: `${k === 'subtotal' ? '税抜小計' : '消費税'}の数字が読めません` }
    f[k] = n
  }
  if (body.issueDate !== undefined && body.issueDate !== '') {
    if (!isValidIsoDate(body.issueDate)) return { ok: false, error: '発行日の形式が不正です' }
    f.issueDate = body.issueDate as string
  }
  if (body.no !== undefined) f.no = optText(body.no, 40)
  if (body.note !== undefined) f.note = optText(body.note, 1000)
  if (body.lines !== undefined) {
    const r = sanitizePaperLines(body.lines)
    if (!r.ok) return r
    f.lines = r.lines
  }
  return { ok: true, fields: f }
}

/**
 * 保存のまえの確認（commit / update 共通・2026-10-02 総合点検）:
 *   - 税抜小計＋消費税＝税込合計（両方入っているとき）
 *   - システムで発行済み・承認待ちの会社・月ではない（逆方向の二重請求）
 * update は「変えたあとの会社・月・金額」で見る（会社や月を付け替えて確認をすり抜けない）
 */
async function preSaveError(next: Pick<PaperInvoice, 'companyId' | 'ym' | 'total' | 'subtotal' | 'tax'>): Promise<string | null> {
  const t = paperTotalsError(next)
  if (t) return t
  return systemDoubleBillingError(await listPeerInvoicesForYm(next.ym), next.ym, next.companyId)
}

/** その月の会社ごとのシステムの数字（発行済み・承認待ちは凍結内容、なければ下書き） */
async function systemFiguresFor(main: MainData, ym: string, companyIds: string[]): Promise<Record<string, SystemInvoiceFigures>> {
  const out: Record<string, SystemInvoiceFigures> = {}
  if (companyIds.length === 0) return out
  const records = await listPeerInvoicesForYm(ym)
  const needDraft = companyIds.filter(id => !records.some(r => r.companyId === id && (r.status === 'issued' || r.status === 'pending')))
  let draftArgs: Omit<Parameters<typeof resolveInvoiceDraft>[0], 'companyId'> | null = null
  if (needDraft.length > 0) {
    const att = await getMultiMonthAttData([ym])
    const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
    const c = compute(main, att.d, att.sd, [{ y, m }])
    draftArgs = { main, c, attD: att.d, attSD: att.sd, ym }
  }
  for (const id of companyIds) {
    const frozen = records.find(r => r.companyId === id && r.status === 'issued') || records.find(r => r.companyId === id && r.status === 'pending')
    if (frozen) {
      out[id] = { source: frozen.status === 'issued' ? 'issued' : 'pending', no: frozen.no, subtotal: frozen.subtotal, tax: frozen.tax, total: frozen.total, lines: frozen.lines }
      continue
    }
    const { draft } = resolveInvoiceDraft({ ...draftArgs!, companyId: id })
    out[id] = draft
      ? { source: 'draft', subtotal: draft.subtotal, tax: draft.tax, total: draft.total, lines: draft.lines }
      : { source: 'none', subtotal: 0, tax: 0, total: 0, lines: [] }
  }
  return out
}

export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'invoice.view')
  if (denied) return denied
  const sp = request.nextUrl.searchParams

  const open = sp.get('open')
  if (open) {
    if (!isDocId(open)) return badDocId()
    const i = Number(sp.get('i') || 0)
    if (!Number.isInteger(i) || i < 0) return NextResponse.json({ error: 'ファイルの指定が不正です' }, { status: 400 })
    const snap = await getDoc(doc(db, COL, open))
    if (!snap.exists()) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
    const f = (snap.data() as PaperInvoice).files?.[i]
    if (!f) return NextResponse.json({ error: 'ファイルが見つかりません' }, { status: 404 })
    if (!getStaffDocsBucket()) return storageUnavailable()
    return NextResponse.json({ url: await signedReadUrl(f.path, f.name) })
  }

  if (sp.get('all')) {
    const records = snapToList(await getDocs(collection(db, COL)))
    return NextResponse.json({ records })
  }

  const ym = sp.get('ym') || ''
  if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym が必要です' }, { status: 400 })
  const records = snapToList(await getDocs(query(collection(db, COL), where('ym', '==', ym))))
  const main = await getMainData()
  const primeIds = new Set(selectableCompanies(main).filter(c => c.kind === 'prime').map(c => c.id))
  // 請求・支払の一覧の「紙で発行済み」は応援の請求書の話なので、一次への請求書は入れない
  if (sp.get('lite')) return NextResponse.json({ ym, records: records.filter(r => !primeIds.has(r.companyId)) })

  // 一次への請求書: 同じ会社・同じ現場の全部の合計 vs 現場の請求額（工種ごとに5〜6枚になることがある）
  const primeComparisons: Record<string, PrimeSiteComparison> = {}
  for (const r of records.filter(x => primeIds.has(x.companyId) && x.siteId)) {
    const key = `${r.companyId}_${r.siteId}`
    if (primeComparisons[key]) continue
    const sheets = records.filter(x => x.companyId === r.companyId && x.siteId === r.siteId)
    primeComparisons[key] = comparePrimeSheets(sheets, siteBilling(main, r.siteId!, ym), { siteId: r.siteId!, siteName: r.siteName || r.siteId! })
  }
  const primeSites = Object.fromEntries([...primeIds].map(id => [id, primeSitesOf(main, id)]))

  const companyIds = [...new Set(records.filter(r => !primeIds.has(r.companyId)).map(r => r.companyId))]
  const system = await systemFiguresFor(main, ym, companyIds)
  const comparisons = Object.fromEntries(records.filter(r => !primeIds.has(r.companyId)).map(r => [r.id, comparePaperWithSystem(r, system[r.companyId])]))
  // 同じ会社に2枚以上あるときは合算でも見比べる（1枚ずつでは必ず「差あり」になるため・2026-10-02 総合点検）
  const groupComparisons: Record<string, PaperComparison & { count: number }> = {}
  for (const id of companyIds) {
    const xs = records.filter(r => r.companyId === id)
    if (xs.length >= 2) groupComparisons[id] = { ...comparePaperWithSystem(mergePaperInvoices(xs), system[id]), count: xs.length }
  }
  return NextResponse.json({
    ym, records, system, comparisons, groupComparisons, primeComparisons, primeSites,
    companies: selectableCompanies(main),
    storageReady: !!getStaffDocsBucket(),
  })
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  const action = body.action
  const denied = await requireCap(request, action === 'delete' ? 'invoice.approve' : 'invoice.paper')
  if (denied) return denied

  const main = await getMainData()

  // ── アップロード準備（署名つきURLを出すだけ）──
  if (action === 'prepare') {
    // commit と同じ項目チェックを先にする（commit で落ちる内容なら、そもそもアップロードさせない）
    const parsed = parseFields(body, main, false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    {
      const e = await preSaveError(parsed.fields as PaperInvoice)
      if (e) return NextResponse.json({ error: e }, { status: 400 })
    }
    const files = Array.isArray(body.files) ? body.files as { name?: string; contentType?: string; size?: number }[] : []
    if (files.length === 0) return NextResponse.json({ error: 'ファイルを選んでください' }, { status: 400 })
    if (files.length > PAPER_INVOICE_MAX_FILES) return NextResponse.json({ error: `ファイルは1件につき${PAPER_INVOICE_MAX_FILES}個までです` }, { status: 400 })
    for (const f of files) {
      if (!PAPER_INVOICE_ALLOWED_TYPES.includes(String(f.contentType))) {
        return NextResponse.json({ error: `この形式は入れられません: ${f.name}（PDF・写真だけ）` }, { status: 400 })
      }
      if (!(Number(f.size) > 0) || Number(f.size) > PAPER_INVOICE_MAX_FILE_BYTES) {
        return NextResponse.json({ error: `ファイルが大きすぎます: ${f.name}（25MBまで）` }, { status: 400 })
      }
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const docId = randomUUID()
    const uploads = await Promise.all(files.map(async (f, i) => {
      const name = safeFileName(String(f.name))
      const path = `paper-invoices/${docId}/${i}-${name}`
      return { path, name, contentType: String(f.contentType), size: Number(f.size), url: await signedUploadUrl(path, String(f.contentType)) }
    }))
    return NextResponse.json({ docId, uploads })
  }

  const by = await actorLabel(request)
  const now = new Date().toISOString()
  const label = (r: { companyName: string; ym: string }) => `${r.companyName} ${r.ym.slice(0, 4)}年${parseInt(r.ym.slice(4, 6), 10)}月分`

  // ── 登録できなかったアップロードの後片付け（2026-10-02）──
  // commit が失敗したとき画面から呼ぶ。記録（Firestore）がある docId のファイルは絶対に消さない
  if (action === 'discard') {
    if (!isDocId(body.docId)) return badDocId()
    const docId = body.docId
    if ((await getDoc(doc(db, COL, docId))).exists()) {
      return NextResponse.json({ error: 'この請求書は登録済みのため、後片付けの対象ではありません' }, { status: 409 })
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const n = await deleteFilesWithPrefix(`paper-invoices/${docId}/`)
    return NextResponse.json({ ok: true, deleted: n })
  }

  // ── 記録を作る（アップロード済みを確認してから）──
  if (action === 'commit') {
    if (!isDocId(body.docId)) return badDocId()
    const docId = body.docId
    const parsed = parseFields(body, main, false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const prefix = `paper-invoices/${docId}/`
    const reqFiles = Array.isArray(body.files) ? body.files as PaperInvoiceFile[] : []
    if (reqFiles.length === 0 || reqFiles.some(f => typeof f.path !== 'string' || !f.path.startsWith(prefix))) {
      return NextResponse.json({ error: 'ファイルの指定が不正です' }, { status: 400 })
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    if (reqFiles.length > PAPER_INVOICE_MAX_FILES) return NextResponse.json({ error: `ファイルは1件につき${PAPER_INVOICE_MAX_FILES}個までです` }, { status: 400 })
    const ref = doc(db, COL, docId)
    if ((await getDoc(ref)).exists()) return NextResponse.json({ error: 'この請求書は既に登録されています' }, { status: 409 })
    {
      // prepare のあとでシステムの請求書が発行されていても止める（2026-10-02 総合点検）
      const e = await preSaveError(parsed.fields as PaperInvoice)
      if (e) return NextResponse.json({ error: e }, { status: 400 })
    }
    const files: PaperInvoiceFile[] = []
    for (const f of reqFiles) {
      const m = await fileMeta(f.path)
      if (!m.exists) return NextResponse.json({ error: `アップロードが完了していません: ${f.name}` }, { status: 409 })
      files.push({ path: f.path, name: safeFileName(String(f.name)), contentType: m.contentType || f.contentType, size: m.size })
    }
    // 実際に置かれたファイルで大きさ・形式を確かめる（prepare の申告を信用しない）。だめならこの記録のファイルを全部消す
    const bad = files.find(f => f.size > PAPER_INVOICE_MAX_FILE_BYTES || !PAPER_INVOICE_ALLOWED_TYPES.includes(f.contentType))
    if (bad) {
      await deleteFilesWithPrefix(prefix).catch(e => console.error('[paper-invoice] commit cleanup failed', docId, e))
      const why = bad.size > PAPER_INVOICE_MAX_FILE_BYTES ? '25MBを超えています' : '入れられない形式です（PDF・写真だけ）'
      return NextResponse.json({ error: `${bad.name} は${why}。アップロードしたファイルは消しました` }, { status: 400 })
    }
    const record = compact({ ...parsed.fields, files, uploadedAt: now, uploadedBy: by, uploadedByName: byName(by, main) || undefined }) as Omit<PaperInvoice, 'id'>
    await setDoc(ref, record)
    await logActivity(by, 'paperInvoice.add', `紙の請求書を登録：${label(record)}（税込 ${record.total.toLocaleString()}円・${files.length}ファイル）`)
    return NextResponse.json({ ok: true, record: { ...record, id: docId } })
  }

  if (action !== 'update' && action !== 'delete') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  if (!isDocId(body.docId)) return badDocId()
  const docId = body.docId
  const ref = doc(db, COL, docId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
  const cur = { ...(snap.data() as PaperInvoice), id: docId }

  if (action === 'update') {
    const parsed = parseFields({ ...body, currentCompanyId: cur.companyId }, main, true)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    // 空にした任意項目は消す（'' で上書き）。undefined は Firestore に書かない
    const patch: Record<string, unknown> = { updatedAt: now }
    // undefined は Firestore に書けないので null（一次から応援の会社へ付け替えたときの現場・工種など）
    for (const [k, v] of Object.entries(parsed.fields)) patch[k] = v === undefined ? null : v
    for (const k of ['no', 'note', 'issueDate', 'subtotal', 'tax', 'trade'] as const) {
      if (body[k] !== undefined && parsed.fields[k] === undefined) patch[k] = null
    }
    {
      // 変えたあとの姿で確認する（会社・月を付け替えて、発行済みの月へ移すのも止める・2026-10-02 総合点検）
      const next = { ...cur, ...patch } as PaperInvoice
      const changesTarget = next.companyId !== cur.companyId || next.ym !== cur.ym
      const t = paperTotalsError(next)
      const e = t || (changesTarget ? systemDoubleBillingError(await listPeerInvoicesForYm(next.ym), next.ym, next.companyId) : null)
      if (e) return NextResponse.json({ error: e }, { status: 400 })
    }
    await updateDoc(ref, patch)
    await logActivity(by, 'paperInvoice.update', `紙の請求書を修正：${label({ ...cur, ...parsed.fields })}`)
    return NextResponse.json({ ok: true })
  }

  if (action === 'delete') {
    if (!getStaffDocsBucket()) return storageUnavailable()
    // 記録を先に消す（途中で失敗しても「記録はあるのにファイルが無い」状態を作らない）。ファイルはそのあと消せるだけ消す
    await deleteDoc(ref)
    const failed: string[] = []
    for (const f of cur.files || []) {
      try { await deleteFile(f.path) } catch (e) { failed.push(f.path); console.error('[paper-invoice] file delete failed', f.path, e) }
    }
    await logActivity(by, 'paperInvoice.delete', `紙の請求書を削除：${label(cur)}${failed.length ? `（ファイル${failed.length}個は消せず残っています）` : ''}`)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
