/**
 * 応援の請求書の発行・取り消し（Firestore 書き込み・2026-09-25）。
 *
 * 保存先は `peerInvoices` コレクション（demmen/main には入れない・独立コレクション）。
 * 1件 = 1回の発行。発行した瞬間の金額・明細・宛先・自社情報をそのままスナップショットとして
 * 保存するので、あとで人員マスタや取引先住所を変えても、発行済みの請求書の内容は変わらない
 * （画面は常にこのスナップショットを描画し、再計算しない）。
 *
 * 番号は `${invoicePrefix}-${ym}-${NN}`。月をまたいで会社が違っても連番（会社別ではない）。
 * 取り消した番号は欠番のまま残る（再利用しない）。
 */
import { db } from './firebase'
import { doc, getDoc, updateDoc, addDoc, collection, getDocs, query, where } from '@/lib/fsdb'
import { logActivity } from './activity'
import {
  buildPeerInvoiceDraft, type PeerInvoiceDraft, type PeerInvoiceLine, type PeerInvoiceSiteDetail,
  type PeerInvoiceCompanyInfo, type InvoiceKind,
} from './peer-invoice'
import {
  buildHfuInvoiceDraft, checkHfuRates, isHfuInvoiceCompanyId, HFU_DEFAULT_INVOICE_PREFIX,
} from './hfu-invoice'
import type { CompanyProfile, MainData, ComputeResult } from './compute'
import type { AttendanceEntry } from '@/types'

const COLLECTION = 'peerInvoices'

/**
 * - pending  : 事務（森田さん）が「発行を申請」した状態。内容は申請時点で凍結、番号はまだ無い
 * - issued   : 事業責任者・管理者が承認（または自分で直接発行）。この時点で番号が付く
 * - void     : 発行後に取り消し（番号は欠番のまま）
 * - rejected : 申請を差し戻し（事業責任者・管理者）
 * - withdrawn: 申請を取り下げ（申請した事務の人）
 * 承認フローの原則（CLAUDE.md）: 事務が作って申請 → 政仁さんが最終承認。2026-09-26 代表指示
 */
export type PeerInvoiceStatus = 'pending' | 'issued' | 'void' | 'rejected' | 'withdrawn'

export interface PeerInvoiceRecord {
  id: string
  /** 'hfu' = HFU → 日比建設。無ければ 'peer'（2026-09-26 より前の記録） */
  kind?: InvoiceKind
  no: string
  companyId: string
  companyName: string
  ym: string
  period: { from: string; to: string }
  company: PeerInvoiceCompanyInfo
  issuer: CompanyProfile
  lines: PeerInvoiceLine[]
  detail: PeerInvoiceSiteDetail[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
  dueDate: string
  status: PeerInvoiceStatus
  /** 発行日（pending の間は空） */
  issueDate: string
  /** 発行（承認）した時刻・人。pending の間は空 */
  issuedAt: string
  issuedBy: string
  /** 申請した時刻・人（申請→承認の流れのときだけ） */
  requestedAt?: string
  requestedBy?: string
  /** 申請した人の名前（画面表示用。actor は人員マスタの id） */
  requestedByName?: string
  /** 差し戻し・取り下げ */
  rejectedAt?: string
  rejectedBy?: string
  rejectReason?: string
  voidedAt?: string
  voidedBy?: string
  voidReason?: string
}

function todayIso(): string {
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`
}

/** 自社情報が請求書発行に足りているか（登録番号・振込先が無い請求書は出せない） */
export function isCompanyProfileReadyForInvoice(
  p: CompanyProfile | null | undefined,
  where = '設定 → 請求書の自社情報',
): { ok: true } | { ok: false; error: string } {
  if (!p) return { ok: false, error: `請求書の自社情報が未入力です（${where}）` }
  const missing: string[] = []
  if (!p.name?.trim()) missing.push('会社名')
  if (!p.address?.trim()) missing.push('住所')
  if (!p.invoiceRegNo?.trim()) missing.push('適格請求書発行事業者の登録番号')
  if (!p.bank?.bankName?.trim() || !p.bank?.accountNo?.trim()) missing.push('振込先')
  if (missing.length > 0) return { ok: false, error: `請求書の自社情報が未入力です（${missing.join('・')}）。${where} から入力してください` }
  return { ok: true }
}

export async function listPeerInvoicesForYm(ym: string): Promise<PeerInvoiceRecord[]> {
  const snap = await getDocs(query(collection(db, COLLECTION), where('ym', '==', ym)))
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PeerInvoiceRecord, 'id'>) }))
}

export async function getPeerInvoicesForCompanyYm(ym: string, companyId: string): Promise<PeerInvoiceRecord[]> {
  const snap = await getDocs(query(collection(db, COLLECTION), where('ym', '==', ym), where('companyId', '==', companyId)))
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as Omit<PeerInvoiceRecord, 'id'>) }))
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
}

/** その月の次の請求書番号を出す（会社を問わず連番。欠番は詰めない） */
async function nextInvoiceNo(ym: string, prefix: string): Promise<string> {
  const all = await listPeerInvoicesForYm(ym)
  let max = 0
  const re = new RegExp(`^${prefix}-${ym}-(\\d+)$`)
  for (const inv of all) {
    const m = inv.no.match(re)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${prefix}-${ym}-${String(max + 1).padStart(2, '0')}`
}

export interface IssuePeerInvoiceResult {
  ok: true
  record: PeerInvoiceRecord
}
export interface IssuePeerInvoiceError {
  ok: false
  error: string
}

/**
 * companyId に応じた下書きと発行者を作る。HFU → 日比建設 は発行者が HFU、それ以外は日比建設。
 * GET（下書き表示）と発行の両方がここを通るので、画面の下書きと発行内容は必ず同じ計算になる。
 */
export function resolveInvoiceDraft(args: {
  main: MainData
  c: ComputeResult
  attD: Record<string, AttendanceEntry>
  attSD: Record<string, { n: number; on: number }>
  ym: string
  companyId: string
}): { draft: PeerInvoiceDraft | null; issuer: CompanyProfile | null } {
  const { main, c, attD, attSD, ym, companyId } = args
  if (isHfuInvoiceCompanyId(companyId)) {
    return { draft: buildHfuInvoiceDraft(main, attD, ym), issuer: main.hfuInvoice?.profile || null }
  }
  return { draft: buildPeerInvoiceDraft(main, c, attD, attSD, ym, companyId), issuer: main.companyProfile || null }
}

type InvoiceCalcArgs = {
  main: MainData
  c: ComputeResult
  attD: Record<string, AttendanceEntry>
  attSD: Record<string, { n: number; on: number }>
  ym: string
  companyId: string
  actor: string
}

const invoiceTitle = (companyId: string) => isHfuInvoiceCompanyId(companyId) ? 'HFU → 日比建設 の請求書' : '応援の請求書'
const jpYmOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月分`

/** HFU → 日比建設 は従来の請求書どおり対象月の末日付け（2025-12 分は 令和7年12月31日）。応援の請求書は発行した日 */
function issueDateFor(rec: { companyId: string; period: { to: string } }): string {
  return isHfuInvoiceCompanyId(rec.companyId) ? rec.period.to : todayIso()
}

/** 番号の接頭辞（発行者ごと。HFU と日比建設で連番を混ぜない） */
function prefixFor(main: MainData, rec: { companyId: string; issuer: CompanyProfile }): { ok: true; prefix: string } | { ok: false; error: string } {
  const isHfu = isHfuInvoiceCompanyId(rec.companyId)
  const prefix = rec.issuer.invoicePrefix?.trim() || (isHfu ? HFU_DEFAULT_INVOICE_PREFIX : 'HC')
  if (isHfu && prefix === (main.companyProfile?.invoicePrefix?.trim() || 'HC')) {
    return { ok: false, error: 'HFU の請求書番号の接頭辞が日比建設と同じです。設定で別の接頭辞にしてください' }
  }
  return { ok: true, prefix }
}

/**
 * 下書きをその場で再計算し、発行できるか確かめて凍結用の内容を作る（クライアントの古い draft を信用しない）。
 * 同じ会社・同じ月に発行済み・申請中のものがあれば拒否。
 */
async function buildFrozenInvoice(args: InvoiceCalcArgs): Promise<
  { ok: true; body: Omit<PeerInvoiceRecord, 'id' | 'no' | 'status' | 'issueDate' | 'issuedAt' | 'issuedBy'> } | IssuePeerInvoiceError
> {
  const { main, c, attD, attSD, ym, companyId } = args
  const isHfu = isHfuInvoiceCompanyId(companyId)
  const { draft, issuer } = resolveInvoiceDraft({ main, c, attD, attSD, ym, companyId })
  const profileCheck = isCompanyProfileReadyForInvoice(issuer, isHfu ? '設定 → HFU → 日比建設 の請求書' : undefined)
  if (!profileCheck.ok) return { ok: false, error: profileCheck.error }
  if (!draft || !issuer) return { ok: false, error: isHfu ? 'この月は HFU の人工がありません' : 'この会社・この月に応援の請求はありません' }

  const existing = await getPeerInvoicesForCompanyYm(ym, companyId)
  if (existing.some(inv => inv.status === 'issued')) {
    return { ok: false, error: 'この会社・この月はすでに発行済みです。作り直す場合は先に取り消してください' }
  }
  if (existing.some(inv => inv.status === 'pending')) {
    return { ok: false, error: 'この会社・この月は承認待ちの申請があります。承認・差し戻し・取り下げのどれかが済んでから操作してください' }
  }
  if (isHfu) {
    const rateCheck = checkHfuRates(draft)
    if (!rateCheck.ok) return { ok: false, error: rateCheck.error }
  }
  const prefixCheck = prefixFor(main, { companyId, issuer })
  if (!prefixCheck.ok) return prefixCheck

  return {
    ok: true,
    body: {
      kind: isHfu ? 'hfu' : 'peer',
      companyId: draft.companyId,
      companyName: draft.companyName,
      ym: draft.ym,
      period: draft.period,
      company: draft.company,
      issuer,
      lines: draft.lines,
      detail: draft.detail,
      subtotal: draft.subtotal,
      taxRate: draft.taxRate,
      tax: draft.tax,
      total: draft.total,
      dueDate: draft.dueDate,
    },
  }
}

/** 事業責任者・管理者が自分で直接発行する（申請を経ない）。番号はこの時点で付く */
export async function issuePeerInvoice(args: InvoiceCalcArgs): Promise<IssuePeerInvoiceResult | IssuePeerInvoiceError> {
  const frozen = await buildFrozenInvoice(args)
  if (!frozen.ok) return frozen
  const pf = prefixFor(args.main, frozen.body)
  if (!pf.ok) return pf
  const no = await nextInvoiceNo(args.ym, pf.prefix)
  const record: Omit<PeerInvoiceRecord, 'id'> = {
    ...frozen.body, no, status: 'issued',
    issueDate: issueDateFor(frozen.body), issuedAt: new Date().toISOString(), issuedBy: args.actor,
  }
  const ref = await addDoc(collection(db, COLLECTION), record)
  await logActivity(args.actor, 'peerInvoice.issue', `${record.companyName} ${jpYmOf(args.ym)} ${invoiceTitle(record.companyId)} ${no}（¥${record.total.toLocaleString()}）を発行`)
  return { ok: true, record: { id: ref.id, ...record } }
}

/** 事務が「発行を申請」する。内容はこの時点で凍結し、承認されたら番号が付いて発行済みになる */
export async function requestPeerInvoice(args: InvoiceCalcArgs): Promise<IssuePeerInvoiceResult | IssuePeerInvoiceError> {
  const frozen = await buildFrozenInvoice(args)
  if (!frozen.ok) return frozen
  const now = new Date().toISOString()
  const record: Omit<PeerInvoiceRecord, 'id'> = {
    ...frozen.body, no: '', status: 'pending',
    issueDate: '', issuedAt: '', issuedBy: '',
    requestedAt: now, requestedBy: args.actor,
    requestedByName: args.main.workers.find(w => String(w.id) === args.actor)?.name || args.actor,
  }
  const ref = await addDoc(collection(db, COLLECTION), record)
  await logActivity(args.actor, 'peerInvoice.request', `${record.companyName} ${jpYmOf(args.ym)} ${invoiceTitle(record.companyId)}（¥${record.total.toLocaleString()}）の発行を申請`)
  return { ok: true, record: { id: ref.id, ...record } }
}

async function loadInvoice(id: string) {
  const ref = doc(db, COLLECTION, id)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return { ref, data: snap.data() as Omit<PeerInvoiceRecord, 'id'> }
}

/**
 * 申請を承認して発行する（事業責任者・管理者）。申請時点で凍結した内容をそのまま発行する
 * （承認者が見て確かめた内容と、発行される内容が食い違わないように再計算しない）。
 */
export async function approvePeerInvoice(args: { main: MainData; id: string; actor: string }): Promise<IssuePeerInvoiceResult | IssuePeerInvoiceError> {
  const { main, id, actor } = args
  const loaded = await loadInvoice(id)
  if (!loaded) return { ok: false, error: '請求書が見つかりません' }
  const { ref, data } = loaded
  if (data.status !== 'pending') return { ok: false, error: '承認待ちの申請ではありません（すでに処理済みです）' }
  const existing = await getPeerInvoicesForCompanyYm(data.ym, data.companyId)
  if (existing.some(inv => inv.status === 'issued')) {
    return { ok: false, error: 'この会社・この月はすでに発行済みです。先に取り消すか、この申請を差し戻してください' }
  }
  const pf = prefixFor(main, data)
  if (!pf.ok) return pf
  const no = await nextInvoiceNo(data.ym, pf.prefix)
  const update = { no, status: 'issued' as const, issueDate: issueDateFor(data), issuedAt: new Date().toISOString(), issuedBy: actor }
  await updateDoc(ref, update)
  await logActivity(actor, 'peerInvoice.approve', `${data.companyName} ${jpYmOf(data.ym)} ${invoiceTitle(data.companyId)} ${no}（¥${data.total.toLocaleString()}）を承認して発行（申請: ${data.requestedBy || '—'}）`)
  return { ok: true, record: { id, ...data, ...update } }
}

/** 申請の差し戻し（事業責任者・管理者）または取り下げ（申請した事務の人） */
export async function rejectPeerInvoice(args: { id: string; actor: string; reason?: string; withdraw?: boolean }): Promise<{ ok: true; record: PeerInvoiceRecord } | IssuePeerInvoiceError> {
  const { id, actor, reason, withdraw } = args
  const loaded = await loadInvoice(id)
  if (!loaded) return { ok: false, error: '請求書が見つかりません' }
  const { ref, data } = loaded
  if (data.status !== 'pending') return { ok: false, error: '承認待ちの申請ではありません（すでに処理済みです）' }
  const update = { status: (withdraw ? 'withdrawn' : 'rejected') as PeerInvoiceStatus, rejectedAt: new Date().toISOString(), rejectedBy: actor, rejectReason: reason || '' }
  await updateDoc(ref, update)
  await logActivity(actor, withdraw ? 'peerInvoice.withdraw' : 'peerInvoice.reject', `${data.companyName} ${jpYmOf(data.ym)} ${invoiceTitle(data.companyId)} の申請を${withdraw ? '取り下げ' : '差し戻し'}${reason ? `（${reason}）` : ''}`)
  return { ok: true, record: { id, ...data, ...update } }
}

/** 承認待ちの申請（通知ベル用。status の単一フィールドクエリ1回） */
export async function listPendingPeerInvoices(): Promise<PeerInvoiceRecord[]> {
  const snap = await getDocs(query(collection(db, COLLECTION), where('status', '==', 'pending')))
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PeerInvoiceRecord, 'id'>) }))
}

export async function voidPeerInvoice(args: { id: string; actor: string; reason?: string }): Promise<{ ok: true; record: PeerInvoiceRecord } | { ok: false; error: string }> {
  const { id, actor, reason } = args
  const ref = doc(db, COLLECTION, id)
  const snap = await getDoc(ref)
  if (!snap.exists()) return { ok: false, error: '請求書が見つかりません' }
  const data = snap.data() as Omit<PeerInvoiceRecord, 'id'>
  if (data.status === 'void') return { ok: false, error: 'すでに取り消し済みです' }
  if (data.status !== 'issued') return { ok: false, error: '発行済みの請求書ではありません（申請中のものは差し戻し・取り下げで処理してください）' }

  const now = new Date().toISOString()
  await updateDoc(ref, { status: 'void', voidedAt: now, voidedBy: actor, voidReason: reason || '' })
  await logActivity(actor, 'peerInvoice.void', `${data.companyName} ${data.ym.slice(0, 4)}年${parseInt(data.ym.slice(4, 6), 10)}月分 ${data.no} を取り消し${reason ? `（${reason}）` : ''}`)

  return { ok: true, record: { id, ...data, status: 'void', voidedAt: now, voidedBy: actor, voidReason: reason || '' } }
}

export type { PeerInvoiceDraft }
