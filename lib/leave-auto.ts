import { db } from './firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { MainData, PLRecord, RawWorker } from './compute'
import { isAlreadyRetired } from './workers'
import { calcLegalPL } from './leave-compute'

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
 *   重複実装を削除して共通ヘルパーに委譲
 */
function calcLegalPLDays(hireDate: string, grantDate: Date): number {
  const grantIso = grantDate.toISOString().slice(0, 10)
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
 * Calculate carry-over days from previous grant record.
 * Max carry is 20 days.
 *
 * ⚠️ 2026-05-08 修正:
 *   _archived: true レコード（時効処理済の古いレコード）は前期判定から除外。
 *   旧コードでは archived なレコードでも grantDays > 0 ならば最新FY判定に拾われ、
 *   archived の fy 値が大きい場合に誤った前期を採用するリスクがあった。
 */
function calcCarryOver(existingRecords: PLRecord[]): number {
  if (existingRecords.length === 0) return 0

  // archived（時効処理済み）を除外し、付与実績のあるレコードのみを対象に
  const active = existingRecords.filter(r => !(r as PLRecord & { _archived?: boolean })._archived)
  const withGrant = active.filter(r => (r.grantDays || 0) > 0 || (r.grant || 0) > 0)
  if (withGrant.length === 0) return 0

  // 最新FYを特定
  const maxFy = Math.max(...withGrant.map(r => Number(r.fy)))
  // 同じFYに複数レコードがある場合、grantDateが最も新しいもの（正しいレコード）を採用
  const sameFy = withGrant.filter(r => Number(r.fy) === maxFy)
  const prev = sameFy.reduce((best, r) => {
    const bestDate = best.grantDate || ''
    const rDate = r.grantDate || ''
    return rDate > bestDate ? r : best
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

  // Filter eligible workers: not yet retired, not yakuin, has hireDate
  // 2026-06-XX 修正: 「未来日に退職予定」のスタッフは付与候補に残す
  //   （退職日が入った瞬間に半自動付与対象から外れる旧バグの修正）
  const todayIso = today.toISOString().slice(0, 10)
  const eligible = main.workers.filter(
    (w: RawWorker) => !isAlreadyRetired(w.retired, todayIso) && w.job !== 'yakuin' && w.hireDate
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

    const grantMonth = w.grantMonth

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
