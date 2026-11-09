import 'server-only'
/**
 * MF経費の申請チェックの実行（毎朝の cron と画面の「今すぐチェック」・2026-11-08）。
 * 決まりは lib/mf-expense-rules.ts、MF との通信は lib/mf-expense-client.server.ts。
 *
 * 保存先（docs/firestore.md）:
 *   expenseChecks/{申請ID}   申請ごとの結果（承認待ちから消えたら open=false）
 *   expenseHistory/{YYYYMM}  過去の明細（T3・T4・D2・M1 用の控え）
 *   mfExpense/settings・items・members・reminders・runState
 *
 * MF の応答は**使う項目だけ**を取り出して保存する（従業員の振込口座なども一緒に返ってくるため）。
 * 明細を読むのは新しい・更新された申請だけ。チェックは毎回全部やり直す（出面・道具代・結びつけの修正を反映するため）。
 */
import { db } from '@/lib/firebase'
import { collection, deleteField, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where } from '@/lib/fsdb'
import { getAttData, getAttDataCached, getMainData } from '@/lib/compute.server'
import { isClosedMonthYm, parseDKey, type RawWorker } from '@/lib/compute'
import { wasAtSite } from '@/lib/attendance'
import { isToolBudgetEligible, toolBudgetDefaultFor } from '@/lib/workers'
import { jstIsoOf, jstWallClock, todayJstIso } from '@/lib/date-utils'
import { logActivity } from '@/lib/activity'
import { isJapaneseVisa } from '@/lib/leave-pending'
import type { MfCommentLang } from '@/lib/mf-expense-comment'
import {
  receiptPeriodOf, toolBudgetAnchorOf, toolBudgetCarryIn, type ToolBudgetRecordLike,
} from '@/lib/tool-budget-period'
import { purchasesBudgetUse } from '@/lib/tool-subsidy'
import { MfReconnectError, MfTimeBudgetError, openMfApi, type MfApi } from '@/lib/mf-expense-client.server'
import { MF_RECEIPT_MODEL, isReceiptFatalError, isReceiptReaderConfigured, readReceiptFile } from '@/lib/mf-expense-receipt.server'
import {
  buildMfRouteMinFares, buildMfRouteTable, buildMonthlyReminders, checkExpenseReport, isMfHistoryFresh, isSameMfSubmission, mfConfirmFlagKeys, mfIsReceiptReadCurrent, linkMfMembers, normalizeMfExpenseSettings, shiftYm, summarizeMfApprovals, ymOfIso,
  type MfApprovalStep, type MfExpenseFlag, type MfExpenseReview, type MfExpenseSettings, type MfExpenseTx, type MfHistoryTx, type MfMemberLink,
  type MfRawApproval, type MfRouteTableRow, type MfReceiptRead, type MfReminderEntry, type MfReminderPerson, type MfToolContext,
} from '@/lib/mf-expense-rules'

/** Vercel の関数は 60 秒。余裕を見て 45 秒で区切り、残りは次の回に続ける */
const RUN_BUDGET_MS = 45_000
const RUN_LOCK_MS = 70_000

const SKIP_STATUSES = new Set(['unsubmitted', 'canceled', 'rejected'])

export interface ExpenseCheckDoc {
  reportId: string
  number: number | null
  title: string
  status: string
  submittedIso: string
  /** MF の提出日時そのまま（出し直しの見分け用） */
  submittedAt?: string
  updatedAt: string
  memberId: string
  memberName: string
  workerId: number | null
  total: number
  targetYm: string
  txs: MfExpenseTx[]
  flags: MfExpenseFlag[]
  confirmCount: number
  infoCount: number
  open: boolean
  checkedAt: string
  /** 差し戻しコメントの言語の初期値（結びついた作業員の在留資格から。不明なら日本語） */
  commentLang?: MfCommentLang
  /** MF の承認の段階（チェックのたびに読み直す） */
  approvals?: MfApprovalStep[]
  /** 添付があるのに、まだ読めていない領収書の枚数（0より大きい間は「問題なし」と言わない） */
  receiptPending?: number
  /** 総務の「確認した・理由」。毎朝のチェックでは消さない */
  review?: MfExpenseReview
}

export interface MfExpenseRunState {
  lastRunAt: string | null
  completedDate: string | null
  partial: boolean
  lastError: string | null
  summary: { open: number; flagged: number; fetched: number } | null
  runningUntil?: number
}

export type MfRunResult =
  | { ok: true; status: 'done' | 'partial' | 'skipped'; message: string; summary: MfExpenseRunState['summary'] }
  | { ok: false; status: 'busy' | 'maintenance' | 'notConnected' | 'error'; message: string }

const stateRef = () => doc(db, 'mfExpense', 'runState')

// ────────────────────────────────────────
//  読み書きの小道具
// ────────────────────────────────────────

export async function loadMfSettings(): Promise<MfExpenseSettings> {
  const snap = await getDoc(doc(db, 'mfExpense', 'settings'))
  return normalizeMfExpenseSettings(snap.exists() ? snap.data() : null)
}

export async function saveMfSettings(s: MfExpenseSettings): Promise<void> {
  await setDoc(doc(db, 'mfExpense', 'settings'), s)
}

export async function loadMfItems(): Promise<{ id: string; name: string; active: boolean }[]> {
  const snap = await getDoc(doc(db, 'mfExpense', 'items'))
  return snap.exists() ? ((snap.data().items || []) as { id: string; name: string; active: boolean }[]) : []
}

export async function loadMfMembers(): Promise<Record<string, MfMemberLink>> {
  const snap = await getDoc(doc(db, 'mfExpense', 'members'))
  return snap.exists() ? ((snap.data().members || {}) as Record<string, MfMemberLink>) : {}
}

export async function loadMfReminders(): Promise<MfReminderEntry[]> {
  const snap = await getDoc(doc(db, 'mfExpense', 'reminders'))
  return snap.exists() ? ((snap.data().entries || []) as MfReminderEntry[]) : []
}

export async function loadMfRunState(): Promise<MfExpenseRunState> {
  const snap = await getDoc(stateRef())
  const d = snap.exists() ? snap.data() : {}
  return {
    lastRunAt: d.lastRunAt ?? null,
    completedDate: d.completedDate ?? null,
    partial: d.partial ?? false,
    lastError: d.lastError ?? null,
    summary: d.summary ?? null,
  }
}

export async function loadOpenExpenseChecks(): Promise<ExpenseCheckDoc[]> {
  const snap = await getDocs(query(collection(db, 'expenseChecks'), where('open', '==', true)))
  return snap.docs.map(d => d.data() as ExpenseCheckDoc)
}

/**
 * 要確認の申請に「確認した・理由」を残す。note=null で取り消し。MF には書かない。
 * 開いている要確認の申請だけ受け付け、持ち主の名前を返す（見つからなければ null）
 */
export async function saveExpenseReview(reportId: string, note: string | null, actor: number | 'super-admin' | string): Promise<string | null> {
  const ref = doc(db, 'expenseChecks', reportId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  const cur = snap.data() as ExpenseCheckDoc
  if (!cur.open || !(cur.confirmCount > 0)) return null
  if (note === null) {
    await updateDoc(ref, { review: deleteField() })
    return cur.memberName
  }
  const main = await getMainData()
  const worker = (main.workers as RawWorker[]).find(w => String(w.id) === String(actor))
  const byName = actor === 'super-admin' ? '日比靖仁' : worker?.name || String(actor)
  const review: MfExpenseReview = { note, byName, at: new Date().toISOString(), flagKeys: mfConfirmFlagKeys(cur.flags || []) }
  await updateDoc(ref, { review })
  return cur.memberName
}

/** 1人分の結びつけを人が決める。workerId=null は「作業員ではない」 */
export async function saveMfMemberLink(mfId: string, workerId: number | null): Promise<boolean> {
  const members = await loadMfMembers()
  const cur = members[mfId]
  if (!cur) return false
  await updateDoc(doc(db, 'mfExpense', 'members'), {
    [`members.${mfId}`]: { ...cur, workerId, how: workerId === null ? 'excluded' : 'manual', candidates: [], nameDiffers: false },
  })
  return true
}

/** 第1段階は日比建設の作業員だけ（結びつけの候補も、番号の照合も） */
function hibiWorkers(workers: RawWorker[]): RawWorker[] {
  return workers.filter(w => w.org === '日比' || w.org === 'hibi')
}

/**
 * 結びつけの選択肢。在籍の人に加えて、keepIds（すでに結びついている人）は退職扱いでも含める。
 * 含めないと、番号で正しく結びついているのに選択欄が「選んでください」に見える（2026-11-09）
 */
export async function loadHibiWorkerOptions(keepIds: (number | null)[] = []): Promise<{ id: number; name: string }[]> {
  const main = await getMainData()
  const keep = new Set(keepIds)
  return hibiWorkers(main.workers as RawWorker[])
    .filter(w => !w.retired || keep.has(w.id))
    .map(w => ({ id: w.id, name: w.name }))
    .sort((a, b) => a.id - b.id)
}

// ────────────────────────────────────────
//  MF の応答から、使う項目だけを取り出す
// ────────────────────────────────────────

interface RawMfTx {
  id: string
  recognized_at?: string | null
  value?: number | null
  remark?: string | null
  memo?: string | null
  ex_item_id?: string | null
  ex_item?: { name?: string | null } | null
  mf_file?: { id?: string } | null
  office_member_id?: string | null
  ex_report?: { id?: string | null; status?: string | null } | null
}

interface RawMfReport {
  id: string
  number?: number | null
  title?: string | null
  status?: string | null
  office_member_id?: string | null
  submitted_at?: string | null
  updated_at?: string | null
  ex_report_approvals?: MfRawApproval[] | null
}

const clip = (s: string | null | undefined, max = 200) => (s || '').slice(0, max)
const isoDay = (s: string | null | undefined) => (s ? s.slice(0, 10) : '')

function toTx(t: RawMfTx): MfExpenseTx {
  return {
    id: t.id,
    date: isoDay(t.recognized_at),
    amount: Number(t.value) || 0,
    itemId: t.ex_item_id || '',
    itemName: clip(t.ex_item?.name, 60),
    remark: clip(t.remark),
    memo: clip(t.memo),
    hasFile: !!t.mf_file,
    fileId: t.mf_file?.id || '',
  }
}

function monthRange(ym: string): { from: string; to: string } {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(4, 6))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate() // utc-ok 月の日数を求めるだけ
  const prefix = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`
  return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, '0')}` }
}

async function syncMasters(api: MfApi, workers: RawWorker[]): Promise<Record<string, MfMemberLink>> {
  const items = await api.getAll<{ id: string; name: string; is_active?: boolean }>('v1/offices/{office}/ex_items', 'ex_items')
  // 空の応答で設定を消さない（MF の一時的な異常で、手で決めた内容まで失わないように）
  if (items.length > 0) await setDoc(doc(db, 'mfExpense', 'items'), {
    items: items.map(i => ({ id: i.id, name: i.name, active: i.is_active !== false })),
    syncedAt: new Date().toISOString(),
  })

  const rawMembers = await api.getAll<{ id: string; number?: string | null; name?: string | null; is_active?: boolean }>(
    'v2/offices/{office}/office_members', 'office_members',
  )
  // 振込口座などが一緒に返るが、番号と氏名と在籍だけを残す
  const members = rawMembers.map(m => ({ mfId: m.id, number: m.number || '', name: m.name || '', active: m.is_active !== false }))
  const existing = await loadMfMembers()
  // 従業員が0人の応答はありえない。保存すると手で確定した結びつけが全部消えるので、今のものを使う
  if (members.length === 0) {
    console.error('MF の従業員一覧が空でした。結びつけは更新しません')
    return existing
  }
  const linked = linkMfMembers(members, workers.map(w => ({ id: w.id, name: w.name, payrollNo: w.payrollNo })), existing)
  await setDoc(doc(db, 'mfExpense', 'members'), { members: linked, syncedAt: new Date().toISOString() })
  return linked
}

/**
 * 明細の控えを月ごとに更新する。古い月は1回読めば十分、前月と当月は6時間ごとに読み直す。
 * 毎回読み直すと、それだけで1回の持ち時間（45秒）の大半を使い、申請の読み取りまで届かない（2026-11-09 実データで35秒ほど）。
 * この控えは二重申請や平均との比較に使うだけで、チェックする申請そのものの明細は別に読む
 */
async function syncHistory(api: MfApi, months: string[], hotFrom: string): Promise<MfHistoryTx[]> {
  const rows: MfHistoryTx[] = []
  for (const ym of months) {
    const ref = doc(db, 'expenseHistory', ym)
    const snap = await getDoc(ref)
    if (snap.exists() && isMfHistoryFresh(ym, hotFrom, snap.data().fetchedAt, Date.now())) {
      rows.push(...((snap.data().rows || []) as MfHistoryTx[]))
      continue
    }
    const { from, to } = monthRange(ym)
    const txs = await api.getAll<RawMfTx>('v1/offices/{office}/ex_transactions', 'ex_transactions', {
      'query_object[is_reported]': 'true',
      'query_object[recognized_at_from]': from,
      'query_object[recognized_at_to]': to,
    })
    // 空の応答で控えを上書きしない（古い月は二度と読み直さないので、空のまま固まる）
    if (txs.length === 0) {
      if (snap.exists()) rows.push(...((snap.data().rows || []) as MfHistoryTx[]))
      continue
    }
    const monthRows: MfHistoryTx[] = txs
      .filter(t => t.ex_report?.id && !SKIP_STATUSES.has(t.ex_report.status || ''))
      .map(t => ({
        id: t.id,
        reportId: t.ex_report!.id as string,
        memberId: t.office_member_id || '',
        date: isoDay(t.recognized_at),
        amount: Number(t.value) || 0,
        itemId: t.ex_item_id || '',
        remark: clip(t.remark, 80),
      }))
    await setDoc(ref, { rows: monthRows, fetchedAt: new Date().toISOString() })
    rows.push(...monthRows)
  }
  return rows
}

async function loadWorkDays(months: string[]): Promise<{ days: Map<number, Set<string>>; sites: Map<number, Map<string, Set<string>>> }> {
  const byWorker = new Map<number, Set<string>>()
  const sites = new Map<number, Map<string, Set<string>>>()
  for (const ym of months) {
    // 確定済みの月だけキャッシュを使う（CLAUDE.md「出面ドキュメントは同一リクエスト内で二度読まない」）
    const att = isClosedMonthYm(ym) ? await getAttDataCached(ym) : await getAttData(ym)
    for (const [key, entry] of Object.entries(att.d)) {
      if (!wasAtSite(entry)) continue
      const p = parseDKey(key)
      const wid = Number(p.wid)
      if (!Number.isFinite(wid) || p.ym !== ym) continue
      const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(Number(p.day)).padStart(2, '0')}`
      if (!byWorker.has(wid)) byWorker.set(wid, new Set())
      byWorker.get(wid)!.add(iso)
      if (!sites.has(wid)) sites.set(wid, new Map())
      const perDay = sites.get(wid)!
      if (!perDay.has(iso)) perDay.set(iso, new Set())
      perDay.get(iso)!.add(p.sid)
    }
  }
  return { days: byWorker, sites }
}

interface ToolBudgetDocLike {
  defaultBudget?: number
  budgetByVisa?: Record<string, number>
  budgetByJob?: Record<string, number>
  periodAnchors?: Record<string, string>
  records?: Record<string, ToolBudgetRecordLike & { budget?: number } | undefined>
}

function toolContextFor(w: RawWorker, tb: ToolBudgetDocLike, today: string): MfToolContext {
  const eligible = { visa: w.visa, job: w.job, retired: w.retired, hireDate: w.hireDate }
  const { anchor } = toolBudgetAnchorOf({ id: w.id, visa: w.visa, hireDate: w.hireDate }, tb.periodAnchors)
  const defaultBudget = toolBudgetDefaultFor({ visa: w.visa, job: w.job }, tb)
  const records = tb.records || {}
  return {
    eligibleOn: date => isToolBudgetEligible(eligible, date),
    periodOn: date => {
      if (!anchor) return null
      const r = receiptPeriodOf(anchor, date, today)
      if ('error' in r) return null
      const record = records[`${w.id}_${r.period.start}`]
      const budget = record?.budget ?? defaultBudget
      const carry = toolBudgetCarryIn(anchor, r.period.index, w.id, records, defaultBudget)
      return { periodStart: r.period.start, remaining: budget + carry - purchasesBudgetUse(record?.purchases) }
    },
  }
}

// ────────────────────────────────────────
//  本体
// ────────────────────────────────────────

async function acquireLock(): Promise<boolean> {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef())
    const until = snap.exists() ? (snap.data().runningUntil as number | undefined) : undefined
    if (until && until > Date.now()) return false
    tx.set(stateRef(), { runningUntil: Date.now() + RUN_LOCK_MS }, { merge: true })
    return true
  })
}

// ────────────────────────────────────────
//  領収書の読み取り（lib/mf-expense-receipt.server.ts）
// ────────────────────────────────────────

const RECEIPT_BUDGET_MS = 200_000
const RECEIPT_LOCK_MS = 280_000
const RECEIPT_PARALLEL = 4
/** 1回で読む上限（費用の歯止め。残りは次の回に続ける） */
const RECEIPT_MAX_PER_RUN = 100
const receiptStateRef = () => doc(db, 'mfExpense', 'receiptState')
const receiptDocRef = (reportId: string) => doc(db, 'expenseReceiptReads', reportId)

export interface MfReceiptState {
  configured: boolean
  lastRunAt: string | null
  lastError: string | null
  lastRead: number
  remaining: number
}

export async function loadMfRouteTable(): Promise<Record<string, MfRouteTableRow[]>> {
  const snap = await getDoc(doc(db, 'mfExpense', 'routeTable'))
  return snap.exists() ? ((snap.data().months || {}) as Record<string, MfRouteTableRow[]>) : {}
}

export async function loadMfReceiptState(): Promise<MfReceiptState> {
  const snap = await getDoc(receiptStateRef())
  const d = snap.exists() ? snap.data() : {}
  return {
    configured: isReceiptReaderConfigured(),
    lastRunAt: (d.lastRunAt as string | undefined) ?? null,
    lastError: (d.lastError as string | undefined) ?? null,
    lastRead: (d.lastRead as number | undefined) ?? 0,
    remaining: (d.remaining as number | undefined) ?? 0,
  }
}

async function loadReceiptReads(reportIds: string[]): Promise<Map<string, Record<string, MfReceiptRead>>> {
  const out = new Map<string, Record<string, MfReceiptRead>>()
  await Promise.all(reportIds.map(async id => {
    const snap = await getDoc(receiptDocRef(id))
    if (snap.exists()) out.set(id, (snap.data().reads || {}) as Record<string, MfReceiptRead>)
  }))
  return out
}

export interface MfReceiptRunResult {
  ok: boolean
  status: 'done' | 'notConfigured' | 'maintenance' | 'busy' | 'error'
  message: string
  read: number
  remaining: number
}

export async function runMfReceiptReads(): Promise<MfReceiptRunResult> {
  if (!isReceiptReaderConfigured()) return { ok: true, status: 'notConfigured', message: '領収書を読む鍵がまだ設定されていません', read: 0, remaining: 0 }
  const hour = jstWallClock().getHours()
  if (hour >= 1 && hour < 6) return { ok: false, status: 'maintenance', message: 'MF経費は毎日 1時〜6時はメンテナンス中です', read: 0, remaining: 0 }

  const locked = await runTransaction(db, async tx => {
    const snap = await tx.get(receiptStateRef())
    const until = snap.exists() ? (snap.data().runningUntil as number | undefined) : undefined
    if (until && until > Date.now()) return false
    tx.set(receiptStateRef(), { runningUntil: Date.now() + RECEIPT_LOCK_MS }, { merge: true })
    return true
  })
  if (!locked) return { ok: false, status: 'busy', message: 'いま領収書を読んでいる途中です', read: 0, remaining: 0 }

  let read = 0
  let remaining = 0
  let lastError: string | null = null
  try {
    const deadline = Date.now() + RECEIPT_BUDGET_MS
    const api = await openMfApi(deadline)
    const checks = (await loadOpenExpenseChecks()).sort((a, b) => a.submittedIso.localeCompare(b.submittedIso))
    const reads = await loadReceiptReads(checks.map(c => c.reportId))
    const queue = checks.flatMap(c => c.txs
      .filter(t => {
        if (!t.hasFile) return false
        const done = reads.get(c.reportId)?.[t.id]
        return !mfIsReceiptReadCurrent(t, done)
      })
      .map(t => ({ reportId: c.reportId, txId: t.id, fileId: t.fileId || '' })))
    remaining = queue.length

    let stop = false
    for (let i = 0; i < queue.length && i < RECEIPT_MAX_PER_RUN && !stop && Date.now() < deadline; i += RECEIPT_PARALLEL) {
      await Promise.all(queue.slice(i, i + RECEIPT_PARALLEL).map(async item => {
        try {
          const file = await api.getFile(`v1/offices/{office}/ex_transactions/${encodeURIComponent(item.txId)}/mf_file`)
          const result = await readReceiptFile(file.bytes, file.contentType)
          const saved: MfReceiptRead = {
            fileId: item.fileId, readable: result.readable, date: result.date, amount: result.amount,
            ...(result.reason ? { reason: result.reason } : {}),
            readAt: new Date().toISOString(), model: MF_RECEIPT_MODEL,
          }
          await setDoc(receiptDocRef(item.reportId), { reads: { [item.txId]: saved } }, { merge: true })
          read++
          remaining--
        } catch (e) {
          if (e instanceof MfTimeBudgetError) { stop = true; return }
          lastError = e instanceof Error ? e.message.slice(0, 200) : '領収書を読めませんでした'
          console.error('領収書の読み取りエラー:', e)
          if (e instanceof MfReconnectError || isReceiptFatalError(e)) stop = true
        }
      }))
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message.slice(0, 200) : '領収書を読めませんでした'
  }
  await setDoc(receiptStateRef(), { runningUntil: 0, lastRunAt: new Date().toISOString(), lastError, lastRead: read, remaining }, { merge: true })
  if (lastError && read === 0) return { ok: false, status: 'error', message: lastError, read, remaining }
  return { ok: true, status: 'done', message: `領収書を ${read} 枚読みました${remaining > 0 ? `（残り ${remaining} 枚）` : ''}`, read, remaining }
}

async function runOnce(api: MfApi, deadline: number, today: string): Promise<{ partial: boolean; summary: NonNullable<MfExpenseRunState['summary']> }> {
  const main = await getMainData({ fresh: true })
  const workers = hibiWorkers(main.workers as RawWorker[])
  const workerById = new Map(workers.map(w => [w.id, w]))
  const settings = await loadMfSettings()
  const members = await syncMasters(api, workers)

  const currentYm = ymOfIso(today)
  const prevYm = shiftYm(currentYm, -1)
  // 前月のさらに3か月前まで見る（T3・T4・M1 の「直近3か月」）
  const months = [-4, -3, -2, -1, 0].map(d => shiftYm(currentYm, d))
  const history = await syncHistory(api, months, prevYm)

  const historyByMember = new Map<string, MfHistoryTx[]>()
  for (const h of history) {
    if (!historyByMember.has(h.memberId)) historyByMember.set(h.memberId, [])
    historyByMember.get(h.memberId)!.push(h)
  }

  const { days: workDays, sites: workSites } = await loadWorkDays(months)
  const siteNames = new Map((main.sites as { id: string; name: string }[]).map(s => [s.id, s.name]))
  /** その人の「1日に1現場の日」だけ（T5）。2現場の日はどちらの交通費か分からない */
  const siteOfDayFor = (workerId: number): Record<string, { id: string; name: string }> => {
    const out: Record<string, { id: string; name: string }> = {}
    for (const [iso, set] of Array.from(workSites.get(workerId) || [])) {
      if (set.size !== 1) continue
      const id = Array.from(set)[0]
      out[iso] = { id, name: siteNames.get(id) || id }
    }
    return out
  }
  const loadedYms = new Set(months)
  const tbSnap = await getDoc(doc(db, 'demmen', 'toolBudget'))
  const toolBudget = (tbSnap.exists() ? tbSnap.data() : {}) as ToolBudgetDocLike

  const reports = await api.getAll<RawMfReport>('v1/offices/{office}/approving_ex_reports', 'ex_reports')
  const reportIds = new Set(reports.map(r => r.id))
  const openChecks = await loadOpenExpenseChecks()
  const previous = new Map(openChecks.map(c => [c.reportId, c]))
  const receiptReadsByReport = await loadReceiptReads(reports.map(r => r.id))
  const allHistory = Array.from(historyByMember.values()).flat()
  const routeMinFares = buildMfRouteMinFares(allHistory, settings)
  await setDoc(doc(db, 'mfExpense', 'routeTable'), {
    months: buildMfRouteTable(allHistory, settings, routeMinFares, id => members[id]?.name || '（不明）'),
    updatedAt: new Date().toISOString(),
  })

  let fetched = 0
  let partial = false
  const results: ExpenseCheckDoc[] = []

  for (const r of reports) {
    const updatedAt = r.updated_at || ''
    // 一度一覧から消えて戻ってきた申請は open の読み込みに入らない。確認メモを失わないよう、その申請だけ読む
    let before = previous.get(r.id)
    if (!before) {
      const closed = await getDoc(doc(db, 'expenseChecks', r.id))
      if (closed.exists()) before = closed.data() as ExpenseCheckDoc
    }
    let txs = before && before.updatedAt === updatedAt ? before.txs : null
    let readFailed = false
    if (!txs) {
      if (Date.now() > deadline) { partial = true; continue }
      try {
        const raw = await api.getAll<RawMfTx>(`v1/offices/{office}/ex_reports/${encodeURIComponent(r.id)}/ex_transactions`, 'ex_transactions')
        txs = raw.map(toTx)
        fetched++
      } catch (e) {
        if (e instanceof MfTimeBudgetError) { partial = true; continue }
        if (e instanceof MfReconnectError) throw e
        // 1件の失敗で残りの申請を止めない。その申請は要確認にして、次の回に読み直す
        console.error(`申請 ${r.id} の明細を読めませんでした:`, e)
        txs = before?.txs ?? []
        readFailed = true
      }
    }

    const memberId = r.office_member_id || ''
    const link = members[memberId]
    const worker = link?.workerId != null ? workerById.get(link.workerId) : undefined
    const linkState = link?.how === 'excluded' ? 'excluded' as const : worker ? 'worker' as const : 'pending' as const
    const submittedIso = r.submitted_at ? jstIsoOf(new Date(r.submitted_at)) : today
    const { flags, targetYm } = checkExpenseReport({
      reportId: r.id,
      submittedIso,
      today,
      txs,
      history: historyByMember.get(memberId) || [],
      settings,
      link: linkState,
      workDays: worker ? workDays.get(worker.id) || new Set() : new Set(),
      loadedYms,
      tool: worker ? toolContextFor(worker, toolBudget, today) : null,
      receiptReads: receiptReadsByReport.get(r.id),
      siteOfDay: worker ? siteOfDayFor(worker.id) : undefined,
      routeMinFares,
    })
    if (readFailed) flags.push({ rule: 'X1', level: 'confirm', message: 'この申請の明細を MF から読めませんでした。MF で中身を確かめてください（次のチェックで読み直します）' })
    const reads = receiptReadsByReport.get(r.id) || {}
    const savedTxs = txs.map(({ receipt: _old, ...t }) => {
      const read = t.hasFile ? reads[t.id] : undefined
      return read ? { ...t, receipt: { readable: read.readable, date: read.date, amount: read.amount } } : t
    })

    const check: ExpenseCheckDoc = {
      reportId: r.id,
      number: r.number ?? null,
      title: clip(r.title, 100),
      status: r.status || '',
      submittedIso,
      submittedAt: r.submitted_at || '',
      // 読めなかった申請は、古い明細を使い回さず次の回に読み直す
      updatedAt: readFailed ? '' : updatedAt,
      memberId,
      memberName: link?.name || '（MF の従業員が不明）',
      workerId: worker?.id ?? null,
      total: txs.reduce((s, t) => s + t.amount, 0),
      targetYm,
      txs: savedTxs,
      flags,
      confirmCount: flags.filter(f => f.level === 'confirm').length,
      infoCount: flags.filter(f => f.level === 'info').length,
      receiptPending: isReceiptReaderConfigured() ? txs.filter(t => t.hasFile && !mfIsReceiptReadCurrent(t, reads[t.id])).length : 0,
      open: true,
      checkedAt: new Date().toISOString(),
      approvals: summarizeMfApprovals(r.ex_report_approvals),
      commentLang: worker && !isJapaneseVisa(worker.visa) ? 'vi' : 'ja',
    }
    // merge にして確認メモ（review）をチェックの結果で上書きしない。出し直された申請のメモだけ消す
    const keepReview = isSameMfSubmission(before, { submittedAt: check.submittedAt || '', submittedIso })
    await setDoc(doc(db, 'expenseChecks', r.id), keepReview ? check : { ...check, review: deleteField() }, { merge: true })
    results.push(check)
  }

  // 承認待ちから消えた申請は一覧から外す（時間切れで読めなかった申請は承認待ちに残っているので reportIds に入っている）
  for (const c of openChecks) {
    if (!reportIds.has(c.reportId)) {
      await updateDoc(doc(db, 'expenseChecks', c.reportId), { open: false, closedAt: new Date().toISOString() })
    }
  }

  // M1・M2（月の声かけ）
  const day = Number(today.slice(8, 10))
  let reminders: MfReminderEntry[] = []
  if (day >= settings.m1Day) {
    const people: MfReminderPerson[] = Object.values(members)
      .filter(m => m.active && m.workerId != null && m.how !== 'excluded')
      .map(m => {
        const mine = historyByMember.get(m.mfId) || []
        const yms = new Set(mine.map(h => ymOfIso(h.date)))
        const days = workDays.get(m.workerId as number) || new Set<string>()
        return {
          memberId: m.mfId,
          name: m.name,
          workDays: Array.from(days).filter(d => ymOfIso(d) === prevYm).length,
          filed: yms.has(prevYm),
          recentMonths: [-1, -2, -3].filter(b => yms.has(shiftYm(prevYm, b))).length,
        }
      })
    let rejected: { memberId: string; name: string; title: string }[] = []
    let rejectedReadFailed = false
    if (day >= settings.m2Day) {
      try {
        const recent = await api.getAll<RawMfReport>('v1/offices/{office}/expense_reports', 'expense_reports', {
          'query_object[submitted_at_from]': monthRange(prevYm).from,
        })
        rejected = recent
          .filter(r => r.status === 'rejected')
          .map(r => ({ memberId: r.office_member_id || '', name: members[r.office_member_id || '']?.name || '（不明）', title: clip(r.title, 100) }))
      } catch (e) {
        if (e instanceof MfTimeBudgetError || e instanceof MfReconnectError) throw e
        // 声かけの一部が読めないだけで、朝のチェック全体を失敗にしない
        console.error('差し戻しの一覧を読めませんでした:', e)
        rejectedReadFailed = true
      }
    }
    reminders = buildMonthlyReminders({ today, settings, people, rejected })
    if (rejectedReadFailed) reminders.push({ rule: 'M2', level: 'info', memberId: '', name: '確認できません', message: '差し戻したままの申請を MF から読み取れませんでした。MF の画面で確かめてください' })
  }
  await setDoc(doc(db, 'mfExpense', 'reminders'), { entries: reminders, updatedAt: new Date().toISOString() })

  return {
    partial,
    summary: { open: results.length, flagged: results.filter(c => c.confirmCount > 0).length, fetched },
  }
}

export async function runMfExpenseCheck(opts: { actor: string; force: boolean }): Promise<MfRunResult> {
  const today = todayJstIso()
  // MF は毎日 1:00〜6:00 がメンテナンス
  const hour = jstWallClock().getHours()
  if (hour >= 1 && hour < 6) return { ok: false, status: 'maintenance', message: 'MF経費は毎日 1時〜6時はメンテナンス中です。6時以降にもう一度押してください' }

  const state = await loadMfRunState()
  if (!opts.force && state.completedDate === today) return { ok: true, status: 'skipped', message: '今日のチェックは終わっています', summary: state.summary }

  if (!(await acquireLock())) return { ok: false, status: 'busy', message: 'いまチェックの途中です。少し待ってからもう一度押してください' }

  const deadline = Date.now() + RUN_BUDGET_MS
  const finish = async (patch: Partial<MfExpenseRunState>) => {
    await setDoc(stateRef(), { ...patch, lastRunAt: new Date().toISOString(), runningUntil: 0 }, { merge: true })
  }

  try {
    const api = await openMfApi(deadline)
    const { partial, summary } = await runOnce(api, deadline, today)
    await finish({ completedDate: partial ? state.completedDate : today, partial, lastError: null, summary })
    await logActivity(opts.actor, 'mf-expense', `申請チェック: 承認待ち${summary.open}件・要確認あり${summary.flagged}件・新しく読んだ${summary.fetched}件${partial ? '（途中まで）' : ''}`)
    return {
      ok: true,
      status: partial ? 'partial' : 'done',
      message: partial ? '申請が多く途中で区切りました。もう一度押すと続きをチェックします' : `チェックしました（承認待ち ${summary.open} 件）`,
      summary,
    }
  } catch (e) {
    if (e instanceof MfTimeBudgetError) {
      await finish({ partial: true, lastError: null })
      return { ok: true, status: 'partial', message: '読み込みに時間がかかり途中で区切りました。もう一度押すと続きをチェックします', summary: state.summary }
    }
    const message = e instanceof Error ? e.message : 'チェックに失敗しました'
    await finish({ lastError: message })
    await logActivity(opts.actor, 'mf-expense', `申請チェック失敗: ${message}`)
    return { ok: false, status: e instanceof MfReconnectError ? 'notConnected' : 'error', message }
  }
}
