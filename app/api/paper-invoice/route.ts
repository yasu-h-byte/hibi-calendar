/**
 * 紙（手作り）で出した請求書の保管・システムとの見比べ API（2026-10-02）。仕組みは lib/paper-invoice.ts の冒頭を参照。
 *
 * GET  /api/paper-invoice?ym=YYYYMM            → その月の記録 ＋ 会社ごとのシステムの数字（見比べ用）＋ 選べる会社
 * GET  /api/paper-invoice?ym=YYYYMM&lite=1     → その月の記録だけ（請求書・支払の画面の「紙で発行済み」表示用・集計しない）
 * GET  /api/paper-invoice?all=1                → 全部の月の記録（一覧用・見比べなし）
 * GET  /api/paper-invoice?open=ID&i=0          → そのファイルを見るための署名つきURL（15分）
 * POST { action: 'prepare', files:[{name,contentType,size}] } → 置き場のパスと署名つきURL（まだ記録は作らない）
 * POST { action: 'commit', docId, files, companyId, ym, total, subtotal?, tax?, no?, issueDate?, lines?, note? }
 * POST { action: 'update', docId, ...（commit と同じ項目。files 以外）}
 * POST { action: 'delete', docId }               → ファイルごと削除（invoice.approve）
 *
 * 権限: 見る = invoice.view ／ 登録・修正 = invoice.paper ／ 削除 = invoice.approve（lib/permissions.ts）
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where } from '@/lib/fsdb'
import { getMainData, getMultiMonthAttData, compute, type MainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { safeFileName, isValidIsoDate } from '@/lib/staff-docs'
import { hasRole } from '@/lib/companies'
import { HFU_INVOICE_COMPANY_ID } from '@/lib/constants'
import { resolveInvoiceDraft, listPeerInvoicesForYm } from '@/lib/peer-invoice-store'
import {
  PAPER_INVOICE_ALLOWED_TYPES, PAPER_INVOICE_MAX_FILE_BYTES, PAPER_INVOICE_MAX_FILES,
  sanitizePaperLines, comparePaperWithSystem,
  type PaperInvoice, type PaperInvoiceFile, type SystemInvoiceFigures,
} from '@/lib/paper-invoice'
import { signedUploadUrl, signedReadUrl, fileMeta, deleteFile, getStaffDocsBucket } from '@/lib/storage-admin'

export const dynamic = 'force-dynamic'

const COL = 'paperInvoices'
const HFU_LABEL = 'HFU → 日比建設'

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

/** 請求先として選べる会社: 取引先マスタの「同業（二次）」＋ HFU → 日比建設 */
function selectableCompanies(main: MainData): { id: string; name: string }[] {
  const peers = (main.subcons || []).filter(c => hasRole(c as { id: string; name: string; roles?: string[] }, 'peer'))
    .map(c => ({ id: c.id, name: c.name }))
  return [...peers, { id: HFU_INVOICE_COMPANY_ID, name: HFU_LABEL }]
}

function snapToList(snap: { forEach: (cb: (d: { id: string; data: () => Record<string, unknown> }) => void) => void }): PaperInvoice[] {
  const out: PaperInvoice[] = []
  snap.forEach(d => out.push({ ...(d.data() as unknown as PaperInvoice), id: d.id }))
  return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.companyName.localeCompare(b.companyName, 'ja') || (a.uploadedAt || '').localeCompare(b.uploadedAt || ''))
}

const optNum = (v: unknown): number | undefined | 'invalid' => {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，¥円\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : 'invalid'
}
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
    const i = Number(sp.get('i') || 0)
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
  if (sp.get('lite')) return NextResponse.json({ ym, records })

  const main = await getMainData()
  const companyIds = [...new Set(records.map(r => r.companyId))]
  const system = await systemFiguresFor(main, ym, companyIds)
  const comparisons = Object.fromEntries(records.map(r => [r.id, comparePaperWithSystem(r, system[r.companyId])]))
  return NextResponse.json({
    ym, records, system, comparisons,
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

  // ── アップロード準備（署名つきURLを出すだけ）──
  if (action === 'prepare') {
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

  const main = await getMainData()
  const by = await actorLabel(request)
  const now = new Date().toISOString()
  const label = (r: { companyName: string; ym: string }) => `${r.companyName} ${r.ym.slice(0, 4)}年${parseInt(r.ym.slice(4, 6), 10)}月分`

  // ── 記録を作る（アップロード済みを確認してから）──
  if (action === 'commit') {
    const docId = String(body.docId || '')
    if (!/^[0-9a-f-]{36}$/.test(docId)) return NextResponse.json({ error: 'docId が不正です' }, { status: 400 })
    const parsed = parseFields(body, main, false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const prefix = `paper-invoices/${docId}/`
    const reqFiles = Array.isArray(body.files) ? body.files as PaperInvoiceFile[] : []
    if (reqFiles.length === 0 || reqFiles.some(f => typeof f.path !== 'string' || !f.path.startsWith(prefix))) {
      return NextResponse.json({ error: 'ファイルの指定が不正です' }, { status: 400 })
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const files: PaperInvoiceFile[] = []
    for (const f of reqFiles) {
      const m = await fileMeta(f.path)
      if (!m.exists) return NextResponse.json({ error: `アップロードが完了していません: ${f.name}` }, { status: 409 })
      files.push({ path: f.path, name: safeFileName(f.name), contentType: m.contentType || f.contentType, size: m.size })
    }
    const ref = doc(db, COL, docId)
    if ((await getDoc(ref)).exists()) return NextResponse.json({ error: 'この請求書は既に登録されています' }, { status: 409 })
    const record = compact({ ...parsed.fields, files, uploadedAt: now, uploadedBy: by }) as Omit<PaperInvoice, 'id'>
    await setDoc(ref, record)
    await logActivity(by, 'paperInvoice.add', `紙の請求書を登録：${label(record)}（税込 ${record.total.toLocaleString()}円・${files.length}ファイル）`)
    return NextResponse.json({ ok: true, record: { ...record, id: docId } })
  }

  const docId = String(body.docId || '')
  if (!docId) return NextResponse.json({ error: 'docId が必要です' }, { status: 400 })
  const ref = doc(db, COL, docId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: '請求書が見つかりません' }, { status: 404 })
  const cur = { ...(snap.data() as PaperInvoice), id: docId }

  if (action === 'update') {
    const parsed = parseFields(body, main, true)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    // 空にした任意項目は消す（'' で上書き）。undefined は Firestore に書かない
    const patch: Record<string, unknown> = { updatedAt: now }
    for (const [k, v] of Object.entries(parsed.fields)) patch[k] = v
    for (const k of ['no', 'note', 'issueDate', 'subtotal', 'tax'] as const) {
      if (body[k] !== undefined && parsed.fields[k] === undefined) patch[k] = null
    }
    await updateDoc(ref, patch)
    await logActivity(by, 'paperInvoice.update', `紙の請求書を修正：${label({ ...cur, ...parsed.fields })}`)
    return NextResponse.json({ ok: true })
  }

  if (action === 'delete') {
    if (!getStaffDocsBucket()) return storageUnavailable()
    for (const f of cur.files || []) await deleteFile(f.path)
    await deleteDoc(ref)
    await logActivity(by, 'paperInvoice.delete', `紙の請求書を削除：${label(cur)}`)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
