/**
 * 出面一覧（日比建設・HFU 向け。タイムシート・残業集計・会社別の月シート）
 * 2026-10-21 総点検で lib/export.ts から分離。帳票の中身は変えていない（__tests__/exportOrgAttendance / reportConsistency）。
 */
import * as XLSX from 'xlsx-js-style'
import { RawSite, RawWorker, parseDKey } from './compute'
import { AttendanceEntry, calcActualHours, calcManDays } from '@/types'
import { dayLabel, daysInMonth, setColWidths, timesheetDayHours, ymLabel } from './export'
import { isWorkingDay } from './attendance'
import { WorkerMonthly } from './compute-monthly'
import { effectiveHourlyRateForYm, isHiredByMonth, isStillActiveForMonth } from './workers'
import { calculateOvertimeSummary } from './compute-overtime'

// ────────────────────────────────────────
//  1. 日比建設向け出面一覧
// ────────────────────────────────────────

export interface HibiAttendanceData {
  ym: string
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  /** その月に出面がある現場（終了済みも含む）。休憩設定（workSchedule）があれば実労働時間に使う */
  sites: { id: string; name: string; workSchedule?: RawSite['workSchedule'] }[]
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
  /** カレンダーの日ごとの種別（siteId → { "1": "work", "2": "off", ... }）*/
  calendarDays?: Record<string, Record<string, string>>
}

/**
 * 勤務時間一覧シートを生成（変形労働時間制の外国人スタッフ用、共通ロジック）
 * HFU向け・日比建設向けの両方で使用
 */
function appendTimeSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  titlePrefix: string,
  ym: string,
  foreignWorkers: RawWorker[],
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string; workSchedule?: RawSite['workSchedule'] }[],
  calendarDays?: Record<string, Record<string, string>>,
) {
  const numDays = daysInMonth(ym)
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const calDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = Math.round(calDays * 40 / 7 * 10) / 10

  // 4月/5月の境界で1日の所定時間が違う。
  //   4月以前 (旧ルール): 6時間40分 = 20/3h（休憩140分）
  //   5月以降 (変形労働時間制): 7時間（休憩120分）
  const useNewRules = ym >= '202605'
  const dailyPrescribed = useNewRules ? 7 : 20 / 3
  const dailyPrescribedDisplay = Math.round(dailyPrescribed * 100) / 100  // 6.67 / 7
  const ruleLabel = useNewRules ? '変形労働時間制' : '旧ルール'

  // 週番号: 月の1日を含む週をW1とし、日曜始まりで区切る
  const weekNums: number[] = []
  for (let d = 1; d <= numDays; d++) {
    const firstDay = new Date(ymY, ymM - 1, 1)
    const firstDow = firstDay.getDay()
    const dayOffset = (d - 1) + firstDow
    weekNums.push(Math.floor(dayOffset / 7) + 1)
  }

  // 所定時間: カレンダーから取得
  const prescribedHours: number[] = []
  for (let d = 1; d <= numDays; d++) {
    let isWorkDay = false
    if (calendarDays) {
      for (const siteId of Object.keys(calendarDays)) {
        const dayType = calendarDays[siteId]?.[String(d)]
        if (dayType === 'work') { isWorkDay = true; break }
      }
    }
    prescribedHours.push(isWorkDay ? dailyPrescribed : 0)
  }
  const totalPrescribed = Math.round(prescribedHours.reduce((s, h) => s + h, 0) * 10) / 10

  const headers = ['名前', '区分']
  for (let d = 1; d <= numDays; d++) headers.push(dayLabel(ym, d))
  headers.push('合計', '法定上限')

  const titleRow = [`${titlePrefix} 勤務時間一覧 ${ymLabel(ym)}（${ruleLabel}）`]
  const rows: (string | number)[][] = [titleRow, headers]

  // 所定時間行
  const prescRow: (string | number)[] = ['', '所定(h)']
  for (let d = 0; d < numDays; d++) prescRow.push(prescribedHours[d] > 0 ? dailyPrescribedDisplay : '')
  prescRow.push(totalPrescribed, legalLimit)
  rows.push(prescRow)

  // 週番号行
  const weekRow: (string | number)[] = ['', '週']
  for (let d = 0; d < numDays; d++) weekRow.push(`W${weekNums[d]}`)
  weekRow.push('', '')
  rows.push(weekRow)

  rows.push([])

  // 各ワーカー
  for (const w of foreignWorkers) {
    const hoursRow: (string | number)[] = [w.name, '実労働(h)']
    const otRow: (string | number)[] = ['', 'うち残業(h)']
    const statusRow: (string | number)[] = ['', '出欠']

    let totalHours = 0, totalOT = 0, plCount = 0

    for (let d = 1; d <= numDays; d++) {
      const dd = String(d)
      let dayHours = 0, dayOT = 0, status = ''
      let isPL = false

      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${dd}`
        const entry = attD[key]
        if (!entry) continue
        if (entry.p) { isPL = true; break }
        // ⚠️ 2026-05-09: 残骸データ対策。休み/現場休/帰国中/試験 のステータスがある日は実労働を計上しない
        if (!isWorkingDay(entry)) continue
        if (entry.w && entry.w > 0) {
          // 2026-06-XX 修正 (I-11/I-12): 時間ベース入力(st/et)があれば実労働時間を採用
          //   - 旧: 一律 dailyPrescribed (7h or 6h40m) で固定 → 実労働が短い場合に過大表示
          //   - 新: st/et から実労働時間を計算 (休憩控除済み)、無ければ従来通り
          // 2026-06-XX 追加 (I-12): w に旧ルール継続フラグがあれば 6h40m を採用
          // 注: appendTimeSheet の sites 型は最小限 {id, name} のため workSchedule を持たない
          //     → workSchedule なしで calcActualHours を呼ぶと「休憩控除なし」になる可能性
          //     現状は最低限の整合性として実労働時間を直接計算
          const dailyPrescribedForWorker = w.useOldRules ? 20 / 3 : dailyPrescribed
          // 同日複数現場は加算（旧: 上書きで最後の現場だけになり過少 2026-08-27）
          const th = timesheetDayHours(entry, dailyPrescribedForWorker, site.workSchedule as Parameters<typeof calcActualHours>[1])
          dayHours += th.dayHours
          dayOT += th.dayOT
          status = entry.w === 0.6 ? '補' : dayOT > 0 ? '出+残' : '出'
        }
      }

      if (isPL) {
        status = '有給'; plCount++
        hoursRow.push(''); otRow.push('')
      } else if (dayHours > 0) {
        // dayHours は既に総実労働時間（所定＋残業）。dayOT を再度足さない。
        const actualH = Math.round(dayHours * 10) / 10
        hoursRow.push(actualH); otRow.push(dayOT > 0 ? dayOT : '')
        totalHours += actualH; totalOT += dayOT
      } else {
        hoursRow.push(''); otRow.push('')
      }
      statusRow.push(status)
    }

    hoursRow.push(Math.round(totalHours * 10) / 10, '')
    otRow.push(totalOT > 0 ? Math.round(totalOT * 10) / 10 : '', '')
    statusRow.push(plCount > 0 ? `有給${plCount}日` : '', '')

    rows.push(hoursRow); rows.push(otRow); rows.push(statusRow); rows.push([])
  }

  // 備考行
  rows.push([])
  rows.push(['【計算方法】'])
  if (useNewRules) {
    rows.push(['', '1日の所定: 7時間（8:00-17:00、休憩2時間）'])
    rows.push(['', '法定上限: 暦日数 × 40 ÷ 7 =', legalLimit, 'h'])
    rows.push(['', '残業判定: 1日単位(8h超) → 1週単位(40h超) → 1ヶ月単位(法定上限超) の3段階'])
    rows.push(['', '※ 「実労働(h)」= 所定7h + 残業h で変換済み。「うち残業(h)」は出面入力の残業欄の値。'])
    // 2026-06-XX: 個別に旧ルール継続のスタッフがいる場合の注意書き
    const oldRulesNames = foreignWorkers.filter(w => w.useOldRules).map(w => w.name)
    if (oldRulesNames.length > 0) {
      rows.push(['', `⚠️ 旧ルール継続スタッフ: ${oldRulesNames.join(', ')}`])
      rows.push(['', '　　上記スタッフは1日所定 6時間40分（合計表示の7h/日は参考値、実際の所定時間は ×6.667 で計算）'])
      rows.push(['', '　　月所定時間 = 月所定日数 × 6時間40分 で別途算出されます'])
    }
  } else {
    rows.push(['', '1日の所定: 6時間40分（8:00-17:00、休憩140分）'])
    rows.push(['', '法定上限: 暦日数 × 40 ÷ 7 =', legalLimit, 'h（参考表示）'])
    rows.push(['', '残業判定（旧ルール）: 月の実労働 > 月の所定時間（=所定日数×6時間40分）の超過分'])
    rows.push(['', '※ 「実労働(h)」= 所定6h40min + 残業h で変換済み。「うち残業(h)」は出面入力の残業欄の値。'])
    rows.push(['', '※ 週6日×6h40min = 40h で法定上限ぴったり。土曜出勤は追加割増なし。'])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 3 } }]
  const colWidths = [14, 10]; for (let d = 0; d < numDays; d++) colWidths.push(7); colWidths.push(8, 8)
  setColWidths(ws, colWidths)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
}

/**
 * 勤怠サマリーシートを追加（キャシュモ向け: 3段階残業判定の結果）
 * 個人別に月次の所定時間/実労働/法定外/休日労働/基本給を出力
 */
function appendOvertimeSummarySheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  titlePrefix: string,
  ym: string,
  foreignWorkers: RawWorker[],
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string; workSchedule?: RawSite['workSchedule'] }[],
  calendarDays: Record<string, Record<string, string>>,
  baseDays: number = 20,
  // 月次集計（computeMonthly）の結果。基本給(固定)はここから取る（2026-10-02 総合点検）。
  //   旧: 時給×20日×7h を計算し直していたため、帰国・月途中の入社で日割りした人や固定月給の人は
  //   月次集計Excel と違う基本給が載っていた
  monthly?: Pick<WorkerMonthly, 'id' | 'fixedBasePay' | 'basePay' | 'hkDays' | 'salary'>[],
) {
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const calDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = Math.round(calDays * 40 / 7 * 10) / 10

  const titleRow = [`${titlePrefix} 勤怠サマリー ${ymLabel(ym)}（1か月単位の変形労働時間制）`]
  const headers = [
    '名前', '時間給',
    '所定労働時間', '所定労働日数',
    '実労働時間', '実労働日数',
    '所定外労働時間', '法定外労働時間',
    '(内訳)日単位', '(内訳)週単位', '(内訳)月単位',
    '法定休日労働時間', '所定休日労働時間',
    '基本給(固定)',
  ]
  const rows: (string | number)[][] = [titleRow, headers]
  const monthlyById = new Map((monthly || []).map(m => [m.id, m]))
  const proratedNames: string[] = []

  for (const w of foreignWorkers) {
    // 時給はその月の適用額（月途中の改定は暦日按分）。給与計算本体（compute.ts の worker map）と揃える
    const hr = effectiveHourlyRateForYm(w, ym) || 0
    const summary = calculateOvertimeSummary(ym, w.id, hr, baseDays, attD, sites, calendarDays)
    const m = monthlyById.get(w.id)
    const basePay = m ? (m.fixedBasePay ?? m.basePay ?? summary.fixedBasePay) : summary.fixedBasePay
    if (m && basePay !== summary.fixedBasePay) proratedNames.push(`${w.name}（${(m.hkDays || 0) > 0 ? `帰国中 ${m.hkDays}日` : (m.salary || 0) > 0 ? '固定月給' : '月途中の入社・退職'}）`)

    rows.push([
      w.name,
      hr,
      summary.prescribedHours,
      summary.prescribedDays,
      summary.actualHours,
      summary.actualDays,
      summary.nonStatutoryOT,
      summary.statutoryOT,
      summary.dailyStatutoryOT,
      summary.weeklyStatutoryOT,
      summary.monthlyStatutoryOT,
      summary.legalHolidayHours,
      summary.prescribedHolidayHours,
      basePay,
    ])
  }

  // 空行 + 説明
  rows.push([])
  rows.push(['【算出根拠】'])
  rows.push(['', `法定上限: ${calDays}日 × 40 ÷ 7 = ${legalLimit}h`])
  rows.push(['', '法定休日: 日曜日'])
  rows.push(['', `ベース日数: ${baseDays}日`])
  rows.push(['', `基本給(固定) = 時間給 × ${baseDays}日 × 7h（月次集計と同じ値。帰国・月途中の入社や退職は在籍日数で日割り、固定月給の人は月給）`])
  if (proratedNames.length > 0) rows.push(['', `※ 基本給を日割り・固定月給で載せた人: ${proratedNames.join('、')}`])
  rows.push([])
  rows.push(['【残業3段階判定】'])
  rows.push(['', '第1段階（日単位）: 所定8h以下の日は8hを超えた分、所定8h超の日はその所定を超えた分'])
  rows.push(['', '第2段階（週単位）: 所定40h以下の週は40hを超えた分（第1段階分を除く）'])
  rows.push(['', `第3段階（月単位）: 法定上限(${legalLimit}h)を超えた分（第1・2段階分を除く）`])
  rows.push(['', '法定外労働時間 = 第1段階 + 第2段階 + 第3段階'])
  rows.push(['', '所定外労働時間 = 所定時間を超えた全ての時間（法定内・法定外の両方を含む）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 13 } }]
  setColWidths(ws, [14, 8, 10, 10, 10, 10, 10, 10, 8, 8, 8, 10, 10, 12])
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
}

/**
 * 会社別 出面一覧（日比建設・HFU 共通 — 2026-09-17 統一）
 *
 * 2026年10月（9月分）から日比建設・HFU とも給与計算をキャシュモに委託するため、
 * 両社の出力を同じ形にそろえた。旧: 日比用と HFU 用が別関数で、日比は勤務時間一覧を
 * カレンダーの有無で省略するなどの差があった。
 *
 * Sheet 1: 出面一覧（その会社の全スタッフ: 出勤値／残業h。日本人はこれと月次集計Excelが計算資料）
 * Sheet 2: 勤務時間一覧（外国人のみ・時間換算: 実労働h／所定h／週番号／法定上限）
 * Sheet 3: 勤怠サマリー（新ルールの外国人のみ・3段階残業判定。202605〜）
 */
import { isWorkerOfOrg, ATTENDANCE_ORG_LABEL, type AttendanceOrg } from './orgs'
import { todayJstIso } from '@/lib/date-utils'
export { isWorkerOfOrg, ATTENDANCE_ORG_LABEL, type AttendanceOrg } from './orgs'

export interface HfuAttendanceExportData extends HibiAttendanceData {
  /** カレンダーの日ごとの種別（siteId → { "1": "work", "2": "off", ... }） */
  calendarDays?: Record<string, Record<string, string>>
  /** ベース日数（3層構造の基本給計算用、デフォルト20） */
  baseDays?: number
  /** 月次集計（computeMonthly）の結果。勤怠サマリーの基本給(固定)をこれとそろえる（2026-10-02） */
  monthlyWorkers?: Pick<WorkerMonthly, 'id' | 'fixedBasePay' | 'basePay' | 'hkDays' | 'salary'>[]
}

/**
 * その月の帳票に載せる現場（2026-10-02 総合点検）。
 * 「終了していない現場」ではなく「その月に出面（本人・外注）がある現場」で決める。
 * 旧: 終了（archived）した現場を除いていたので、月が終わってから現場を終了にすると、
 *   その現場の日数が出面一覧・現場別出面一覧・勤怠サマリーから丸ごと抜けた（月次集計には入っているのに）。
 */
export function sitesForMonthSheets<T extends { id: string; archived?: boolean }>(
  sites: T[],
  ym: string,
  attD: Record<string, AttendanceEntry | null | undefined>,
  attSD?: Record<string, { n: number; on: number } | null | undefined>,
): T[] {
  const used = new Set<string>()
  for (const [key, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(key)
    if (pk.ym === ym) used.add(pk.sid)
  }
  if (attSD) {
    const ids = sites.map(s => s.id)
    for (const [key, v] of Object.entries(attSD)) {
      if (!v) continue
      // 外注のキーは `${siteId}_${外注ID}_${ym}_${day}`。現場 id の方を前方一致で探す
      const hit = ids.filter(id => key.startsWith(`${id}_`) && key.includes(`_${ym}_`)).sort((a, b) => b.length - a.length)[0]
      if (hit) used.add(hit)
    }
  }
  return sites.filter(s => !s.archived || used.has(s.id))
}

export function generateOrgAttendance(data: HfuAttendanceExportData, org: AttendanceOrg): XLSX.WorkBook {
  const { ym, workers, attD, sites, calendarDays } = data
  const label = ATTENDANCE_ORG_LABEL[org]
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // 退職月の在籍スタッフ（例: 6/30 退職予定）も当月分は集計対象に含める
  const orgWorkers = workers.filter(w => isWorkerOfOrg(w, org) && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym))

  // ── Sheet 1: 出面一覧（出勤値／残業h） ──
  {
    // 従業員番号 = キャシュモ管理の番号（2026-09-17 追加。社員番号とは別）
    const headers = ['名前', '従業員番号', '区分']
    for (let d = 1; d <= numDays; d++) headers.push(dayLabel(ym, d))
    headers.push('合計')

    const rows: (string | number)[][] = [[`${label} 出面一覧 ${ymLabel(ym)}`], headers]
    let totalWork = 0, totalOT = 0
    const dailyWorkTotals: number[] = new Array(numDays).fill(0)
    const dailyOTTotals: number[] = new Array(numDays).fill(0)

    for (const w of orgWorkers) {
      const workRow: (string | number)[] = [w.name, (w as { payrollNo?: string }).payrollNo || '', '出勤']
      const otRow: (string | number)[] = ['', '', '残業h']
      let wWork = 0, wOT = 0

      for (let d = 1; d <= numDays; d++) {
        const dd = String(d)
        let dayWork: string | number = ''
        let dayOT = 0
        let isPL = false

        for (const site of sites) {
          const entry = attD[`${site.id}_${w.id}_${ym}_${dd}`]
          if (!entry) continue
          if (entry.p) { isPL = true; break }
          // ⚠️ 2026-05-09: 残骸データ対策。休み/現場休/帰国中/試験 では実労働を計上しない
          if (!isWorkingDay(entry)) continue
          if (entry.w && entry.w > 0) {
            // 2026-08-13: 元請け請求ベース（出面入力ベース）に統一。夜勤日は 1.5人工 が乗る
            // 同日複数現場は加算（旧: 上書きで最後の現場だけになり過少 2026-08-27）
            dayWork = (typeof dayWork === 'number' ? dayWork : 0) + calcManDays(entry)
            if (entry.o && entry.o > 0) dayOT += entry.o
          }
        }

        if (isPL) { dayWork = '有' }
        else if (typeof dayWork === 'number' && dayWork > 0) { wWork += dayWork; dailyWorkTotals[d - 1] += dayWork }
        dailyOTTotals[d - 1] += dayOT; wOT += dayOT
        workRow.push(dayWork || ''); otRow.push(dayOT > 0 ? dayOT : '')
      }

      workRow.push(wWork > 0 ? Math.round(wWork * 10) / 10 : '')
      otRow.push(wOT > 0 ? Math.round(wOT * 10) / 10 : '')
      totalWork += wWork; totalOT += wOT
      rows.push(workRow); rows.push(otRow)
    }

    // Footer: 日ごとの縦計
    const footerWork: (string | number)[] = ['合計', '', '出勤']
    const footerOT: (string | number)[] = ['', '', '残業h']
    for (let d = 0; d < numDays; d++) {
      footerWork.push(dailyWorkTotals[d] > 0 ? Math.round(dailyWorkTotals[d] * 10) / 10 : '')
      footerOT.push(dailyOTTotals[d] > 0 ? Math.round(dailyOTTotals[d] * 10) / 10 : '')
    }
    footerWork.push(Math.round(totalWork * 10) / 10)
    footerOT.push(Math.round(totalOT * 10) / 10)
    rows.push(footerWork); rows.push(footerOT)

    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 3 } }]
    const colWidths = [14, 9, 6]; for (let d = 0; d < numDays; d++) colWidths.push(7); colWidths.push(6)
    setColWidths(ws, colWidths)
    XLSX.utils.book_append_sheet(wb, ws, '出面一覧')
  }

  // ── Sheet 2: 勤務時間一覧（外国人のみ・時間換算） ──
  // 4月以前は1日6h40min、5月以降は1日7h で時間変換（appendTimeSheet 内で自動切替）
  const foreignWorkers = orgWorkers.filter(w => w.visa && w.visa !== 'none' && w.visa !== '')
  if (foreignWorkers.length > 0) {
    appendTimeSheet(wb, '勤務時間一覧', label, ym, foreignWorkers, attD, sites, calendarDays)

    // ── Sheet 3: 勤怠サマリー（3段階残業判定の結果） ──
    // ⚠️ 「1か月単位の変形労働時間制」専用。4月以前（旧ルール）には適用されないため出力しない。
    //    旧ルール継続者(useOldRules)も対象外（2026-06-12 監査: 固定月給と矛盾する行が載るため除外）
    if (calendarDays && ym >= '202605') {
      const bd = data.baseDays || 20
      const newRuleWorkers = foreignWorkers.filter(w => !(w as { useOldRules?: boolean }).useOldRules)
      if (newRuleWorkers.length > 0) {
        appendOvertimeSummarySheet(wb, '勤怠サマリー', label, ym, newRuleWorkers, attD, sites, calendarDays, bd, data.monthlyWorkers)
      }
    }
  }

  return wb
}
