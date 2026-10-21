/**
 * ベトナム人スタッフの給与計算（法令準拠。法定休日・深夜・休業の各手当を自動計上）
 * 2026-10-21 総点検で lib/compute.ts から分離。計算の中身は変えていない。
 */
import { COMP_FULL_WITHIN_GUARANTEE_FROM_YM, RawSite, ceilYen, floorYen } from './compute'
import { AttendanceEntry, calcActualHours, calcDayShiftHours, calcNightShiftHours, getNightRange, timeToMinutes } from '@/types'

// ────────────────────────────────────────
//  ベトナム人スタッフ給与計算（新ルール、法令準拠）
//  2026-05-13 追加: 法定休日・深夜・休業の各手当を自動計上
// ────────────────────────────────────────

export interface VietnameseSalaryResult {
  // 時間集計
  actualWorkHours: number       // 全実労働時間（法定休日含む）
  regularHours: number          // 日曜以外の実労働時間
  legalHolidayHours: number     // 日曜の実労働時間
  nightHours: number            // 22:00〜5:00 と重なる労働時間

  // 日数集計
  regularWorkDays: number       // 日曜出勤・補償日を除いた出勤日数（追加所定の対象）
  legalHolidayDays: number      // 日曜出勤日数
  absentDays: number            // 欠勤日数
  guaranteeDays: number         // 欠勤控除の基準日数 = min(baseDays, カレンダー所定日数)（2026-09-13）
  compInGuaranteeDays: number   // 保証枠の中で100%支給にした補償日数（2026-08分〜。休業手当60%の対象外）

  // 残業内訳（3層判定: regular内）
  dailyStatutoryOT: number
  weeklyStatutoryOT: number
  monthlyStatutoryOT: number
  statutoryOT: number           // 合計
  legalLimit: number            // 月の法定上限時間

  // 支給項目
  fixedBasePay: number          // 1. 基本給（固定）
  additionalAllowance: number   // 2. 追加所定手当（追加出勤日 × 7h）
  paidLeaveDays: number         // 2b. 20日枠を超えた有給日数
  paidLeaveAllowance: number    // 2b. 有給日給（20日枠超の有給 × 7h）
  nonStatutoryOTHours: number   // 3a. 所定外労働時間（法定内・割増なし）
  nonStatutoryOTAllowance: number // 3a. 所定外労働手当 = 時給 × nonStatutoryOTHours
  otAllowance: number           // 3b. 法定外残業手当（1.25倍）
  legalHolidayAllowance: number // 4. 法定休日手当（1.35倍）
  nightAllowance: number        // 5. 深夜手当（+0.25倍）
  compAllowance: number         // 6. 休業手当（補償日）
  absentDeduction: number       // 7. 欠勤控除
  salaryNet: number             // 支給額合計
}

/**
 * 22:00〜5:00 の深夜時間帯と労働時間帯の重なりを計算（分単位）
 *
 * - 出退勤時刻が日付をまたぐ場合（et < st）も対応
 * - 22:00-翌5:00 を [22*60, 29*60] の連続窓として計算
 * - 翌5:00 以降の労働が出勤翌々日まで及ぶケースは想定外（建設業のシフトでは発生しない）
 *
 * 注: 休憩時間が深夜帯に重なる場合は、簡略化のため引かない。
 *     建設業の通常運用（昼食60分・午前/午後30分休憩）は深夜帯と重ならないため実害なし。
 */
export function calcNightMinutes(startMin: number, endMin: number): number {
  let end = endMin
  if (end <= startMin) end += 24 * 60 // 日付またぎ
  // 深夜帯: [22:00, 翌5:00] = [1320, 1740]、および前日からの引き継ぎ [-120, 300] = [0,300]
  const windows: [number, number][] = [
    [0, 300],         // 当日 00:00-05:00
    [1320, 1740],     // 当日 22:00-翌5:00
    [1320 + 1440, 1740 + 1440], // 翌日 22:00-翌々5:00（日付またぎシフトに対応）
  ]
  let total = 0
  for (const [a, b] of windows) {
    const lo = Math.max(startMin, a)
    const hi = Math.min(end, b)
    if (hi > lo) total += hi - lo
  }
  return total
}

/**
 * 法定休日（日曜）労働の割増手当を算出する（日本人。労基法37条は国籍を問わない）。
 *
 * 法定休日は所定労働日ではないため日額は発生しない。その日の労働は全時間に 1.35倍、
 * 8時間を超えた部分は 1.60倍（C-3 と同じ扱い。ベトナム人の
 * `calculateVietnameseSalary` と同一の建て方に揃えている）。
 * したがって呼び出し側は、法定休日ぶんの人工と残業hを基本給・残業手当から除外すること。
 *
 * ⚠️ 8時間の線は「日ごと」に引く。月合計に対して引くと、日曜が複数ある月で
 *    1.60倍の対象が過大になる。そのため dayHours は日単位の配列で受け取る。
 *
 * @param hourlyRate 割増算定基礎の時給（日給月給なら 日額 ÷ 8、月給制なら 月給 ÷ 145）
 * @param dayHours   法定休日ごとの実労働時間の配列
 */
export function calcLegalHolidayAllowance(hourlyRate: number, dayHours: number[]): number {
  if (hourlyRate <= 0) return 0
  let under8 = 0
  let over8 = 0
  for (const h of dayHours) {
    if (h <= 0) continue
    under8 += Math.min(8, h)
    over8 += Math.max(0, h - 8)
  }
  if (under8 <= 0 && over8 <= 0) return 0
  return ceilYen(hourlyRate * (1.35 * under8 + 1.60 * over8))
}

/**
 * 夜勤日の「法定最低の支給額」を1日単位で算出する（日本人・日給月給の 1.5人工 慣例の検証用）。
 *
 * 日本人の夜勤は 1.5人工（日勤＋夜勤なら 2.5人工）で支払い、元請けにも同率で請求する
 * 商習慣がある。これは法令上の割増賃金とは別建ての計算なので、条件次第で法定を下回る:
 *   - 法定休日（日曜）の夜勤 … 1.35倍と深夜0.25倍が重なるため、実労働 7.6h 超で不足
 *   - 長時間の通し勤務       … 平日でも実労働 16.2h 超で不足（日勤7h＋夜勤の通し等）
 * この関数で法定必要額を出し、支給額と比べて不足があれば警告する。支給額自体は変えない。
 *
 * 法定休日は所定労働日ではないため日額は発生せず、全時間に1.35倍を掛ける。
 * 休日労働は8時間を超えても35%増のままで足りる（時間外割増と重複しない）ため、
 * ここでは法令下限の1.35倍で評価する。
 */
export function calcNightShiftLegalRequiredPay(args: {
  dailyRate: number          // 日額
  prescribedHours: number    // 1日の所定労働時間（日本人=8h。割増単価の分母）
  totalHours: number         // その日の実労働時間（日勤＋夜勤、休憩控除済み）
  nightHours: number         // 深夜(22:00-5:00)と重なる労働時間
  isLegalHoliday: boolean    // 法定休日（日曜）か
  otMul?: number             // 時間外の割増率（既定1.25）
}): number {
  const { dailyRate, prescribedHours, totalHours, nightHours, isLegalHoliday } = args
  if (dailyRate <= 0 || prescribedHours <= 0) return 0
  const hourly = dailyRate / prescribedHours
  const nightPremium = hourly * 0.25 * nightHours
  if (isLegalHoliday) {
    return ceilYen(hourly * 1.35 * totalHours + nightPremium)
  }
  const otMul = args.otMul && args.otMul > 0 ? args.otMul : 1.25
  const otHours = Math.max(0, totalHours - prescribedHours)
  return ceilYen(dailyRate + hourly * otMul * otHours + nightPremium)
}

/**
 * ベトナム人スタッフの月次給与を法令準拠で計算する（変形労働時間制、新ルール）
 *
 * 設計方針:
 *   - 法定休日（日曜）労働: 1.35倍 で別途加算（追加所定・残業判定からは除外）
 *   - 所定休日（土・カレンダーoff/holiday）労働: 通常時給扱い、週40h超過分のみ1.25倍
 *     → 別枠の所定休日割増は法律上不要のため、最小コストとなる扱い
 *   - 深夜帯（22:00〜5:00）労働: 0.25倍を上乗せ（他の倍率と独立）
 *   - 休業手当（補償日）: 平均賃金の60%（時給×7h×0.6×日数）
 *   - 欠勤控除: 通常出勤日数が baseDays(20) に満たない場合、不足分を控除
 *
 * @param workerId 対象ワーカーID
 * @param ym       'YYYYMM'
 * @param hourlyRate 時間給
 * @param baseDays   基本給ベース日数（通常20）
 * @param attD       月の出面データ
 * @param sites      現場リスト（workSchedule で実労働時間を計算するため）
 * @param plUsed     当月の有給使用日数
 * @param compDays   当月の補償日数（w=0.6）
 * @param examDays   当月の試験日数
 */
export function calculateVietnameseSalary(
  workerId: number,
  ym: string,
  hourlyRate: number,
  baseDays: number,
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name?: string; workSchedule?: RawSite['workSchedule'] }[],
  plUsed: number,
  compDays: number,
  examDays: number,
  // 現場×日の勤務カレンダー（siteId -> { "d": "work"|... }）。
  //   週の残業しきい値を「カレンダーで事前に定めた週所定」で判定するために使う
  //   （社労士提出Excel calculateOvertimeSummary と同一基準）。
  //   未指定時は従来どおり「実出勤日の所定合計」で判定（後方互換）。
  calendarDays?: Record<string, Record<string, string>>,
  // 2026-09-13 追加: 配置現場カレンダーの所定日数（中途入退社・帰国で按分済み）。
  //   欠勤控除の基準は min(baseDays, prescribedDays)。カレンダーが20日未満の閑散月に
  //   全日出勤しても控除されない（月給制＝所定日数が減っても基本給は同額）。
  //   未指定・0 のときは従来どおり baseDays（20日枠）を基準にする。
  prescribedDays?: number,
  // 2026-09-30 追加: 本人の欠勤日数（出面の「欠」）。渡されたときは保証日数から引く（案A）。
  //   未指定なら従来どおり（8月分まで）
  personalAbsenceDays?: number,
): VietnameseSalaryResult {
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const numDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = numDays * 40 / 7
  const guaranteeDays = prescribedDays && prescribedDays > 0 ? Math.min(baseDays, prescribedDays) : baseDays

  // ── 日次集計 ──
  // 各日の実労働時間・所定時間・休日種別を計算
  // 2026-06-XX 追加: prescribedHours (その日の所定時間) を保持
  //   - C-2: 現場の workSchedule に従って動的に算出（IHI現場の 8h 等）
  //   - C-6: 半日勤務 (w=0.5) は scheduled も w 倍にして整合
  type DayInfo = {
    day: number
    dow: number              // 0=日
    weekNum: number          // 月曜起算
    isLegalHoliday: boolean  // 日曜
    actualHours: number      // その日の実労働時間（補償日除く、休憩控除済み）
    prescribedHours: number  // その日の所定時間（現場workSchedule + w係数）
    nightMinutes: number     // その日の深夜時間（分）
    hadWork: boolean         // 何らかの労働があったか
  }
  const dayInfos: DayInfo[] = []
  const firstDayDow = new Date(ymY, ymM - 1, 1).getDay()
  const firstMondayOffset = (firstDayDow + 6) % 7

  // 現場の workSchedule から所定時間 (休憩込み) を計算するヘルパー
  // calculateOvertimeSummary の calcPrescribedH と同じロジック
  const calcPrescribedH = (siteId: string): number => {
    const site = sites.find(s => s.id === siteId)
    const ws = site?.workSchedule as { startTime?: string; endTime?: string; morningBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number }; lunchBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number }; afternoonBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number } } | undefined
    if (!ws?.startTime || !ws?.endTime) return 7
    const stParts = ws.startTime.split(':').map(Number)
    const etParts = ws.endTime.split(':').map(Number)
    const startMin = stParts[0] * 60 + (stParts[1] || 0)
    const endMin = etParts[0] * 60 + (etParts[1] || 0)
    let totalMin = endMin - startMin
    if (ws.morningBreak?.enabled !== false) totalMin -= ws.morningBreak?.minutes ?? 30
    if (ws.lunchBreak?.enabled !== false) totalMin -= ws.lunchBreak?.minutes ?? 60
    if (ws.afternoonBreak?.enabled !== false) totalMin -= ws.afternoonBreak?.minutes ?? 30
    return Math.max(0, Math.round(totalMin / 60 * 10) / 10)
  }

  for (let d = 1; d <= numDays; d++) {
    const dow = new Date(ymY, ymM - 1, d).getDay()
    const dayOffset = (d - 1) + firstMondayOffset
    const weekNum = Math.floor(dayOffset / 7) + 1
    const isLegalHoliday = dow === 0

    let actualHours = 0
    let prescribedHours = 0
    let nightMinutes = 0
    let hadWork = false

    for (const site of sites) {
      const key = `${site.id}_${workerId}_${ym}_${d}`
      const entry = attD[key]
      if (!entry) continue
      // 有給・休み・現場休・帰国中・試験は実労働ゼロ
      if (entry.p || entry.r || entry.h || entry.hk || entry.exam) continue
      if (!entry.w || entry.w <= 0) continue
      // 補償日（w=0.6）は実労働時間にカウントしない（休業手当で別途支払い）
      if (entry.w === 0.6) continue

      hadWork = true
      const sitePrescribed = calcPrescribedH(site.id)
      // C-6 修正: w 係数を所定時間にも適用（半日勤務 w=0.5 → 所定 3.5h）
      prescribedHours += sitePrescribed * entry.w

      let dayHours = 0
      if (entry.st && entry.et) {
        // 時間ベース（日勤ブロック）: 現場の workSchedule に従って実労働を計算
        dayHours = calcDayShiftHours(entry, site.workSchedule as Parameters<typeof calcActualHours>[1])
        // 深夜時間（休憩控除前のレンジで計算 — 建設業の休憩は深夜帯と重ならない前提）
        nightMinutes += calcNightMinutes(timeToMinutes(entry.st), timeToMinutes(entry.et))
      } else if (!entry.nonly) {
        // レガシー入力: 主集計と式統一 = w × sitePrescribed + 残業h
        // C-6 修正: 旧 (7 + o) → (w × sitePrescribed + o)
        //   半日勤務 (w=0.5) で actualHours が過大計上されるバグを修正
        // ※ 夜勤のみの日 (nonly) はここに来ない — 下の夜勤ブロックで数える
        dayHours = entry.w * sitePrescribed + (entry.o || 0)
        // C-5 警告: レガシー入力では深夜時間が判定不能（st/et が無いため）
        //   5月以降の新ルール月で残業欄(o)が入っている場合は、深夜手当が
        //   0として扱われる可能性がある。コンソール警告で気付かせる。
        if (ym >= '202605' && (entry.o || 0) > 0) {
          console.warn(
            `[compute] 警告: ${workerId} の ${ym}-${d} はレガシー入力(st/et無し)で残業 ${entry.o}h あり。` +
            `深夜手当が計算できない可能性があります。出面入力でst/etを記入してください。`
          )
        }
      }
      // ── 夜勤ブロック（2026-08 追加）──
      //   「日勤＋夜勤」「夜勤のみ」の両方をここで加算する。台風待機など年数回のケース。
      const nRange = getNightRange(entry)
      if (nRange) {
        const nHours = calcNightShiftHours(entry)
        dayHours += nHours
        // 夜勤は休憩が深夜帯（例 0:00-1:00）に重なるのが普通なので、深夜時間が
        // 夜勤の実労働時間を超えないよう上限を掛ける。休憩位置は記録していないため、
        // 重なった分の控除まではしない（＝わずかに多め＝過払い側で法令リスクなし）。
        nightMinutes += Math.min(
          calcNightMinutes(timeToMinutes(nRange.start), timeToMinutes(nRange.end)),
          Math.round(nHours * 60),
        )
      }
      actualHours += dayHours
    }

    dayInfos.push({
      day: d, dow, weekNum, isLegalHoliday,
      actualHours: Math.round(actualHours * 100) / 100,
      prescribedHours: Math.round(prescribedHours * 100) / 100,
      nightMinutes,
      hadWork,
    })
  }

  // ── カレンダー予定日ベースの「日別 所定時間」──
  //   週の残業しきい値の基準に使う。calendarDays がある日のみ scheduled 所定を持ち、
  //   予定外の臨時出勤日は 0（＝しきい値を押し上げない）。
  //   これがないと「予定5日の週に臨時で6日働いた」ケースで週所定=42hに膨らみ、
  //   40h超の割増(0.25倍)が未払いになっていた（監査④）。
  const scheduledPrescribedByDay: Record<number, number> = {}
  if (calendarDays) {
    for (let d = 1; d <= numDays; d++) {
      let schedSiteId: string | null = null
      for (const siteId of Object.keys(calendarDays)) {
        if (calendarDays[siteId]?.[String(d)] === 'work') { schedSiteId = siteId; break }
      }
      scheduledPrescribedByDay[d] = schedSiteId ? calcPrescribedH(schedSiteId) : 0
    }
  }

  // ── 時間集計 ──
  const legalHolidayHours = dayInfos
    .filter(di => di.isLegalHoliday)
    .reduce((s, di) => s + di.actualHours, 0)
  const regularHours = dayInfos
    .filter(di => !di.isLegalHoliday)
    .reduce((s, di) => s + di.actualHours, 0)
  const actualWorkHours = legalHolidayHours + regularHours
  const nightHours = dayInfos.reduce((s, di) => s + di.nightMinutes, 0) / 60

  // ── 日数集計 ──
  // 法定休日に出勤した日数（別枠で1.35倍支給するため、追加所定の対象外）
  const legalHolidayDays = dayInfos.filter(di => di.isLegalHoliday && di.hadWork).length
  // 通常出勤日数: 法定休日以外で実労働があった日（補償・有給・試験は対象外）
  // 「追加所定手当」の対象になる日数。所定休日(土・off設定日)も含めて算入し、
  // 週40h超過の判定で自然に1.25倍が適用される（最低法令準拠）。
  const regularWorkDays = dayInfos.filter(di => !di.isLegalHoliday && di.hadWork).length

  // ── 3層残業判定（regular内のみ） ──
  // 第1段階: 日単位の法定外（regular内、1日8h超）
  const dailyOTByDay: Record<number, number> = {}
  let totalDailyOT = 0
  for (const di of dayInfos) {
    if (di.isLegalHoliday || di.actualHours === 0) continue
    const over = Math.max(0, di.actualHours - 8)
    dailyOTByDay[di.day] = over
    totalDailyOT += over
  }
  // 第2段階: 週単位（regular内）
  // 2026-06 社労士確認: 変形労働時間制では「事前にカレンダーで定めた週の所定」を基準にする。
  //   週所定が40hを超える週（例: 週6日×7h=42h）は、週所定を超えた分のみが時間外。
  //   週所定が40h以下の週は40h超が時間外。→ 判定基準 = max(40, 週所定)。
  //   ※ 社労士提出Excel側の calculateOvertimeSummary と同一ロジックに統一。
  const weekNums = [...new Set(dayInfos.map(di => di.weekNum))].sort((a, b) => a - b)
  let totalWeeklyOT = 0
  for (const wn of weekNums) {
    const weekDays = dayInfos.filter(di => di.weekNum === wn && !di.isLegalHoliday)
    const weekRegular = weekDays.reduce((s, di) => s + di.actualHours, 0)
    const weekDailyOT = weekDays.reduce((s, di) => s + (dailyOTByDay[di.day] || 0), 0)
    // 週所定 = その週の「カレンダー予定日」の所定時間合計（例: 予定5日なら 5×7h=35h）。
    //   calendarDays がある場合は予定日ベース（社労士Excelと同一基準・監査④修正）。
    //   未指定時は従来どおり実出勤日ベースにフォールバック。
    const weekPrescribed = calendarDays
      ? weekDays.reduce((s, di) => s + (scheduledPrescribedByDay[di.day] || 0), 0)
      : weekDays.reduce((s, di) => s + di.prescribedHours, 0)
    const weekThreshold = Math.max(40, weekPrescribed)
    totalWeeklyOT += Math.max(0, weekRegular - weekThreshold - weekDailyOT)
  }
  // 第3段階: 月単位（regular内、法定上限超 − 日単位 − 週単位）
  const monthlyStatutoryOT = Math.max(0, regularHours - legalLimit - totalDailyOT - totalWeeklyOT)
  // ★ 2026-07-09: 法定外残業の合計時間を 0.1h 単位に丸める。
  //   月次判定の法定上限(暦日×40÷7)が割り切れず端数(例5.073h)が出るが、書類表示は 0.1h
  //   丸め(5.1h)。金額を生値で計算すると「表示時間×単価」で手検算しても合わなかった
  //   （奥寺さん指摘）。表示と同じ丸め値で金額を出し、手計算と突合できるようにする。
  const statutoryOT = Math.round((totalDailyOT + totalWeeklyOT + monthlyStatutoryOT) * 10) / 10

  // ── 支給項目計算 ──
  const fixedBasePay = ceilYen(hourlyRate * baseDays * 7)  // 支給: 切り上げ（月給制: 20日固定）
  // 2026-09-02 修正（有給総点検）: 試験日(exam)は「給与計算では出勤と同等」（types/index.ts）。
  //   欠勤側（absentDays）は以前から試験を出勤扱いにしていたのに、枠超えの計算だけ
  //   regularWorkDays しか見ておらず、出勤19＋試験1＋有給1 の月で有給日給が消えていた
  //   （試験で20日枠が埋まった分、有給が「枠内に内包」扱いになる非対称）。
  //   出勤＋試験を「枠を埋めた日数」として追加所定・有給日給の両方で使う。
  const attendedDays = regularWorkDays + examDays
  const additionalDays = Math.max(0, attendedDays - baseDays)
  const additionalAllowance = ceilYen(hourlyRate * additionalDays * 7)  // 支給: 切り上げ
  // 2026-06 社労士対応: 「20日(基本給枠)を超えた有給」を有給日給として別途支給。
  //   月給制(基本給20日固定)は維持しつつ、20日以上働いて有給も取った人の有給未払いを是正。
  //   ・基本給枠(20日)を出勤(＋試験)で埋めた残りの有給日のみが対象（枠内の有給は基本給に内包）。
  //   ・absentDays(欠勤控除) は worked+試験+有給 < 20 のときだけ発生 → paidLeaveDays とは排他（二重計上なし）。
  const totalBeyondBase = Math.max(0, (attendedDays + plUsed) - baseDays)
  const paidLeaveDays = totalBeyondBase - additionalDays  // 20日枠を超えた有給日数
  const paidLeaveAllowance = ceilYen(hourlyRate * paidLeaveDays * 7)  // 有給日給: 切り上げ

  // 2026-06-XX 修正: 法定外残業手当は「割増分のみ (0.25 or 0.5倍)」
  //   旧バグ: 1.25 倍 (= 基本1.0 + 割増0.25) で計算 → 基本1.0倍が
  //     基本給/追加所定/所定外労働でも支払われており二重支給
  //     例: ハウ 22日×7h, 週40h超4h → 基本給+追加所定で154h × 1.0 + 法定外残業4h × 1.25
  //          = 159h相当 → 正解は 155h (154h + 4h × 0.25) なので 4h × 時給 過払い
  //   新ロジック:
  //     - 基本給/追加所定/所定外労働 が全労働を 1.0 倍カバー
  //     - 法定外残業 = 割増分のみ (0.25 or 0.5倍)
  //     - 結果: 全労働 1.0倍 + 法定外残業に対して +0.25 (= 1.25倍) → 法令準拠
  //   2026-06-XX (C-4): 月60h超は +0.5倍（旧: 1.5倍 = 1.0 + 0.5）
  const otUnder60 = Math.min(60, statutoryOT)
  const otOver60 = Math.max(0, statutoryOT - 60)
  // ★ 2026-07-09: 割増単価を先に1円未満切上げしてから時間を掛ける（奥寺さんの実務・
  //   労基法の端数処理に合わせる）。例: 時給1581 × 0.25 = 395.25 → 396円/h、396 × 法定外時間。
  //   旧: 時給×0.25×時間 をまとめて切上げ → 単価を先に丸める手計算と数円ズレていた。
  const otUnitUnder60 = ceilYen(hourlyRate * 0.25)  // 法定外(60h以内)の割増単価/h
  const otUnitOver60 = ceilYen(hourlyRate * 0.5)     // 法定外(月60h超)の割増単価/h
  const otAllowance = ceilYen(otUnitUnder60 * otUnder60 + otUnitOver60 * otOver60)  // 残業(割増)手当

  // 2026-06-XX 修正 (C-3): 法定休日労働 8h超の追加0.25倍（労基法37条）
  //   法定休日(日曜)出勤は通常1.35倍だが、8h超部分は更に深夜・時間外と
  //   同じく+0.25 = 1.60倍にする必要がある。
  //   例: 日曜10h勤務 = 8h × 1.35 + 2h × 1.60 = 10.8h + 3.2h = 14.0h相当
  const lhUnder8 = dayInfos
    .filter(di => di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.min(8, di.actualHours), 0)
  const lhOver8 = dayInfos
    .filter(di => di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.max(0, di.actualHours - 8), 0)
  const legalHolidayAllowance = ceilYen(hourlyRate * (1.35 * lhUnder8 + 1.60 * lhOver8))  // 支給: 切り上げ
  const nightAllowance = ceilYen(hourlyRate * 0.25 * nightHours)  // 支給: 切り上げ
  // ── 現場都合休（0.6補償）と最低20日保証（2026-09-15 代表決定・2026年8月分から）──
  //   会社都合で休ませた日は、保証枠（min(20, カレンダー所定)）に届くまでは出勤と同じく100%支給。
  //   枠を出勤・有給・試験・補償日で埋めた残りの補償日だけ、休業手当60%を足す。本人の欠勤は控除する。
  //   例: 稼働21日に 出勤18・補償2・欠1 → 18+2 で枠20が埋まる → 20日分（欠1は枠外で吸収）
  //       稼働20日に 出勤17・補償2・欠1 → 枠の不足1日は本人欠勤 → 19日分
  //       稼働23日に 出勤18・補償5     → 枠内2日は100%、残り3日は60% → 21.8日分
  //   それより前の月は従来どおり（補償日を欠勤扱いで控除し、全補償日に60%）
  const compFullWithinGuarantee = ym >= COMP_FULL_WITHIN_GUARANTEE_FROM_YM
  // 本人の欠勤を引いた「その人の保証日数」（2026-09分〜・案A）。未指定なら保証枠そのもの
  const personalAbsence = personalAbsenceDays !== undefined ? Math.min(Math.max(0, personalAbsenceDays), guaranteeDays) : 0
  const personalGuarantee = guaranteeDays - personalAbsence
  const compInGuaranteeDays = compFullWithinGuarantee
    ? Math.min(compDays, Math.max(0, personalGuarantee - regularWorkDays - plUsed - examDays))
    : 0
  const compAllowance = ceilYen(hourlyRate * 7 * 0.6 * (compDays - compInGuaranteeDays))  // 支給: 切り上げ

  // 所定外労働手当（法定内・割増なし）
  // 労基法24条（賃金全額払い）に基づき、月所定時間を超えた労働で
  // 法定上限内のものは「通常賃金」で支払う必要がある。
  //
  // 基本給 = baseDays × 7h をカバー。
  // 追加所定 = 出勤日数が baseDays を超えた場合に「丸1日分 × 7h」を加算。
  // ↑これだけだと、1日のうち所定超過の労働（残業欄入力分）が支払い対象から
  //   漏れる。日次の所定超過分(各日 actualHours - prescribedHours)を支払う。
  //
  // 2026-06-XX 修正 (C-2): 所定時間を固定 7h ではなく、各日の prescribedHours
  //   (現場workSchedule × w係数) で動的判定。IHI現場(8h)などで過大計上を防ぐ。
  //
  // 2026-06-XX 修正: statutoryOT を差し引かない（法定外残業手当を「割増のみ」にしたため）
  //   旧: nonStatutoryOTHours = max(0, totalDailyExcess - statutoryOT)
  //       → 「法定外残業の 1.0倍 base portion」を所定外労働から減算していた
  //       → 法定外残業手当が 1.25倍 (= base + premium) を支払う前提だった
  //   新: nonStatutoryOTHours = totalDailyExcess（全部 1.0倍 で支払い）
  //       法定外残業手当は割増 0.25倍のみ。base 1.0倍は所定外労働手当から自然に支払われる
  //
  // 例: 出勤18日(各日所定7h)+有給2日+残業18.5h、3層判定 statutoryOT=1.0h
  //     → 所定外労働時間 = 18.5h (全部)
  //     → 所定外労働手当 = 時給×18.5h × 1.0 (内 1h は法定外残業も該当)
  //     → 法定外残業手当 = 時給×1.0h × 0.25 (割増のみ)
  //     → 1.0h分の合計 = 1.0倍 + 0.25倍 = 1.25倍 ✓ (法令準拠)
  const totalDailyExcess = dayInfos
    .filter(di => !di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.max(0, di.actualHours - di.prescribedHours), 0)
  const nonStatutoryOTHours = totalDailyExcess
  const nonStatutoryOTAllowance = ceilYen(hourlyRate * nonStatutoryOTHours)  // 所定外労働手当: 1円未満切り上げ

  // 欠勤控除: 法定休日出勤は所定日数(20)カウント対象外（カレンダー上は休み）
  // 2026-06-XX 修正: 補償日(compDays)も欠勤扱いに変更（労基法26条準拠）
  //   旧: compDays を absentDays から除外 → 基本給で100%支払い + 60% 休業手当 = 160% (過払い)
  //   新: compDays を欠勤として算入 → 基本給から 1日分減額 + 60% 休業手当 = 60% (法令準拠)
  //   結果: 補償日 1日 = 基本給(時給×7h) を欠勤控除で減額し、休業手当(時給×7h×0.6) で 60% 補償
  // 2026-09-13: 基準は「保証枠」guaranteeDays = min(20, カレンダー所定日数)。
  //   例: カレンダー18日の閑散月に18日全部出勤 → 欠勤0（基本給20日分をそのまま保証）
  //       同じ月に自己都合で1日休む → 欠勤1（19日分）
  //       同じ月に現場都合休(0.6)が2日 → 欠勤2＋休業手当2×0.6（19.2日分）
  //   追加所定・有給日給の枠（baseDays=20）はこれまでどおり
  // 2026-09-30（案A・9月分〜）: 欠勤日数 = 本人の欠勤（保証から引いた分）＋ その人の保証日数に届かなかった分。
  //   personalAbsenceDays 未指定（8月分まで）は personalAbsence=0 なので従来の式と同じ
  //   ただし保証は「最低ライン」。実際に出勤・有給・試験などで埋めた日数より少なく払うことはしない
  //   （2026-09-30 修正: 稼働21日に 出20＋欠1 が19日分、稼働22日に 出21＋欠1 が20日分になり、
  //    働いた日の賃金まで削っていた。上限 = 20日枠に届かなかった日数）
  const countedDays = regularWorkDays + plUsed + examDays + compInGuaranteeDays
  const absentDays = Math.min(
    personalAbsence + Math.max(0, personalGuarantee - countedDays),
    Math.max(0, baseDays - countedDays),
  )
  const absentDeduction = floorYen(hourlyRate * 7 * absentDays)  // 控除: 切り捨て（過少支払い防止）

  const salaryNet = fixedBasePay + additionalAllowance + paidLeaveAllowance + nonStatutoryOTAllowance + otAllowance
                  + legalHolidayAllowance + nightAllowance + compAllowance
                  - absentDeduction

  return {
    actualWorkHours: Math.round(actualWorkHours * 10) / 10,
    regularHours: Math.round(regularHours * 10) / 10,
    legalHolidayHours: Math.round(legalHolidayHours * 10) / 10,
    nightHours: Math.round(nightHours * 10) / 10,
    regularWorkDays,
    legalHolidayDays,
    absentDays,
    guaranteeDays,
    compInGuaranteeDays,
    dailyStatutoryOT: Math.round(totalDailyOT * 10) / 10,
    weeklyStatutoryOT: Math.round(totalWeeklyOT * 10) / 10,
    monthlyStatutoryOT: Math.round(monthlyStatutoryOT * 10) / 10,
    statutoryOT: Math.round(statutoryOT * 10) / 10,
    legalLimit: Math.round(legalLimit * 10) / 10,
    fixedBasePay,
    additionalAllowance,
    paidLeaveDays,
    paidLeaveAllowance,
    nonStatutoryOTHours: Math.round(nonStatutoryOTHours * 10) / 10,
    nonStatutoryOTAllowance,
    otAllowance,
    legalHolidayAllowance,
    nightAllowance,
    compAllowance,
    absentDeduction,
    salaryNet,
  }
}
