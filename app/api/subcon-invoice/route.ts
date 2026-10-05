/**
 * 受け取った外注の請求書の保管・出面 × 単価との見比べ API（2026-10-05）。仕組みは lib/subcon-invoice.ts の冒頭を参照。
 *
 * GET  /api/subcon-invoice?ym=YYYYMM            → その月の記録 ＋ 外注先ごとの出面 × 単価（見比べ用）＋ まだ届いていない外注先 ＋ 選べる会社
 * GET  /api/subcon-invoice?all=1                → 全部の月の記録（月の一覧用・見比べなし）
 * GET  /api/subcon-invoice?open=ID&i=0          → そのファイルを見るための署名つきURL（15分）
 * POST { action: 'prepare', files:[{name,contentType,size}], ...（commit と同じ項目）} → 項目を確かめてから、置き場のパスと署名つきURL
 * POST { action: 'commit', docId, files, companyId, ym, total, subtotal?, tax?, no?, issueDate?, dueDate?, note? }
 * POST { action: 'update', docId, ...（commit と同じ項目。files 以外）}
 * POST { action: 'discard', docId }              → 登録できなかったアップロードの後片付け（記録が無い docId のファイルだけ消す）
 * POST { action: 'delete', docId }               → ファイルごと削除（invoice.approve）。記録を先に消し、ファイルはそのあと
 *
 * 権限: 見る = invoice.view ／ 登録・修正 = invoice.subcon ／ 削除 = invoice.approve（lib/permissions.ts）
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where } from '@/lib/fsdb'
import { getMainData, getAttData, getAttDataCached, isClosedMonthYm, compute, getSubconRate, type MainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { safeFileName, isValidIsoDate } from '@/lib/staff-docs'
import { canBorrowFrom, type CompanyLike } from '@/lib/companies'
import { parsePaperNumber, isBlankNumberInput } from '@/lib/paper-invoice'
import {
  SUBCON_INVOICE_ALLOWED_TYPES, SUBCON_INVOICE_MAX_FILE_BYTES, SUBCON_INVOICE_MAX_FILES, SUBCON_INVOICE_DOC_ID_RE,
  compareSubconInvoice, subconTotalsError, missingSubconInvoices,
  type SubconInvoice, type SubconInvoiceFile, type SubconExpected, type SubconComparison,
} from '@/lib/subcon-invoice'
import { signedUploadUrl, signedReadUrl, fileMeta, deleteFile, deleteFilesWithPrefix, getStaffDocsBucket } from '@/lib/storage-admin'

export const dynamic = 'force-dynamic'

const COL = 'subconInvoices'

async function actorOf(request: NextRequest, main: MainData): Promise<{ by: string; name: string }> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return { by: 'unknown', name: '' }
  if (a.actor === 'super-admin') return { by: 'super-admin', name: '代表' }
  const w = (main.workers || []).find(x => String(x.id) === String(a.actor))
  return { by: `worker:${a.actor}`, name: w?.name || '' }
}

function storageUnavailable() {
  return NextResponse.json({ error: 'ファイルの置き場に接続できません（サーバー設定を確認してください）' }, { status: 503 })
}

/** Firestore に undefined を書かない */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** 請求元として選べる会社: 出面の外注として配置できる会社（同業・外注） */
function selectableCompanies(main: MainData): { id: string; name: string }[] {
  return (main.subcons || []).filter(c => canBorrowFrom(c as unknown as CompanyLike)).map(c => ({ id: c.id, name: c.name }))
}

function snapToList(snap: { forEach: (cb: (d: { id: string; data: () => Record<string, unknown> }) => void) => void }): SubconInvoice[] {
  const out: SubconInvoice[] = []
  snap.forEach(d => out.push({ ...(d.data() as unknown as SubconInvoice), id: d.id }))
  return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.companyName.localeCompare(b.companyName, 'ja') || (a.uploadedAt || '').localeCompare(b.uploadedAt || ''))
}

const optNum = (v: unknown): number | undefined | 'invalid' => {
  if (isBlankNumberInput(v)) return undefined
  const n = parsePaperNumber(v)
  return Number.isFinite(n) ? Math.round(n) : 'invalid'
}
const badDocId = () => NextResponse.json({ error: 'docId が不正です' }, { status: 400 })
const isDocId = (v: unknown): v is string => typeof v === 'string' && SUBCON_INVOICE_DOC_ID_RE.test(v)
const optText = (v: unknown, max: number) => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

/** commit / update の共通の項目チェック */
function parseFields(body: Record<string, unknown>, main: MainData, partial: boolean):
  { ok: true; fields: Partial<SubconInvoice> } | { ok: false; error: string } {
  const f: Partial<SubconInvoice> = {}
  if (!partial || body.companyId !== undefined) {
    const co = selectableCompanies(main).find(c => c.id === body.companyId)
    if (!co) return { ok: false, error: '請求元の外注先を選んでください' }
    f.companyId = co.id
    f.companyName = co.name
  }
  if (!partial || body.ym !== undefined) {
    if (typeof body.ym !== 'string' || !/^\d{4}(0[1-9]|1[0-2])$/.test(body.ym)) return { ok: false, error: '対象月が不正です' }
    f.ym = body.ym
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
  for (const k of ['issueDate', 'dueDate'] as const) {
    if (body[k] === undefined || body[k] === '') continue
    if (!isValidIsoDate(body[k])) return { ok: false, error: `${k === 'issueDate' ? '発行日' : '支払期日'}の形式が不正です` }
    f[k] = body[k] as string
  }
  if (body.no !== undefined) f.no = optText(body.no, 40)
  if (body.note !== undefined) f.note = optText(body.note, 1000)
  return { ok: true, fields: f }
}

/** その月の外注先ごとの出面 × 単価（税抜）。締まった月は5分キャッシュの出面を使う（読み取り回数を増やさない） */
async function expectedFor(main: MainData, ym: string): Promise<Record<string, SubconExpected>> {
  const att = isClosedMonthYm(ym) ? await getAttDataCached(ym) : await getAttData(ym)
  const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
  const c = compute(main, att.d, att.sd, [{ y, m }])
  const r1 = (v: number) => Math.round(v * 10) / 10
  const out: Record<string, SubconExpected> = {}
  for (const sc of main.subcons || []) {
    const cd = c.subcons[sc.id]
    if (!cd || (cd.work <= 0 && cd.cost <= 0)) continue
    const sites: SubconExpected['sites'] = []
    for (const s of main.sites || []) {
      const ss = c.siteSubcons[`${s.id}_${sc.id}`]
      if (!ss || ss.work <= 0) continue
      const r = getSubconRate(main, sc.id, s.id, ym)
      sites.push({ siteId: s.id, siteName: s.name, workDays: r1(ss.work), otCount: r1(ss.ot), cost: Math.round(ss.cost), rate: r.rate, otRate: r.otRate })
    }
    out[sc.id] = { workDays: r1(cd.work), otCount: r1(cd.ot), cost: Math.round(cd.cost), sites }
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
    const f = (snap.data() as SubconInvoice).files?.[i]
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
  const expected = await expectedFor(main, ym)
  // 同じ外注先の請求書は合算で見比べる（現場ごとに2枚来る会社がある）
  const comparisons: Record<string, SubconComparison & { count: number }> = {}
  for (const id of new Set(records.map(r => r.companyId))) {
    const xs = records.filter(r => r.companyId === id)
    comparisons[id] = { ...compareSubconInvoice(xs, expected[id]), count: xs.length }
  }
  const names = Object.fromEntries((main.subcons || []).map(s => [s.id, s.name]))
  return NextResponse.json({
    ym, records, expected, comparisons,
    missing: missingSubconInvoices(expected, records, names),
    companies: selectableCompanies(main),
    storageReady: !!getStaffDocsBucket(),
  })
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  const action = body.action
  const denied = await requireCap(request, action === 'delete' ? 'invoice.approve' : 'invoice.subcon')
  if (denied) return denied

  const main = await getMainData()

  // ── アップロード準備（署名つきURLを出すだけ）──
  if (action === 'prepare') {
    const parsed = parseFields(body, main, false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    { const e = subconTotalsError(parsed.fields as SubconInvoice); if (e) return NextResponse.json({ error: e }, { status: 400 }) }
    const files = Array.isArray(body.files) ? body.files as { name?: string; contentType?: string; size?: number }[] : []
    if (files.length === 0) return NextResponse.json({ error: 'ファイルを選んでください' }, { status: 400 })
    if (files.length > SUBCON_INVOICE_MAX_FILES) return NextResponse.json({ error: `ファイルは1件につき${SUBCON_INVOICE_MAX_FILES}個までです` }, { status: 400 })
    for (const f of files) {
      if (!SUBCON_INVOICE_ALLOWED_TYPES.includes(String(f.contentType))) {
        return NextResponse.json({ error: `この形式は入れられません: ${f.name}（PDF・JPEG・PNG だけ）` }, { status: 400 })
      }
      if (!(Number(f.size) > 0) || Number(f.size) > SUBCON_INVOICE_MAX_FILE_BYTES) {
        return NextResponse.json({ error: `ファイルが大きすぎます: ${f.name}（20MBまで）` }, { status: 400 })
      }
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const docId = randomUUID()
    const uploads = await Promise.all(files.map(async (f, i) => {
      const name = safeFileName(String(f.name))
      const path = `subcon-invoices/${docId}/${i}-${name}`
      return { path, name, contentType: String(f.contentType), size: Number(f.size), url: await signedUploadUrl(path, String(f.contentType)) }
    }))
    return NextResponse.json({ docId, uploads })
  }

  const actor = await actorOf(request, main)
  const now = new Date().toISOString()
  const label = (r: { companyName: string; ym: string }) => `${r.companyName} ${r.ym.slice(0, 4)}年${parseInt(r.ym.slice(4, 6), 10)}月分`

  // ── 登録できなかったアップロードの後片付け（記録がある docId のファイルは絶対に消さない）──
  if (action === 'discard') {
    if (!isDocId(body.docId)) return badDocId()
    const docId = body.docId
    if ((await getDoc(doc(db, COL, docId))).exists()) {
      return NextResponse.json({ error: 'この請求書は登録済みのため、後片付けの対象ではありません' }, { status: 409 })
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const n = await deleteFilesWithPrefix(`subcon-invoices/${docId}/`)
    return NextResponse.json({ ok: true, deleted: n })
  }

  // ── 記録を作る（アップロード済みを確認してから）──
  if (action === 'commit') {
    if (!isDocId(body.docId)) return badDocId()
    const docId = body.docId
    const parsed = parseFields(body, main, false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    { const e = subconTotalsError(parsed.fields as SubconInvoice); if (e) return NextResponse.json({ error: e }, { status: 400 }) }
    const prefix = `subcon-invoices/${docId}/`
    const reqFiles = Array.isArray(body.files) ? body.files as SubconInvoiceFile[] : []
    if (reqFiles.length === 0 || reqFiles.some(f => typeof f.path !== 'string' || !f.path.startsWith(prefix))) {
      return NextResponse.json({ error: 'ファイルの指定が不正です' }, { status: 400 })
    }
    if (reqFiles.length > SUBCON_INVOICE_MAX_FILES) return NextResponse.json({ error: `ファイルは1件につき${SUBCON_INVOICE_MAX_FILES}個までです` }, { status: 400 })
    if (!getStaffDocsBucket()) return storageUnavailable()
    const ref = doc(db, COL, docId)
    if ((await getDoc(ref)).exists()) return NextResponse.json({ error: 'この請求書は既に登録されています' }, { status: 409 })
    const files: SubconInvoiceFile[] = []
    for (const f of reqFiles) {
      const m = await fileMeta(f.path)
      if (!m.exists) return NextResponse.json({ error: `アップロードが完了していません: ${f.name}` }, { status: 409 })
      files.push({ path: f.path, name: safeFileName(String(f.name)), contentType: m.contentType || f.contentType, size: m.size })
    }
    // 実際に置かれたファイルで大きさ・形式を確かめる（prepare の申告を信用しない）。だめならこの記録のファイルを全部消す
    const bad = files.find(f => f.size > SUBCON_INVOICE_MAX_FILE_BYTES || !SUBCON_INVOICE_ALLOWED_TYPES.includes(f.contentType))
    if (bad) {
      await deleteFilesWithPrefix(prefix).catch(e => console.error('[subcon-invoice] commit cleanup failed', docId, e))
      const why = bad.size > SUBCON_INVOICE_MAX_FILE_BYTES ? '20MBを超えています' : '入れられない形式です（PDF・JPEG・PNG だけ）'
      return NextResponse.json({ error: `${bad.name} は${why}。アップロードしたファイルは消しました` }, { status: 400 })
    }
    const record = compact({ ...parsed.fields, files, uploadedAt: now, uploadedBy: actor.by, uploadedByName: actor.name || undefined }) as Omit<SubconInvoice, 'id'>
    await setDoc(ref, record)
    await logActivity(actor.by, 'subconInvoice.add', `外注の請求書を登録：${label(record)}（税込 ${record.total.toLocaleString()}円・${files.length}ファイル）`)
    return NextResponse.json({ ok: true, record: { ...record, id: docId } })
  }

  if (action !== 'update' && action !== 'delete') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  if (!isDocId(body.docId)) return badDocId()
  const docId = body.docId
  const ref = doc(db, COL, docId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
  const cur = { ...(snap.data() as SubconInvoice), id: docId }

  if (action === 'update') {
    const parsed = parseFields(body, main, true)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const patch: Record<string, unknown> = { updatedAt: now }
    for (const [k, v] of Object.entries(parsed.fields)) patch[k] = v
    // 空にした任意項目は null で消す（undefined は Firestore に書かない）
    for (const k of ['no', 'note', 'issueDate', 'dueDate', 'subtotal', 'tax'] as const) {
      if (body[k] !== undefined && parsed.fields[k] === undefined) patch[k] = null
    }
    { const e = subconTotalsError({ ...cur, ...patch } as SubconInvoice); if (e) return NextResponse.json({ error: e }, { status: 400 }) }
    await updateDoc(ref, patch)
    await logActivity(actor.by, 'subconInvoice.update', `外注の請求書を修正：${label({ ...cur, ...parsed.fields })}`)
    return NextResponse.json({ ok: true })
  }

  if (action === 'delete') {
    if (!getStaffDocsBucket()) return storageUnavailable()
    // 記録を先に消す（途中で失敗しても「記録はあるのにファイルが無い」状態を作らない）。ファイルはそのあと消せるだけ消す
    await deleteDoc(ref)
    const failed: string[] = []
    for (const f of cur.files || []) {
      try { await deleteFile(f.path) } catch (e) { failed.push(f.path); console.error('[subcon-invoice] file delete failed', f.path, e) }
    }
    await logActivity(actor.by, 'subconInvoice.delete', `外注の請求書を削除：${label(cur)}${failed.length ? `（ファイル${failed.length}個は消せず残っています）` : ''}`)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
