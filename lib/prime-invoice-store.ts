/**
 * 一次（山岡建設工業など）への請求書の保存・申請・承認・発行・取り消し（Firestore 書き込み・2026-10-20）。
 * 計算・読み取りは lib/prime-invoice.ts（純粋関数）。仕組みの説明は同ファイルの冒頭と docs/prime-invoice.md。
 *
 * 保存先は `primeInvoices` コレクション。1件 = 一次会社 × 現場 × 対象月（中に工種ごとの枚 sheets[]）。
 * 応援の請求書（peerInvoices）と違い、下書き（draft）も保存する（控え・メモのファイルを持つため）。
 *
 * 状態（2026-10-20 代表決定の承認ルート: 格納（森田さん）→ 確認1（政仁さん）→ 確認2（代表）→ 発行）:
 *   draft（下書き・直せる）→ pending（事務が申請・内容を凍結・確認1待ち）→ checked（事業責任者が確認1・確認2待ち）
 *   → issued（代表が確認2して発行・番号が付く）→ void（取り消し・番号は欠番）
 *   確認1と確認2は別の人（同じ人が両方はできない）。差し戻し（確認1・確認2のどちらでも）・取り下げは draft に戻す（ファイルも直した内容も残る。番号は消費しない）。
 * 番号は `${invoicePrefix}P-${ym}-${NN}`（例 HCP-202609-01）。応援の請求書（HC-202609-01）と混ぜない。
 * 同じ月の採番・申請・承認は応援の請求書と同じ合図（withInvoiceMonthLock）で直列にする。
 */
import { randomUUID } from 'crypto'
import { db } from './firebase'
import { doc, getDoc, updateDoc, deleteDoc, collection, getDocs, query, where } from '@/lib/fsdb'
import { logActivity } from './activity'
import type { MainData, CompanyProfile } from './compute'
import { approvalGap, describeApprovalGap, FINAL_APPROVAL_REQUIRED_FROM_YM, type ApprovalGap } from './approval-gap'
import { isCompanyProfileReadyForInvoice, withInvoiceMonthLock, nextInvoiceNoFrom, listPaperInvoicesForYm } from './peer-invoice-store'
import { todayJstIso } from './date-utils'
import {
  PRIME_INVOICE_NO_SUFFIX, PRIME_INVOICE_RATIO, PRIME_INVOICE_TAX_RATE, sumSheets, recomputeSheet,
  primePeriodOf, primeBillingPeriodOf, defaultPrimeInvoiceDate,
  type PrimeInvoiceBundle, type PrimeInvoiceFile, type PrimeSheet,
} from './prime-invoice'

const COLLECTION = 'primeInvoices'

const jpYmOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月分`
const labelOf = (b: Pick<PrimeInvoiceBundle, 'companyName' | 'siteName' | 'ym'>) => `${b.companyName} ${b.siteName} ${jpYmOf(b.ym)}`

type Snap = { forEach: (cb: (d: { id: string; data: () => Record<string, unknown> }) => void) => void }
function snapToList(snap: Snap): PrimeInvoiceBundle[] {
  const out: PrimeInvoiceBundle[] = []
  snap.forEach(d => out.push({ ...(d.data() as unknown as PrimeInvoiceBundle), id: d.id }))
  return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.siteName.localeCompare(b.siteName, 'ja') || (a.createdAt || '').localeCompare(b.createdAt || ''))
}

export async function listPrimeBundlesForYm(ym: string): Promise<PrimeInvoiceBundle[]> {
  return snapToList(await getDocs(query(collection(db, COLLECTION), where('ym', '==', ym))))
}

/** 全部の月（月の一覧・件数用。1件が大きいので一覧には使わず、月と状態だけ返す） */
export async function listPrimeBundlesSummary(): Promise<{ id: string; ym: string; status: PrimeInvoiceBundle['status']; companyId: string; siteId: string }[]> {
  const out: { id: string; ym: string; status: PrimeInvoiceBundle['status']; companyId: string; siteId: string }[] = []
  const snap = await getDocs(collection(db, COLLECTION))
  snap.forEach(d => { const x = d.data() as PrimeInvoiceBundle; out.push({ id: d.id, ym: x.ym, status: x.status, companyId: x.companyId, siteId: x.siteId }) })
  return out
}

export async function getPrimeBundle(id: string): Promise<PrimeInvoiceBundle | null> {
  const snap = await getDoc(doc(db, COLLECTION, id))
  if (!snap.exists()) return null
  return { ...(snap.data() as Omit<PrimeInvoiceBundle, 'id'>), id }
}

/** 確認待ち（通知ベル用）: pending = 確認1待ち（事業責任者）／ checked = 確認2待ち（代表）。status の IN クエリ1回 */
export async function listPendingPrimeInvoices(): Promise<PrimeInvoiceBundle[]> {
  return snapToList(await getDocs(query(collection(db, COLLECTION), where('status', 'in', ['pending', 'checked']))))
}

/** 同じ会社・現場・月で生きているもの（void 以外）があればその理由 */
function activeBundleError(existing: PrimeInvoiceBundle[], exceptId?: string): string | null {
  const live = existing.filter(b => b.id !== exceptId && b.status !== 'void')
  if (live.length === 0) return null
  const b = live[0]
  const s = b.status === 'issued' ? '発行済み' : b.status === 'pending' ? '確認1待ち' : b.status === 'checked' ? '確認2待ち' : '下書き'
  return `この会社・この現場・この月は${s}の請求書があります（${b.no || '番号なし'}）。作り直す場合は、そちらを開いて直すか、取り消し・削除してから入れ直してください`
}

/** 紙の控えとして同じ現場・月の一次への請求書を入れてあれば二重請求になるので止める */
async function paperDoubleBillingError(b: Pick<PrimeInvoiceBundle, 'companyId' | 'siteId' | 'ym'>): Promise<string | null> {
  const papers = await listPaperInvoicesForYm(b.ym)
  const hit = papers.filter(p => p.companyId === b.companyId && p.siteId === b.siteId)
  if (hit.length === 0) return null
  return `この現場・この月は「紙の請求書の控え」に一次への請求書が${hit.length}枚入っています（手作りで発行済み）。二重請求になるため、システムからは発行できません。紙の控えを消すか、こちらを下書きのままにしてください`
}

/**
 * 請求する人工の日に、職長承認と最終承認がそろっているか（応援の請求書と同じ決まり・2026-09-30 代表決定）。
 * 人工の期間が2か月にまたがる（前月21日〜当月20日）ので、月ごとに見る。
 */
export async function primeApprovalGap(
  main: MainData, familyId: string, activeDays: { ym: string; day: number }[],
): Promise<{ required: boolean; foremanMissing: number; finalMissing: number; message: string }> {
  const sites = main.sites as { id: string; parentId?: string }[]
  const byYm = new Map<string, number[]>()
  for (const d of activeDays) byYm.set(d.ym, [...(byYm.get(d.ym) || []), d.day])
  const nameOf = (id: string) => main.sites.find(x => x.id === id)?.name || id
  let foremanMissing = 0, finalMissing = 0
  const messages: string[] = []
  let required = false
  for (const [ym, days] of byYm) {
    if (ym < FINAL_APPROVAL_REQUIRED_FROM_YM) continue
    required = true
    const gap: ApprovalGap = await approvalGap(sites, ym, days.map(day => ({ familyId, day })))
    foremanMissing += gap.foremanMissing.length
    finalMissing += gap.finalMissing.length
    if (gap.foremanMissing.length || gap.finalMissing.length) messages.push(`${jpYmOf(ym)}: ${describeApprovalGap(gap, nameOf)}`)
  }
  return { required, foremanMissing, finalMissing, message: messages.join('\n') }
}

export interface PrimeResult { ok: true; record: PrimeInvoiceBundle }
export interface PrimeError { ok: false; error: string }

/** Firestore に undefined を書かない */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/**
 * 下書きを新しく作る（読み取り済みの枚とファイルを渡す）。同じ会社・現場・月に生きているものがあれば拒否。
 * docId は呼び出し側（API）がアップロードの置き場に使った id をそのまま使う。
 */
export async function createPrimeDraft(args: {
  main: MainData; docId: string; companyId: string; companyName: string; siteId: string; siteName: string; ym: string
  sheets: PrimeSheet[]; files: PrimeInvoiceFile[]; warnings: string[]; actor: string; actorName: string
}): Promise<PrimeResult | PrimeError> {
  const { main, docId, ym } = args
  const now = new Date().toISOString()
  const sums = sumSheets(args.sheets)
  const invoiceDate = args.sheets.map(s => s.billDate).find(Boolean) || defaultPrimeInvoiceDate(ym)
  const p = primePeriodOf(ym)
  const record: Omit<PrimeInvoiceBundle, 'id'> = {
    companyId: args.companyId, companyName: args.companyName, siteId: args.siteId, siteName: args.siteName, ym,
    period: { from: p.from, to: p.to }, billingPeriod: primeBillingPeriodOf(ym), invoiceDate,
    ratio: PRIME_INVOICE_RATIO, taxRate: PRIME_INVOICE_TAX_RATE,
    sheets: args.sheets, files: args.files, warnings: args.warnings, ...sums,
    issuer: main.companyProfile || null,
    status: 'draft', no: '', issueDate: '', issuedAt: '', issuedBy: '',
    createdAt: now, createdBy: args.actor, ...(args.actorName ? { createdByName: args.actorName } : {}), updatedAt: now,
  }
  const ref = doc(db, COLLECTION, docId)
  const written = await withInvoiceMonthLock(ym, async (tx) => {
    const all = await listPrimeBundlesForYm(ym)
    const err = activeBundleError(all.filter(b => b.companyId === args.companyId && b.siteId === args.siteId))
    if (err) return { ok: false as const, error: err }
    const cur = await tx.get(ref)
    if (cur.exists()) return { ok: false as const, error: 'この請求書は既に登録されています' }
    tx.set(ref, compact(record as unknown as Record<string, unknown>))
    return { ok: true as const, record: { id: docId, ...record } }
  })
  if (!written.ok) return written
  await logActivity(args.actor, 'primeInvoice.create', `一次への請求書の下書きを作成：${labelOf(record)}（${record.sheets.length}枚・税抜 ${record.subtotal.toLocaleString()}円）`)
  return written
}

/** 下書きの内容を直す（枚の数字・請求年月日・ファイル）。draft のときだけ */
export async function updatePrimeDraft(args: {
  id: string; actor: string
  patch: { sheets?: PrimeSheet[]; files?: PrimeInvoiceFile[]; invoiceDate?: string; warnings?: string[]; ratio?: number; ratioNote?: string }
}): Promise<PrimeResult | PrimeError> {
  const cur = await getPrimeBundle(args.id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (cur.status !== 'draft') return { ok: false, error: '下書きのときだけ直せます（申請中は取り下げ、発行済みは取り消してから）' }
  const ratio = args.patch.ratio ?? cur.ratio ?? PRIME_INVOICE_RATIO
  const ratioChanged = args.patch.ratio !== undefined && Math.abs(args.patch.ratio - (cur.ratio ?? PRIME_INVOICE_RATIO)) > 1e-9
  // 割合を変えたら全部の枚を計算し直す
  const sheets = (args.patch.sheets || (ratioChanged ? cur.sheets : null))?.map(s => recomputeSheet(s, ratio)) || cur.sheets
  const sums = sumSheets(sheets)
  const upd = compact({
    sheets, files: args.patch.files, invoiceDate: args.patch.invoiceDate, warnings: args.patch.warnings,
    ratio: args.patch.ratio, ratioNote: args.patch.ratioNote, ...sums, updatedAt: new Date().toISOString(),
  })
  await updateDoc(doc(db, COLLECTION, args.id), upd)
  await logActivity(args.actor, 'primeInvoice.update', `一次への請求書の下書きを修正：${labelOf(cur)}（税抜 ${sums.subtotal.toLocaleString()}円${ratioChanged ? `・割合 ${Math.round((cur.ratio ?? PRIME_INVOICE_RATIO) * 100)}% → ${Math.round(ratio * 100)}%${args.patch.ratioNote ? `（${args.patch.ratioNote}）` : ''}` : ''}）`)
  return { ok: true, record: { ...cur, ...upd } as PrimeInvoiceBundle }
}

/** 発行・申請できるかの共通の確認（自社情報・紙の二重請求・承認の有無は呼び出し側が渡す） */
async function readinessError(main: MainData, b: PrimeInvoiceBundle, approvalMessage: string | null): Promise<string | null> {
  const pc = isCompanyProfileReadyForInvoice(main.companyProfile)
  if (!pc.ok) return pc.error
  if (b.sheets.length === 0) return '請求する枚がありません（大林組の控えを入れてください）'
  if (b.sheets.some(s => !(s.amount > 0))) return '請求額が0円以下の枚があります。数字を確かめてください'
  if (b.sheets.some(s => s.wageDeductions.some(w => w.amount < 0) || s.borrowed.some(x => x.amount < 0))) return '控除にマイナスの金額があります'
  const paper = await paperDoubleBillingError(b)
  if (paper) return paper
  if (approvalMessage) return `請求する人工の日の中に、職長承認・最終承認が済んでいない日があるため発行できません。\n${approvalMessage}\n出面の画面で承認を済ませてから発行してください`
  return null
}

/** 事務が「発行を申請」する（draft → pending・確認1待ち）。内容はこの時点で凍結（自社情報も） */
export async function requestPrimeInvoice(args: { main: MainData; id: string; actor: string; approvalMessage: string | null }): Promise<PrimeResult | PrimeError> {
  const { main, id, actor } = args
  const cur = await getPrimeBundle(id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (cur.status !== 'draft') return { ok: false, error: '下書きではありません（すでに申請・発行済みです）' }
  const err = await readinessError(main, cur, args.approvalMessage)
  if (err) return { ok: false, error: err }
  const now = new Date().toISOString()
  const upd = {
    status: 'pending' as const, issuer: main.companyProfile as CompanyProfile,
    requestedAt: now, requestedBy: actor, requestedByName: main.workers.find(w => String(w.id) === actor)?.name || actor,
    checkedAt: '', checkedBy: '', checkedByName: '',
    rejectedAt: '', rejectedBy: '', rejectReason: '', updatedAt: now,
  }
  await updateDoc(doc(db, COLLECTION, id), upd)
  await logActivity(actor, 'primeInvoice.request', `${labelOf(cur)} 一次への請求書（税込 ¥${cur.total.toLocaleString()}）の発行を申請（確認1待ち）`)
  return { ok: true, record: { ...cur, ...upd } }
}

/** 確認1（事業責任者・政仁さん）: pending → checked。内容は申請時に凍結したまま。発行は確認2（代表）で */
export async function checkPrimeInvoice(args: { main: MainData; id: string; actor: string; approvalMessage: string | null }): Promise<PrimeResult | PrimeError> {
  const { main, id, actor } = args
  const cur = await getPrimeBundle(id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (cur.status !== 'pending') return { ok: false, error: '確認1待ちではありません（すでに処理済みです）' }
  if (cur.requestedBy === actor) return { ok: false, error: '申請した人は確認1をできません（別の人が確かめます）' }
  const err = await readinessError(main, cur, args.approvalMessage)
  if (err) return { ok: false, error: err }
  const now = new Date().toISOString()
  const upd = { status: 'checked' as const, checkedAt: now, checkedBy: actor, checkedByName: main.workers.find(w => String(w.id) === actor)?.name || (actor === 'super-admin' ? '代表' : actor), updatedAt: now }
  await updateDoc(doc(db, COLLECTION, id), upd)
  await logActivity(actor, 'primeInvoice.check', `${labelOf(cur)} 一次への請求書（税込 ¥${cur.total.toLocaleString()}）を確認1（確認2待ち）`)
  return { ok: true, record: { ...cur, ...upd } }
}

/**
 * 確認2して発行（checked → issued・代表だけ・lib/permissions.ts invoice.issuePrime）。確認1をした人とは別の人。
 * 番号はここで付く。採番と「同じ会社・現場・月に発行済みが無いか」は同じ月の処理を直列にした中で読み直す。
 */
export async function issuePrimeInvoice(args: {
  main: MainData; id: string; actor: string; approvalMessage: string | null
  /** 代表が確認1・確認2をまとめて1回で発行する（下書き・確認1待ち・確認2待ちのどれからでも。2026-10-20 代表） */
  direct?: boolean
}): Promise<PrimeResult | PrimeError> {
  const { main, id, actor, direct } = args
  const cur = await getPrimeBundle(id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (direct) {
    if (cur.status !== 'draft' && cur.status !== 'pending' && cur.status !== 'checked') return { ok: false, error: '発行できる状態ではありません（発行済み・取り消し済み）' }
  } else {
    if (cur.status !== 'checked') return { ok: false, error: cur.status === 'pending' ? '確認1（事業責任者）がまだです。確認1のあとに確認2で発行します（代表は「1回で発行」もできます）' : '発行できる状態ではありません（下書き・発行済み・取り消し済み）' }
    if (cur.checkedBy && cur.checkedBy === actor) return { ok: false, error: '確認1をした人は確認2をできません（別の人が確かめるか、代表の「1回で発行」を使います）' }
  }
  const err = await readinessError(main, cur, args.approvalMessage)
  if (err) return { ok: false, error: err }
  const issuer = cur.issuer || (main.companyProfile as CompanyProfile)
  const prefix = `${issuer.invoicePrefix?.trim() || 'HC'}${PRIME_INVOICE_NO_SUFFIX}`
  const ref = doc(db, COLLECTION, id)
  const done = await withInvoiceMonthLock(cur.ym, async (tx) => {
    const fresh = await tx.get(ref)
    const st = fresh.exists() ? (fresh.data() as { status?: string }).status : undefined
    if (direct ? (st !== 'draft' && st !== 'pending' && st !== 'checked') : st !== 'checked') return { ok: false as const, error: '発行できる状態ではありません（すでに処理済みです）' }
    const all = await listPrimeBundlesForYm(cur.ym)
    if (all.some(b => b.id !== id && b.companyId === cur.companyId && b.siteId === cur.siteId && b.status === 'issued')) {
      return { ok: false as const, error: 'この会社・この現場・この月はすでに発行済みです。先に取り消してください' }
    }
    const now = new Date().toISOString()
    const update = {
      no: nextInvoiceNoFrom(all, cur.ym, prefix), status: 'issued' as const, issuer, issueDate: cur.invoiceDate || todayJstIso(), issuedAt: now, issuedBy: actor, updatedAt: now,
      // 1回で発行: 確認1の記録も代表（まとめて）として残す（誰がどの段を飛ばしたかが分かるように）
      ...(direct && !cur.checkedAt ? { checkedAt: now, checkedBy: actor, checkedByName: '代表（1回で発行）' } : {}),
      ...(direct && cur.status === 'draft' ? { requestedAt: now, requestedBy: actor, requestedByName: '代表（1回で発行）' } : {}),
    }
    tx.update(ref, update)
    return { ok: true as const, update }
  })
  if (!done.ok) return done
  // 現場の請求額（原価・収益・経営コックピットの 13週資金繰りの元）を、発行した請求書の税抜（工種ごと）で上書きする（2026-10-20）
  //   原価・収益で手で入れた額と、発行した請求書が食い違わないように。取り消しのときは触らない（作り直せば上書きされる）
  await syncSiteBillingFromInvoice({ ...cur, ...done.update }, actor).catch(e => console.error('[prime-invoice] billing sync failed', id, e))
  await logActivity(actor, direct ? 'primeInvoice.issueDirect' : 'primeInvoice.issue',
    `${labelOf(cur)} 一次への請求書 ${done.update.no}（${cur.sheets.length}枚・税込 ¥${cur.total.toLocaleString()}）を${direct ? `代表が1回で発行（確認1・確認2をまとめて。元の状態: ${cur.status}）` : `確認2して発行（申請: ${cur.requestedByName || cur.requestedBy || '—'}・確認1: ${cur.checkedByName || cur.checkedBy || '—'}）`}`)
  return { ok: true, record: { ...cur, ...done.update } }
}

/**
 * 発行した請求書の税抜（枚ごと）を、現場の請求額 demmen/main.billing[`${siteId}_${ym}`] に書く（app/api/cost と同じ書き方・ドット記法でこのキーだけ）。
 * 原価・収益の画面と経営コックピット（sites[].billing × 1.1 を山岡からの入金予定に使う）が、発行した請求書と同じ額になる。
 */
export async function syncSiteBillingFromInvoice(b: PrimeInvoiceBundle, actor: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(b.siteId)) return
  const key = `${b.siteId}_${b.ym}`
  const docRef = doc(db, 'demmen', 'main')
  const snap = await getDoc(docRef)
  if (!snap.exists()) return
  const data = snap.data() as { billing?: Record<string, number[] | number> }
  const prevRaw = data.billing?.[key]
  const prev = (Array.isArray(prevRaw) ? prevRaw : typeof prevRaw === 'number' ? [prevRaw] : []).filter(v => v !== 0)
  const arr = b.sheets.map(s => Math.round(s.amount)).filter(v => v !== 0)
  await updateDoc(docRef, { [`billing.${key}`]: arr.length > 0 ? arr : [0] })
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)
  if (sum(prev) !== sum(arr) || prev.length !== arr.length || prev.some((v, i) => v !== arr[i])) {
    await logActivity(actor, 'billing.update',
      `${b.siteName} ${jpYmOf(b.ym)}の請求額: ${prev.length ? prev.map(v => v.toLocaleString()).join('+') : '未入力'} → ${arr.map(v => v.toLocaleString()).join('+')}（税抜 ${sum(arr).toLocaleString()}円・山岡への請求書 ${b.no} の発行で自動）`)
  }
}

/** 差し戻し（確認1・確認2のどちらの段でも。事業責任者・代表）または取り下げ（事務・確認1待ちの間だけ）。下書きに戻す（ファイル・内容は残る） */
export async function rejectPrimeInvoice(args: { id: string; actor: string; reason?: string; withdraw?: boolean }): Promise<PrimeResult | PrimeError> {
  const { id, actor, reason, withdraw } = args
  const cur = await getPrimeBundle(id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (withdraw && cur.status !== 'pending') return { ok: false, error: cur.status === 'checked' ? '確認1が済んでいるので取り下げられません（差し戻しを頼んでください）' : '確認1待ちの申請ではありません（すでに処理済みです）' }
  if (!withdraw && cur.status !== 'pending' && cur.status !== 'checked') return { ok: false, error: '確認待ちの申請ではありません（すでに処理済みです）' }
  const now = new Date().toISOString()
  const upd = { status: 'draft' as const, checkedAt: '', checkedBy: '', checkedByName: '', rejectedAt: now, rejectedBy: actor, rejectReason: withdraw ? `取り下げ${reason ? `: ${reason}` : ''}` : (reason || '差し戻し'), updatedAt: now }
  await updateDoc(doc(db, COLLECTION, id), upd)
  await logActivity(actor, withdraw ? 'primeInvoice.withdraw' : 'primeInvoice.reject', `${labelOf(cur)} 一次への請求書の申請を${withdraw ? '取り下げ' : `差し戻し（${cur.status === 'checked' ? '確認2' : '確認1'}の段）`}${reason ? `（${reason}）` : ''}`)
  return { ok: true, record: { ...cur, ...upd } }
}

export async function voidPrimeInvoice(args: { id: string; actor: string; reason?: string }): Promise<PrimeResult | PrimeError> {
  const { id, actor, reason } = args
  const cur = await getPrimeBundle(id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (cur.status === 'void') return { ok: false, error: 'すでに取り消し済みです' }
  if (cur.status !== 'issued') return { ok: false, error: '発行済みの請求書ではありません（確認待ちは差し戻し・取り下げ、下書きは削除で処理してください）' }
  const now = new Date().toISOString()
  const upd = { status: 'void' as const, voidedAt: now, voidedBy: actor, voidReason: reason || '', updatedAt: now }
  await updateDoc(doc(db, COLLECTION, id), upd)
  await logActivity(actor, 'primeInvoice.void', `${labelOf(cur)} 一次への請求書 ${cur.no} を取り消し${reason ? `（${reason}）` : ''}`)
  return { ok: true, record: { ...cur, ...upd } }
}

/** 下書きの削除（記録だけ。ファイルは呼び出し側が消す）。draft のときだけ */
export async function deletePrimeDraft(args: { id: string; actor: string }): Promise<{ ok: true; record: PrimeInvoiceBundle } | PrimeError> {
  const cur = await getPrimeBundle(args.id)
  if (!cur) return { ok: false, error: '請求書が見つかりません' }
  if (cur.status !== 'draft') return { ok: false, error: '下書きのときだけ削除できます（発行済みは取り消しで記録を残します）' }
  await deleteDoc(doc(db, COLLECTION, args.id))
  await logActivity(args.actor, 'primeInvoice.delete', `${labelOf(cur)} 一次への請求書の下書きを削除`)
  return { ok: true, record: cur }
}
