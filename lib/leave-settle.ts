/**
 * 有給精算（日本人の日給月給の人だけ・2026-10-08 代表決定）
 *
 * ■ 何をするものか
 *   稼働の少ない月（お盆・年末年始・雨の多い月など）に、有給の残りを「日数」で給料に回す。
 *   日給月給は働いた日数で給料が決まるので、休みの多い月は手取りが減る。それを有給の残りで補う、
 *   日給月給時代からの慣例を仕組みにしたもの。
 *
 * ■ 法的な位置づけ（ここが大事）
 *   年次有給休暇は「働く義務のある日を休む」制度なので、休みの日に「有給」を入れることはしない。
 *   出面には何も書かず、有給の残りを月ごとに「期中の精算（買取）」として記録する（plData の buyoutHistory・reason = 'monthly-settle'）。
 *   ・年次有給休暇管理簿（法定帳簿）には「取得」として載らない（買取として載る）
 *   ・年5日の取得義務には数えない（数えるのは稼働日に実際に休んだ有給だけ）
 *   法定分の買取にあたるため法的にはグレー。代表が承知のうえで日本人に限って導入した（2026-10-08）。
 *
 * ■ 決まり（代表決定 2026-10-08）
 *   1. 対象: 日本人の日給月給の人だけ（月給の人・役員・外国人は対象外）
 *   2. 年5日の枠を残す: 精算できる日数 ＝ 残数 −（5 − この期に稼働日で取った有給）
 *   3. 期の半分（付与から6か月）を過ぎて年5日に届いていない人は精算できない
 *   4. 月の上限: 出勤＋有給＋0.6補＋試験＋精算 ≦ 24日
 *   5. 本人がマイページから申請 → 政仁さん（最終承認の権限）が承認。承認した時点で残数から引く
 *
 * ■ 名前
 *   明細・帳票では「有給精算手当」。「休暇」「振替」「休業」は法律上の意味がある言葉なので使わない。
 *
 * このファイルは純粋な判定だけ（画面からも読む）。個人の金額は置かない。
 */

/** この月の給与から始める */
export const LEAVE_SETTLE_FROM_YM = '202610'
/** 出勤＋有給＋0.6補＋試験＋精算 の月の上限（日） */
export const LEAVE_SETTLE_MONTH_CAP_DAYS = 24
/** plData の buyoutHistory に記録するときの reason */
export const LEAVE_SETTLE_REASON = 'monthly-settle'
/** 明細・帳票での名前 */
export const LEAVE_SETTLE_LABEL = '有給精算手当'
/** 年5日の取得義務 */
const FIVE_DAYS = 5
/** 年5日に届いていないと精算を止める時期（付与から何か月） */
export const LEAVE_SETTLE_FIVE_DAY_DEADLINE_MONTHS = 6

export type LeaveSettleStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'revoked'

/** leaveSettleRequests コレクションの1件（ドキュメントID = `${workerId}_${ym}`） */
export interface LeaveSettleRequest {
  id: string
  workerId: number
  workerName?: string
  /** 給料に回す月 'YYYYMM' */
  ym: string
  days: number
  status: LeaveSettleStatus
  reason?: string
  requestedAt: string
  decidedAt?: string
  decidedBy?: string
  rejectedReason?: string
  /** 承認時に記録した付与レコードの付与日（取り消しで探すため） */
  grantDate?: string
}

/** 日給月給の日本人か（compute.ts の isJpDaily と同じ判定 ＋ 役員を除く） */
export function isLeaveSettleEligible(w: { visa?: string; salary?: number; rate?: number; job?: string } | undefined | null): boolean {
  if (!w) return false
  const isJp = !w.visa || w.visa === 'none'
  return isJp && !((w.salary ?? 0) > 0) && (w.rate ?? 0) > 0 && w.job !== 'yakuin'
}

/** 年5日のために残しておく日数（付与10日未満は義務の対象外なので0） */
export function fiveDayReserve(grantDays: number, periodTaken: number): number {
  if (grantDays < 10) return 0
  return Math.max(0, FIVE_DAYS - periodTaken)
}

/** 'YYYYMM' → その月の最後の日 'YYYY-MM-DD' */
export function lastDayOfYm(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const d = new Date(y, m, 0).getDate()
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
}

/** 'YYYYMM' の前の月 */
export function prevYm(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, '0')}`
}

/** 'YYYYMM' → '10月' / 年が違えば '2026年10月' */
export function ymLabel(ym: string, todayYm?: string): string {
  const y = ym.slice(0, 4), m = Number(ym.slice(4, 6))
  return todayYm && todayYm.slice(0, 4) !== y ? `${y}年${m}月` : `${m}月`
}

/**
 * その月に「給料が出る日」の日数（出勤・有給・0.6補・試験のどれかがある日。同じ日に2現場でも1日）。
 * 出面 att_YYYYMM の d（キー `{siteId}_{workerId}_{ym}_{day}`）から数える。帰国（hk）だけの日は数えない。
 */
export function countPaidDaysInMonth(
  d: Record<string, unknown>,
  workerId: number,
  ym: string,
): number {
  const seen = new Set<string>()
  const suffix = `_${ym}_`
  const widPart = `_${workerId}${suffix}`
  for (const [k, v] of Object.entries(d)) {
    if (!k.includes(widPart)) continue
    // キーの後ろ3つが wid・ym・day であることを確かめる（現場IDに _ が入っていてもよい）
    const parts = k.split('_')
    if (parts.length < 4) continue
    const day = parts[parts.length - 1]
    if (parts[parts.length - 2] !== ym || parts[parts.length - 3] !== String(workerId)) continue
    const e = v as { w?: number; p?: number; exam?: unknown; hk?: unknown } | null
    if (!e || typeof e !== 'object') continue
    if (e.p || e.exam || ((e.w ?? 0) > 0 && !e.hk)) seen.add(day)
  }
  return seen.size
}

/** 付与レコードの buyoutHistory から、その月の精算日数を数える */
export function settledDaysForYm(
  records: Array<{ buyoutHistory?: Array<{ days?: number; reason?: string; ym?: string }> }> | undefined,
  ym: string,
): number {
  let total = 0
  for (const r of records || []) {
    for (const h of r.buyoutHistory || []) {
      if (h.reason === LEAVE_SETTLE_REASON && h.ym === ym) total += h.days || 0
    }
  }
  return total
}

export interface SettleLimitInput {
  /** 有給の付与があるか */
  hasGrant: boolean
  grantDate: string
  grantDays: number
  /** 残数（承認済みの精算は引いた後） */
  remaining: number
  /** この期に稼働日で取った有給（出面の p） */
  periodTaken: number
  /** ほかに承認待ちの精算（この申請を除く・同じ期） */
  pendingOtherDays: number
  /** その月の給料が出る日（出勤・有給・0.6補・試験） */
  paidDaysInMonth: number
  /** その月にすでに承認済みの精算日数（この申請を除く） */
  settledInMonth: number
  /** 判定する日（今日） */
  todayIso: string
  /** 付与から6か月の日（addMonthsSafe(grantDate, 6)）。呼び出し側で作る（日付計算をここに持ち込まない） */
  fiveDayDeadlineIso: string
}

export interface SettleLimit {
  /** 精算できる日数の上限（0 なら申請できない） */
  maxDays: number
  /** 申請できない理由（maxDays が 0 のとき） */
  blockReason?: string
  /** 内訳（画面の説明用） */
  breakdown: { remainingFree: number; reserve: number; monthRoom: number }
}

/**
 * 精算できる日数の上限を決める（申請・承認とも、この関数1つで判定する）。
 */
export function settleLimit(i: SettleLimitInput): SettleLimit {
  const reserve = fiveDayReserve(i.grantDays, i.periodTaken)
  const remainingFree = Math.max(0, i.remaining - i.pendingOtherDays - reserve)
  const monthRoom = Math.max(0, LEAVE_SETTLE_MONTH_CAP_DAYS - i.paidDaysInMonth - i.settledInMonth)
  const breakdown = { remainingFree, reserve, monthRoom }
  if (!i.hasGrant) return { maxDays: 0, blockReason: '有給がまだ付与されていません', breakdown }
  if (i.grantDays >= 10 && i.periodTaken < FIVE_DAYS && i.todayIso >= i.fiveDayDeadlineIso) {
    return {
      maxDays: 0,
      blockReason: `付与から半年を過ぎても、年5日の有給（現場が稼働している日に休む）が ${i.periodTaken}日 です。あと ${FIVE_DAYS - i.periodTaken}日 取るまで精算はできません`,
      breakdown,
    }
  }
  if (monthRoom <= 0) {
    return { maxDays: 0, blockReason: `この月は出勤・有給などで ${LEAVE_SETTLE_MONTH_CAP_DAYS}日 に達しています`, breakdown }
  }
  if (remainingFree <= 0) {
    return {
      maxDays: 0,
      blockReason: reserve > 0
        ? `残りの有給は、年5日を取るための ${reserve}日 だけです`
        : '有給の残りがありません',
      breakdown,
    }
  }
  return { maxDays: Math.min(remainingFree, monthRoom), breakdown }
}
