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

  const diffMs = grantDate.getTime() - hire.getTime()
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000)

  if (diffYears < 0.5) return 0
  if (diffYears < 1.5) return 10
  if (diffYears < 2.5) return 11
  if (diffYears < 3.5) return 12
  if (diffYears < 4.5) return 14
  if (diffYears < 5.5) return 16
  if (diffYears < 6.5) return 18
  return 20
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
    .filter(r => r.grantDate && r.grantDays > 0)
    .map(r => new Date(r.grantDate))
    .filter(d => !isNaN(d.getTime()))

  // Iterate through possible grant dates starting from the first
  let currentGrant = effectiveFirstGrant
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check if this grant date has already been granted
    const alreadyGranted = existingGrantDates.some(d =>
      d.getFullYear() === currentGrant.getFullYear() &&
      d.getMonth() === currentGrant.getMonth() &&
      d.getDate() === currentGrant.getDate()
    )

    // Also check by FY (the year of the grant date)
    const grantFy = String(currentGrant.getFullYear())
    const fyAlreadyGranted = existingRecords.some(
      r => String(r.fy) === grantFy && r.grantDays > 0
    )

    if (!alreadyGranted && !fyAlreadyGranted) {
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

  // Find the most recent record by fy (descending)
  const sorted = [...existingRecords]
    .filter(r => r.grantDays > 0)
    .sort((a, b) => Number(b.fy) - Number(a.fy))

  if (sorted.length === 0) return 0

  const prev = sorted[0]
  const prevTotal = (prev.grantDays || 0) + (prev.carryOver || 0)
  const prevUsed = (prev.adjustment || 0) + (prev.used || 0)
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

      // Double-check: don't grant if there's already a record for this FY with grantDays > 0
      const existingFy = records.find(r => String(r.fy) === fy && r.grantDays > 0)
      if (existingFy) continue

      // Add to existing records or create new
      const fyIdx = records.findIndex(r => String(r.fy) === fy)
      if (fyIdx >= 0) {
        // There's a record for this FY but with 0 grantDays (e.g. carry-over only)
        records[fyIdx] = { ...records[fyIdx], ...newRecord, carryOver: records[fyIdx].carryOver || carry }
      } else {
        records.push(newRecord)
      }

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
export function getUpcomingGrants(
  main: MainData,
  withinDays: number = 7
): { workerId: number; name: string; grantDate: Date; days: number }[] {
  const today = getJSTDate()
  const upcoming: { workerId: number; name: string; grantDate: Date; days: number }[] = []

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

    // Only include future grants within the specified window
    if (diffDays >= 0 && diffDays <= withinDays) {
      const legalDays = calcLegalPLDays(w.hireDate, nextGrant)
      if (legalDays > 0) {
        upcoming.push({
          workerId: w.id,
          name: w.name,
          grantDate: nextGrant,
          days: legalDays,
        })
      }
    }
  }

  return upcoming
}
