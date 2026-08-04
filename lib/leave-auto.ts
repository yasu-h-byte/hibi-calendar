import { MainData, PLRecord, RawWorker } from './compute'
import { isAlreadyRetired } from './workers'
import { calcLegalPL } from './leave-compute'

/**
 * ⚠️ 2026-08-04 有給システム総点検での整理:
 *   旧 `checkAndGrantPL`（全自動付与）と旧 `calcCarryOver` はこのファイルから削除した。
 *   - checkAndGrantPL は呼び出し元ゼロの休眠コードだったが、繰越計算が出面の実消化を
 *     完全に無視し（stale な used フィールドだけで計算）、上限も法定FIFO（前期付与分まで）
 *     でなく一律20日だった。さらに plData 全体を丸ごと updateDoc しており、
 *     将来誰かが呼ぶと「余分に付与 + 他ワーカーの巻き添え上書き」の二重事故になる状態だった。
 *   - 実際の付与は app/api/leave/route.ts の getPendingGrants / executePendingGrants
 *     （半自動付与）に一本化されている。全自動付与を復活させる場合は必ずそちらの
 *     calcCarryOverForWorker（出面ベース + calcLegalCarryOver）を使うこと。
 */

/**
 * Get current date in JST (Asia/Tokyo).
 * Returns a Date object adjusted to JST.
 */
function getJSTDate(): Date {
  const now = new Date()
  // Convert to JST by using toLocaleDateString with timezone
  const jstStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) // YYYY-MM-DD
  return new Date(jstStr + 'T00:00:00')
}

/**
 * Calculate legal PL days based on years of service at grant date.
 * 2026-06-XX 修正 (MI-1): lib/leave-compute.ts の calcLegalPL に統合
 * 2026-08-04 修正: toISOString はUTC変換で JST 環境だと日付が1日ズレるため、
 *   ローカル日付のまま文字列化する
 */
function calcLegalPLDays(hireDate: string, grantDate: Date): number {
  const grantIso = `${grantDate.getFullYear()}-${String(grantDate.getMonth() + 1).padStart(2, '0')}-${String(grantDate.getDate()).padStart(2, '0')}`
  return calcLegalPL(hireDate, grantIso)
}

/**
 * Calculate the next PL grant date for a worker.
 *
 * Logic:
 * - First grant: hireDate + 6 months
 * - Subsequent grants: every 12 months after the first grant
 * - If worker has a custom grantMonth, use that month instead of the hire anniversary month.
 *   The day stays from the hire date.
 */
export function calcNextGrantDate(
  hireDate: string,
  grantMonth: number | undefined,
  existingRecords: PLRecord[]
): Date | null {
  const hire = new Date(hireDate)
  if (isNaN(hire.getTime())) return null

  const hireDay = hire.getDate()

  // First grant date: hire + 6 months
  const firstGrantDate = new Date(hire.getFullYear(), hire.getMonth() + 6, hireDay)

  // If custom grantMonth is set, adjust the first grant to use that month
  // but keep the day from hireDate
  let effectiveFirstGrant: Date
  if (grantMonth) {
    // grantMonth is 1-12
    const gm = grantMonth - 1 // 0-indexed
    // Find the first occurrence of grantMonth that is >= hireDate + 6 months
    let candidateYear = firstGrantDate.getFullYear()
    let candidate = new Date(candidateYear, gm, hireDay)
    if (candidate < firstGrantDate) {
      candidateYear++
      candidate = new Date(candidateYear, gm, hireDay)
    }
    effectiveFirstGrant = candidate
  } else {
    effectiveFirstGrant = firstGrantDate
  }

  // Determine grant month/day for subsequent grants
  const grantMonthIdx = effectiveFirstGrant.getMonth() // 0-indexed
  const grantDay = hireDay

  // Find all existing grant dates to determine what has already been granted
  const existingGrantDates = existingRecords
    .filter(r => r.grantDate && ((r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0)))
    .map(r => new Date(r.grantDate))
    .filter(d => !isNaN(d.getTime()))

  // Iterate through possible grant dates starting from the first
  const today = getJSTDate()
  let currentGrant = effectiveFirstGrant
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 1年以上前の付与日はスキップ（レコードがなくても付与済みとみなす）
    const oneYearAgo = new Date(today)
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
    if (currentGrant < oneYearAgo) {
      currentGrant = new Date(
        currentGrant.getFullYear() + 1,
        grantMonthIdx,
        grantDay
      )
      continue
    }

    // Check if this grant date has already been granted
    const alreadyGranted = existingGrantDates.some(d =>
      d.getFullYear() === currentGrant.getFullYear() &&
      d.getMonth() === currentGrant.getMonth() &&
      d.getDate() === currentGrant.getDate()
    )

    // 同じ年（付与日の年）に既に付与されているかチェック
    const grantYear = currentGrant.getFullYear()
    const yearAlreadyGranted = existingGrantDates.some(d =>
      d.getFullYear() === grantYear
    )

    if (!alreadyGranted && !yearAlreadyGranted) {
      return currentGrant
    }

    // Move to the next year's grant
    currentGrant = new Date(
      currentGrant.getFullYear() + 1,
      grantMonthIdx,
      grantDay
    )

    // Safety: don't look more than 30 years ahead
    if (currentGrant.getFullYear() - hire.getFullYear() > 30) {
      return null
    }
  }
}

/**
 * Get upcoming PL grant dates within the next N days.
 * Used for dashboard notifications.
 */
export interface UpcomingGrant {
  workerId: number
  name: string
  grantDate: Date
  days: number
  carryOver: number
  total: number
  yearsOfService: string
}

export function getUpcomingGrants(
  main: MainData,
  withinDays: number = 7
): UpcomingGrant[] {
  const today = getJSTDate()
  const upcoming: UpcomingGrant[] = []

  // 2026-06-XX 修正: 未来日退職予定者を通知対象に含める（退職日まで付与され続けるため）
  const todayIso = today.toISOString().slice(0, 10)
  const eligible = main.workers.filter(
    (w: RawWorker) => !isAlreadyRetired(w.retired, todayIso) && w.job !== 'yakuin' && w.hireDate
  )

  for (const w of eligible) {
    const wKey = String(w.id)
    const records = (main.plData[wKey] || []) as PLRecord[]
    const grantMonth = w.grantMonth

    const nextGrant = calcNextGrantDate(w.hireDate, grantMonth, records)
    if (!nextGrant) continue

    const diffMs = nextGrant.getTime() - today.getTime()
    const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000))

    // 過去の付与日（まだ付与されていない分）も含む: diffDays >= -30
    // 未来30日以内も含む
    if (diffDays >= -30 && diffDays <= withinDays) {
      const legalDays = calcLegalPLDays(w.hireDate, nextGrant)
      if (legalDays <= 0) continue

      // 繰越の正確な値は出面データが必要（この関数は同期・軽量が前提のため計算しない）。
      // 表示に使う notifications 側が calcLegalCarryOver + 出面で再計算して上書きする。
      // 前期レコードが無い（初回付与）ケースでは 0 がそのまま正しい値になる。
      const carryOver = 0

      // 勤続年数
      const hire = new Date(w.hireDate)
      const diffMonths = (nextGrant.getFullYear() - hire.getFullYear()) * 12
        + (nextGrant.getMonth() - hire.getMonth())
      const years = Math.floor(diffMonths / 12)
      const months = diffMonths % 12
      const yearsOfService = `${years}年${months}ヶ月`

      upcoming.push({
        workerId: w.id,
        name: w.name,
        grantDate: nextGrant,
        days: legalDays,
        carryOver,
        total: legalDays + carryOver,
        yearsOfService,
      })
    }
  }

  return upcoming
}
