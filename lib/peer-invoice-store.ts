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
  type PeerInvoiceCompanyInfo,
} from './peer-invoice'
import type { CompanyProfile, MainData, ComputeResult } from './compute'
import type { AttendanceEntry } from '@/types'

const COLLECTION = 'peerInvoices'

export type PeerInvoiceStatus = 'issued' | 'void'

export interface PeerInvoiceRecord {
  id: string
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
  issueDate: string
  issuedAt: string
  issuedBy: string
  voidedAt?: string
  voidedBy?: string
  voidReason?: string
}

function todayIso(): string {
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`
}

/** 自社情報が請求書発行に足りているか（登録番号・振込先が無い請求書は出せない） */
export function isCompanyProfileReadyForInvoice(p: CompanyProfile | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!p) return { ok: false, error: '請求書の自社情報が未入力です（設定 → 請求書の自社情報）' }
  const missing: string[] = []
  if (!p.name?.trim()) missing.push('会社名')
  if (!p.address?.trim()) missing.push('住所')
  if (!p.invoiceRegNo?.trim()) missing.push('適格請求書発行事業者の登録番号')
  if (!p.bank?.bankName?.trim() || !p.bank?.accountNo?.trim()) missing.push('振込先')
  if (missing.length > 0) return { ok: false, error: `請求書の自社情報が未入力です（${missing.join('・')}）。設定 → 請求書の自社情報 から入力してください` }
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
 * 発行。draft をその場で再計算してから凍結する（クライアントの古い draft を信用しない）。
 * 同じ会社・同じ月にすでに発行済み（void されていない）ものがあれば拒否 — 先に取り消しが必要。
 */
export async function issuePeerInvoice(args: {
  main: MainData
  c: ComputeResult
  attD: Record<string, AttendanceEntry>
  attSD: Record<string, { n: number; on: number }>
  ym: string
  companyId: string
  actor: string
}): Promise<IssuePeerInvoiceResult | IssuePeerInvoiceError> {
  const { main, c, attD, attSD, ym, companyId, actor } = args

  const profileCheck = isCompanyProfileReadyForInvoice(main.companyProfile)
  if (!profileCheck.ok) return { ok: false, error: profileCheck.error }

  const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, companyId)
  if (!draft) return { ok: false, error: 'この会社・この月に応援の請求はありません' }

  const existing = await getPeerInvoicesForCompanyYm(ym, companyId)
  if (existing.some(inv => inv.status === 'issued')) {
    return { ok: false, error: 'この会社・この月はすでに発行済みです。作り直す場合は先に取り消してください' }
  }

  const prefix = main.companyProfile!.invoicePrefix?.trim() || 'HC'
  const no = await nextInvoiceNo(ym, prefix)
  const now = new Date().toISOString()

  const record: Omit<PeerInvoiceRecord, 'id'> = {
    no,
    companyId: draft.companyId,
    companyName: draft.companyName,
    ym: draft.ym,
    period: draft.period,
    company: draft.company,
    issuer: main.companyProfile!,
    lines: draft.lines,
    detail: draft.detail,
    subtotal: draft.subtotal,
    taxRate: draft.taxRate,
    tax: draft.tax,
    total: draft.total,
    dueDate: draft.dueDate,
    status: 'issued',
    issueDate: todayIso(),
    issuedAt: now,
    issuedBy: actor,
  }

  const ref = await addDoc(collection(db, COLLECTION), record)
  await logActivity(actor, 'peerInvoice.issue', `${draft.companyName} ${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月分 応援の請求書 ${no}（¥${draft.total.toLocaleString()}）を発行`)

  return { ok: true, record: { id: ref.id, ...record } }
}

export async function voidPeerInvoice(args: { id: string; actor: string; reason?: string }): Promise<{ ok: true; record: PeerInvoiceRecord } | { ok: false; error: string }> {
  const { id, actor, reason } = args
  const ref = doc(db, COLLECTION, id)
  const snap = await getDoc(ref)
  if (!snap.exists()) return { ok: false, error: '請求書が見つかりません' }
  const data = snap.data() as Omit<PeerInvoiceRecord, 'id'>
  if (data.status === 'void') return { ok: false, error: 'すでに取り消し済みです' }

  const now = new Date().toISOString()
  await updateDoc(ref, { status: 'void', voidedAt: now, voidedBy: actor, voidReason: reason || '' })
  await logActivity(actor, 'peerInvoice.void', `${data.companyName} ${data.ym.slice(0, 4)}年${parseInt(data.ym.slice(4, 6), 10)}月分 ${data.no} を取り消し${reason ? `（${reason}）` : ''}`)

  return { ok: true, record: { id, ...data, status: 'void', voidedAt: now, voidedBy: actor, voidReason: reason || '' } }
}

export type { PeerInvoiceDraft }
