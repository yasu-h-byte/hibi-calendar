import { db } from './firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { MainData, PLRecord, RawWorker } from './compute'

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
 */
function calcLegalPLDays(hireDate: string, grantDate: Date): number {
  const hire = new Date(hireDate)
  if (isNaN(hire.getTime())) return 0

  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grantDate.getFullYear() - hire.getFullYear()) * 12
    + (grantDate.getMonth() - hire.getMonth())
    + (grantDate.getDate() >= hire.getDate() ? 0 : -1)

  if (diffMonths < 6) return 0    // 0.5年未満
  if (diffMonths < 18) return 10   // 0.5年〜1.5年未満
  if (diffMonths < 30) return 11   // 1.5年〜2.5年未満
  if (diffMonths < 42) return 12   // 2.5年〜3.5年未満
  if (diffMonths < 54) return 14   // 3.5年〜4.5年未満
  if (diffMonths < 66) return 16   // 4.5年〜5.5年未満
  if (diffMonths < 78) return 18   // 5.5年〜6.5年未満
  return 20                         // 6.5年以上
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
 * Calculate carry-over days from previous grant record.
 * Max carry is 20 days.
 */
function calcCarryOver(existingRecords: PLRecord[]): number {
  if (existingRecords.length === 0) return 0

  // Find the most recent FY with grant data
  const withGrant = existingRecords.filter(r => (r.grantDays || 0) > 0 || (r.grant || 0) > 0)
  if (withGrant.length === 0) return 0

  // 最新FYを特定
  const maxFy = Math.max(...withGrant.map(r => Number(r.fy)))
  // 同じFYに複数レコードがある場合、adjustmentが最大のもの（実データ）を採用
  const sameFy = withGrant.filter(r => Number(r.fy) === maxFy)
  const prev = sameFy.reduce((best, r) => {
    const bestAdj = (best.adjustment || best.adj || 0)
    const rAdj = (r.adjustment || r.adj || 0)
    return rAdj > bestAdj ? r : best
  })

  const prevTotal = (prev.grantDays || prev.grant || 0) + (prev.carryOver || prev.carry || 0)
  const prevUsed = (prev.adjustment || prev.adj || 0) + (prev.used || 0)
  const prevRemaining = Math.max(0, prevTotal - prevUsed)

  return Math.min(prevRemaining, 20)
}

export interface AutoGrantResult {
  workerId: number
  name: string
  days: number
  grantDate: string
  carry: number
}

/**
 * Check all eligible workers and auto-grant PL if their grant date has arrived.
 *
 * Returns a list of workers who were auto-granted in this call.
 */
export async function checkAndGrantPL(main: MainData): Promise<AutoGrantResult[]> {
  const today = getJSTDate()
  const results: AutoGrantResult[] = []

  // Filter eligible workers: not retired, not yakuin, has hireDate
  const eligible = main.workers.filter(
    (w: RawWorker) => !w.retired && w.job !== 'yakuin' && w.hireDate
  )

  const plData = { ...main.plData } as Record<string, PLRecord[]>
  let hasChanges = false

  for (const w of eligible) {
    const wKey = String(w.id)
    const records = plData[wKey] || []

    // 旧アプリのデータ（grantDateなし）を持つスタッフはスキップ
    // 管理画面から手動で付与・更新する
    const hasOldRecords = records.some(r =>
      ((r.grant && r.grant > 0) || (r.adj != null) || (r.carry != null)) && !r.grantDate
    )
    if (hasOldRecords) continue

    const grantMonth = (w as unknown as { grantMonth?: number }).grantMonth

    const nextGrant = calcNextGrantDate(w.hireDate, grantMonth, records)
    if (!nextGrant) continue

    // Check if today >= next grant date
    if (today >= nextGrant) {
      const legalDays = calcLegalPLDays(w.hireDate, nextGrant)
      if (legalDays <= 0) continue

      const carry = calcCarryOver(records)

      const grantDateStr = `${nextGrant.getFullYear()}-${String(nextGrant.getMonth() + 1).padStart(2, '0')}-${String(nextGrant.getDate()).padStart(2, '0')}`
      const fy = String(nextGrant.getFullYear())

      const newRecord: PLRecord = {
        fy,
        grantDate: grantDateStr,
        grantDays: legalDays,
        carryOver: carry,
        adjustment: 0,
        used: 0,
      }

      // 同じ付与日が既にあればスキップ（FYではなく付与日でチェック）
      const existingGrant = records.find(r => r.grantDate === grantDateStr)
      if (existingGrant) continue

      // Add new record (don't overwrite existing records)
      records.push(newRecord)

      plData[wKey] = records
      hasChanges = true

      results.push({
        workerId: w.id,
        name: w.name,
        days: legalDays,
        grantDate: grantDateStr,
        carry,
      })
    }
  }

  // Write to Firestore if any changes
  if (hasChanges) {
    const docRef = doc(db, 'demmen', 'main')
    await updateDoc(docRef, { plData })
  }

  return results
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

  const eligible = main.workers.filter(
    (w: RawWorker) => !w.retired && w.job !== 'yakuin' && w.hireDate
  )

  for (const w of eligible) {
    const wKey = String(w.id)
    const records = (main.plData[wKey] || []) as PLRecord[]
    const grantMonth = (w as unknown as { grantMonth?: number }).grantMonth

    const nextGrant = calcNextGrantDate(w.hireDate, grantMonth, records)
    if (!nextGrant) continue

    const diffMs = nextGrant.getTime() - today.getTime()
    const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000))

    // 過去の付与日（まだ付与されていない分）も含む: diffDays >= -30
    // 未来30日以内も含む
    if (diffDays >= -30 && diffDays <= withinDays) {
      const legalDays = calcLegalPLDays(w.hireDate, nextGrant)
      if (legalDays <= 0) continue

      // 繰越計算: 前回レコードの残日数
      const carryOver = Math.min(20, calcCarryOver(records))

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
