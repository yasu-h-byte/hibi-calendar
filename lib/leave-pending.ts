/**
 * 有給の「付与待ち」（半自動付与の対象）の判定（2026-10-02 総合点検で app/api/leave/route.ts から切り出し）。
 *
 * 休暇管理の付与待ち一覧（/api/leave getPendingGrants）・まとめて付与の検証（executePendingGrants）・
 * 通知ベルの付与予定（lib/leave-auto.ts getUpcomingGrants）が同じ決まりで日付と日数を出す。
 *   旧: 通知ベルは外国人を入社日の応当日（calcNextGrantDate）で、休暇管理は前回付与日+1年で出していて、
 *       付与日が応当日とずれている人は日付が食い違った。まとめて付与は日本人の「みなし勤続」を見ずに
 *       検証していたため、10/1 の人の正しい日数（梶原さん 2027-10-01 の16日など）を法定超として拒否した。
 *
 * 決まり（docs/paid-leave.md）:
 *   - 日本人: 初回は入社6ヶ月後、その後は前回付与日から1年（jpNextGrantAfter）。10/1 の人は 10/1 のまま。
 *     付与の記録が無い古い入社の人は、今続いている期の付与日を目安にする（jpExpectedGrantWithoutRecords）
 *   - 外国人: 初回は入社6ヶ月後、その後は前回付与日から1年
 *   - 付与日の30日前から対象（leadDays）。付与日を過ぎた未付与は何日過ぎていても対象のまま
 */
import { addMonthsSafe, addDaysIso } from './date-utils'
import { isAlreadyRetired } from './workers'
import { calcLegalPL, jpNextGrantAfter, jpExpectedGrantWithoutRecords, grantPeriodsOverlap, validateGrantInput } from './leave-compute'

export interface PendingGrantWorker {
  id: number
  name: string
  retired?: string
  job?: string
  visa?: string
  hireDate?: string
}

export interface PendingGrantRecord {
  fy?: string | number
  grantDate?: string
  grantDays?: number
  grant?: number
  carryOver?: number
  carry?: number
  adjustment?: number
  adj?: number
}

export interface PendingGrant {
  workerId: number
  name: string
  visa: string
  hireDate: string
  tenureText: string
  nextGrantDate: string
  fy: string
  legalDays: number
  /** 法定日数の勤続計算に使った日（10/1 へ前倒しした日本人は本来の付与日） */
  deemedDate: string
  reason: string
  needsAttention: boolean  // hireDate未登録など、手動確認が必要なフラグ
  attentionNote?: string
}

/** アラート表示の事前通知ウィンドウ: 付与日の 30日前 から通知開始 */
export const PENDING_GRANT_LEAD_DAYS = 30

export function isJapaneseVisa(visa?: string | null): boolean {
  return !visa || visa === 'none'
}

/** 在籍月数テキスト */
function tenureTextOf(hireDate: string, at: string): string {
  if (!hireDate) return '入社日未登録'
  const h = /^(\d{4})-(\d{2})-(\d{2})/.exec(hireDate)
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(at)
  if (!h || !a) return '入社日未登録'
  let months = (Number(a[1]) - Number(h[1])) * 12 + (Number(a[2]) - Number(h[2]))
  if (Number(a[3]) < Number(h[3])) months -= 1
  if (months < 0) return '入社前'
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `在籍 ${m}ヶ月`
  if (m === 0) return `在籍 ${y}年`
  return `在籍 ${y}年${m}ヶ月`
}

const hasGrant = (r: PendingGrantRecord) => (r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0

/** 付与日（無い古い日本人の記録は fy の 10/1） */
const effGrantDate = (r: PendingGrantRecord): string =>
  r.grantDate || (r.fy !== undefined && r.fy !== null ? `${r.fy}-10-01` : '')

/**
 * 付与時期を迎えているが未付与のスタッフ一覧。
 * @param todayIso 日本時間の今日（YYYY-MM-DD）
 */
export function listPendingGrants(
  workers: PendingGrantWorker[],
  plData: Record<string, PendingGrantRecord[]>,
  todayIso: string,
  opts: { leadDays?: number } = {},
): PendingGrant[] {
  const leadDays = opts.leadDays ?? PENDING_GRANT_LEAD_DAYS
  const isWithinAlertWindow = (grantDateStr: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(grantDateStr)) return false
    return addDaysIso(grantDateStr, -leadDays) <= todayIso
  }
  const y = Number(todayIso.slice(0, 4))
  const m = Number(todayIso.slice(5, 7))
  const currentFyStart = m >= 10 ? y : y - 1
  const fyGrantDate = `${currentFyStart}-10-01`

  // 「付与判定」: 既存レコードの付与期間と重なる（grantPeriodsOverlap）か、grantDate が欠落していても fy が一致すれば付与済み
  const hasGrantForExpected = (records: PendingGrantRecord[], expectedFy: string, expectedGrantDate: string): boolean =>
    records.some(r => {
      if (!hasGrant(r)) return false
      if (r.grantDate) return grantPeriodsOverlap(r.grantDate, expectedGrantDate)
      return String(r.fy) === expectedFy
    })

  const pending: PendingGrant[] = []
  for (const w of workers) {
    // 今日時点で退職済みのみ除外（未来日退職予定者は付与対象）
    if (isAlreadyRetired(w.retired, todayIso)) continue
    if (w.job === 'yakuin' || w.job === 'jimu') continue
    const records = plData[String(w.id)] || []
    const hirePlus6 = w.hireDate ? addMonthsSafe(w.hireDate, 6) || null : null

    if (isJapaneseVisa(w.visa)) {
      const latestGrant = records.filter(hasGrant).map(effGrantDate).filter(Boolean).sort().slice(-1)[0] || null
      let expectedGrantDate: string
      let expectedFy: string
      let reason: string
      let deemedDateForDays: string
      if (!latestGrant) {
        const exp = hirePlus6 ? jpExpectedGrantWithoutRecords(w.hireDate!, todayIso) : null
        if (exp) {
          expectedGrantDate = exp.grantDate
          expectedFy = expectedGrantDate.slice(0, 4)
          reason = exp.catchUp
            ? `付与の記録なし（入社6ヶ月後 ${hirePlus6} から1年ごとの直近の付与日を目安）`
            : '初回付与（入社6ヶ月経過）'
        } else {
          expectedGrantDate = fyGrantDate
          expectedFy = String(currentFyStart)
          reason = `初回付与（入社日が未登録のため ${expectedGrantDate} を目安）`
        }
        deemedDateForDays = expectedGrantDate
      } else {
        const next = jpNextGrantAfter(latestGrant, w.hireDate || undefined)
        expectedGrantDate = next.grantDate
        expectedFy = expectedGrantDate.slice(0, 4)
        deemedDateForDays = next.deemedDate
        reason = `前回付与（${latestGrant}）から1年`
      }
      // 「未付与」= expectedGrantDate 以降の付与レコードが無いこと
      const alreadyGranted = records.some(r => hasGrant(r) && effGrantDate(r) >= expectedGrantDate)
      if (isWithinAlertWindow(expectedGrantDate) && !alreadyGranted) {
        const hasHire = !!w.hireDate
        pending.push({
          workerId: w.id,
          name: w.name,
          visa: w.visa || 'none',
          hireDate: w.hireDate || '',
          tenureText: tenureTextOf(w.hireDate || '', expectedGrantDate),
          nextGrantDate: expectedGrantDate,
          fy: expectedFy,
          legalDays: hasHire ? calcLegalPL(w.hireDate!, deemedDateForDays) : 10,
          deemedDate: deemedDateForDays,
          reason,
          needsAttention: !hasHire,
          attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
        })
      }
      continue
    }

    // 外国人: 最新 grantDate + 1年
    const withGrant = records.filter(r => r.grantDate && hasGrant(r)).slice()
      .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))
    const lastRec = withGrant[withGrant.length - 1]
    if (!lastRec) {
      // 初回付与候補: hireDate + 6ヶ月、ただし30日前から事前通知
      if (w.hireDate && hirePlus6 && isWithinAlertWindow(hirePlus6)) {
        pending.push({
          workerId: w.id,
          name: w.name,
          visa: w.visa || '',
          hireDate: w.hireDate,
          tenureText: tenureTextOf(w.hireDate, hirePlus6),
          nextGrantDate: hirePlus6,
          fy: hirePlus6.slice(0, 4),
          legalDays: calcLegalPL(w.hireDate, hirePlus6),
          deemedDate: hirePlus6,
          reason: '初回付与（入社6ヶ月経過）',
          needsAttention: false,
        })
      }
      continue
    }
    const nextGrantStr = addMonthsSafe(lastRec.grantDate!, 12)  // 1年後の応当日（うるう日入社は2/28）
    if (!nextGrantStr) continue
    const nextFy = nextGrantStr.slice(0, 4)
    if (isWithinAlertWindow(nextGrantStr) && !hasGrantForExpected(records, nextFy, nextGrantStr)) {
      const hasHire = !!w.hireDate
      pending.push({
        workerId: w.id,
        name: w.name,
        visa: w.visa || '',
        hireDate: w.hireDate || '',
        tenureText: tenureTextOf(w.hireDate || '', nextGrantStr),
        nextGrantDate: nextGrantStr,
        fy: nextFy,
        legalDays: hasHire ? calcLegalPL(w.hireDate!, nextGrantStr) : 10,
        deemedDate: nextGrantStr,
        reason: `前回付与(${lastRec.grantDate})から1年経過`,
        needsAttention: !hasHire,
        attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
      })
    }
  }
  return pending
}

/**
 * まとめて付与（executePendingGrants）の1件の検証。
 * 付与待ち一覧が出した日数（日本人はみなし勤続）を、そのまま実行して通ることをこの関数で保証する
 * （__tests__/leavePendingRoundTrip.test.ts）。
 */
export function validateGrantForExecution(
  g: { workerId: number; grantDate?: string; grantDays: number },
  worker: { hireDate?: string; visa?: string } | undefined,
): ReturnType<typeof validateGrantInput> {
  return validateGrantInput({
    grantDays: Number(g.grantDays) || 0,
    hireDate: worker?.hireDate,
    grantDate: g.grantDate || undefined,
    isJapanese: isJapaneseVisa(worker?.visa),
  })
}
