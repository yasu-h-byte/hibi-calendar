// ────────────────────────────────────────
//  出面入力グリッドの純粋計算ヘルパー
//  （app/(app)/attendance/page.tsx から抽出。UIに依存しない計算のみ）
//  バッジ系は lib/labels.ts、職種分類は lib/jobs.ts に集約済み（重複定義しない）
// ────────────────────────────────────────

import { calcActualHours, calcDayShiftHours, calcNightShiftHours, calcManDays } from '@/types'
import { isWorkingDay } from '@/lib/attendance'
import { isTobiGroup } from '@/lib/jobs'
import { AttEntry, SubconDayEntry, DayType, Worker, Subcon } from '@/app/(app)/attendance/types'

// ── 日付・スタイルヘルパー ──

export const DOW_JA = ['日', '月', '火', '水', '木', '金', '土']

export function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 年月選択肢（2ヶ月先〜過去count-1ヶ月分） */
export function getYmOptions(count: number): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = -2; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    result.push({
      ym: `${y}${String(m).padStart(2, '0')}`,
      label: `${y}年${m}月`,
    })
  }
  return result
}

export function getDow(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getDay()
}

export function isToday(year: number, month: number, day: number): boolean {
  const now = new Date()
  return now.getFullYear() === year && now.getMonth() + 1 === month && now.getDate() === day
}

export function dayColBg(year: number, month: number, day: number, calDayType?: DayType | null): string {
  if (isToday(year, month, day)) return 'bg-amber-50'
  const dow = getDow(year, month, day)
  // 日曜・土曜は曜日色を常に優先
  if (dow === 0) return 'bg-red-50'
  if (dow === 6) return 'bg-blue-50'
  // 平日でカレンダー休日 → グレー
  if (calDayType === 'off' || calDayType === 'holiday') return 'bg-gray-100/60'
  return ''
}

export function dayHeaderBg(year: number, month: number, day: number, calDayType?: DayType | null): string {
  if (isToday(year, month, day)) return 'bg-amber-100'
  const dow = getDow(year, month, day)
  // 日曜・土曜は曜日色を常に優先
  if (dow === 0) return 'bg-red-100'
  if (dow === 6) return 'bg-blue-100'
  // 平日でカレンダー休日 → グレー濃
  if (calDayType === 'off' || calDayType === 'holiday') return 'bg-gray-200'
  return 'bg-gray-100'
}

export function dayTextColor(dow: number): string {
  if (dow === 0) return 'text-red-600'
  if (dow === 6) return 'text-blue-600'
  return 'text-gray-700'
}

// ── 退職日バッジ ──

/**
 * 退職日バッジの色とラベルを返す
 *   - 既に退職済（過去日）→ グレー「✅退職済」
 *   - 30日以内 → 赤「🏁 5/15退職」
 *   - 31〜90日 → オレンジ「🏁 6/30退職」
 *   - それ以降 → null（バッジ表示なし）
 */
export function retirementBadge(retired: string | undefined): { label: string; cls: string; title: string } | null {
  if (!retired) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const retiredDate = new Date(retired + 'T00:00:00')
  const diffDays = Math.floor((retiredDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  const m = retiredDate.getMonth() + 1
  const d = retiredDate.getDate()
  if (diffDays < 0) {
    return { label: `✅${m}/${d}退職済`, cls: 'bg-gray-200 text-gray-700', title: `${retired} 退職済` }
  }
  if (diffDays <= 30) {
    return { label: `🏁${m}/${d}退職`, cls: 'bg-red-100 text-red-700 ring-1 ring-red-300', title: `${retired} 退職予定（あと${diffDays}日）` }
  }
  if (diffDays <= 90) {
    return { label: `🏁${m}/${d}退職`, cls: 'bg-orange-100 text-orange-700', title: `${retired} 退職予定（あと${diffDays}日）` }
  }
  return null
}

// ── セル表示値の判定 ──

/** レガシーモードのドロップダウン表示値 */
export function getWorkValue(entry: AttEntry | null | undefined): string {
  if (!entry) return ''
  // ★ 優先順: P/E/R/H > HK
  //   帰国期間中の有給事後計上で p:1 + hk:1 の状態が一時的に発生しうるため、
  //   明示的なステータス（有給など）を帰国マーカーより優先表示する。
  if (entry.p && entry.p > 0) return 'P'
  if (entry.exam && entry.exam > 0) return 'E'
  if (entry.hk && entry.hk > 0) return 'HK'
  if (entry.w === 1) return '1'
  if (entry.w === 0.5) return '0.5'
  if (entry.w === 0.6) return '0.6'
  return ''
}

/** 時間ベースモードのステータス表示値 */
export function getTimeStatusValue(entry: AttEntry | null | undefined): string {
  if (!entry) return ''
  // ★ 優先順: P/E/R/H > HK（帰国期間中の有給事後計上対応）
  if (entry.p && entry.p > 0) return 'P'
  if (entry.exam && entry.exam > 0) return 'E'
  if (entry.r && entry.r > 0) return 'R'
  if (entry.h && entry.h > 0) return 'H'
  if (entry.hk && entry.hk > 0) return 'HK'
  // 補償日(0.6)は「出勤」ではなく独立したステータス（2026-08-25）。
  // w>0 で一律 'W' を返していたため、ベトナム人セルで 0.6 が「出」と表示され
  // 区別できなかった。現場都合休みの代理入力を可能にするため分離する。
  if (entry.w === 0.6) return 'C'
  if (entry.w > 0) return 'W'
  return ''
}

// ── ワーカー・外注の月間合計 ──

export interface WorkerTotals {
  wSum: number
  oSum: number
  compSum: number
  plSum: number
  actualHoursSum: number
}

/**
 * ワーカー1人の月間合計。
 * @param timeBased 時間ベース計算対象（外国人 + 202605〜 + 旧契約継続者でない）
 * @param foreign 外国人（visa が none/空 以外）。補償(0.6)日の残業をカウントしない
 *
 * ⚠️ 2026-05-09 修正: 「働いた日」のみ wSum / compSum / oSum / actualHours を加算する。
 *   isWorkingDay() で 5 ステータス (p/r/h/hk/exam) を一括チェック。
 *   旧コードは wSum を先に加算していたため、{w:1, p:1, ...} のような残骸データが
 *   人工計に水増し計上されていた。
 */
export function computeWorkerTotals(
  entries: Record<number, AttEntry | null>,
  opts: { timeBased: boolean; foreign: boolean },
): WorkerTotals {
  let wSum = 0
  let oSum = 0
  let compSum = 0
  let plSum = 0
  let actualHoursSum = 0
  for (const e of Object.values(entries)) {
    if (!e) continue
    // 有給日数は別カウント（残骸関係なく p flag で判定）
    if (e.p && e.p > 0) plSum += 1

    if (!isWorkingDay(e)) continue

    // 出勤日のみ集計対象。
    // ⚠️ e.w を直接足さない。夜勤がある日は 1.5人工 が別枠で乗るため、
    //    w だけ足すとセルの「2人工」表示や給与計算と合計欄が食い違う（2026-08-13 修正）。
    //    夜勤が無ければ calcManDays(e) === e.w なので従来と同値。
    wSum += calcManDays(e)
    if (e.w === 0.6) compSum += 0.6

    // 補償日 (w=0.6) の残業は、ベトナム人スタッフはカウントしない（フッターと整合）
    const isComp = e.w === 0.6 && opts.foreign
    if (isComp) continue

    if (opts.timeBased && e.st && e.et) {
      // 実労働合計は夜勤ブロックも含める（労働時間の実績として正しい）。
      // 一方 残業h は日勤ブロックだけから出す — 夜勤は 1.5人工 で別途支給するため、
      // 残業h に混ぜると二重計上になる。
      actualHoursSum += calcActualHours(e)
      oSum += Math.max(0, calcDayShiftHours(e) - 7)
    } else {
      oSum += e.o || 0
      // レガシー入力（日本人など st/et 無し）でも夜勤ブロックの実労働は計上する
      actualHoursSum += calcNightShiftHours(e)
    }
  }
  // 浮動小数点誤差を丸める（0.6 * 12 = 7.199... → 7.2）
  wSum = Math.round(wSum * 10) / 10
  oSum = Math.round(oSum * 10) / 10
  compSum = Math.round(compSum * 10) / 10
  actualHoursSum = Math.round(actualHoursSum * 10) / 10
  return { wSum, oSum, compSum, plSum, actualHoursSum }
}

export function computeSubconTotals(
  entries: Record<number, SubconDayEntry | null>,
): { nSum: number; onSum: number } {
  let nSum = 0
  let onSum = 0
  for (const e of Object.values(entries)) {
    if (e) {
      nSum += e.n || 0
      onSum += e.on || 0
    }
  }
  // 浮動小数点誤差を丸める
  nSum = Math.round(nSum * 10) / 10
  onSum = Math.round(onSum * 10) / 10
  return { nSum, onSum }
}

// ── フッター合計（鳶合計・土工合計・総合計） ──

export interface FooterSums {
  tobi: Record<number, number>
  doko: Record<number, number>
  grand: Record<number, number>
  tobiOt: Record<number, number>
  dokoOt: Record<number, number>
  grandOt: Record<number, number>
  tobiTotal: number
  dokoTotal: number
  grandTotal: number
  tobiOtTotal: number
  dokoOtTotal: number
  grandOtTotal: number
}

export const EMPTY_FOOTER_SUMS: FooterSums = {
  tobi: {}, doko: {}, grand: {}, tobiOt: {}, dokoOt: {}, grandOt: {},
  tobiTotal: 0, dokoTotal: 0, grandTotal: 0, tobiOtTotal: 0, dokoOtTotal: 0, grandOtTotal: 0,
}

/**
 * フッター合計ルール（docs/attendance.md）:
 * - 鳶合計 = 鳶グループ（とび/鳶見習い/職長/役員 = lib/jobs.ts の isTobiGroup） + 外注（鳶）
 * - 土工合計 = 土工 + 外注（土工）
 * - 補償(0.6)は外国人の場合は人工数に含めない（compute()と同じルール）
 * - ⚠️ 2026-05-09: isWorkingDay() で残骸データ対策（有給/休み/現場休/帰国中/試験 を除外）
 */
export function computeFooterSums(
  daysInMonth: number,
  workers: Pick<Worker, 'id' | 'visa' | 'job'>[],
  subcons: Pick<Subcon, 'id' | 'type'>[],
  workerEntries: Record<string, Record<number, AttEntry | null>>,
  subconEntries: Record<string, Record<number, SubconDayEntry | null>>,
): FooterSums {
  const tobi: Record<number, number> = {}
  const doko: Record<number, number> = {}
  const grand: Record<number, number> = {}
  const tobiOt: Record<number, number> = {}
  const dokoOt: Record<number, number> = {}
  const grandOt: Record<number, number> = {}
  let tobiTotal = 0
  let dokoTotal = 0
  let grandTotal = 0
  let tobiOtTotal = 0
  let dokoOtTotal = 0
  let grandOtTotal = 0

  for (let d = 1; d <= daysInMonth; d++) {
    let tobiDay = 0
    let dokoDay = 0
    let grandDay = 0
    let tobiOtDay = 0
    let dokoOtDay = 0
    let grandOtDay = 0

    for (const w of workers) {
      const wId = String(w.id)
      const entry = workerEntries[wId]?.[d]
      if (entry && isWorkingDay(entry)) {
        const isComp = entry.w === 0.6 && w.visa !== 'none'
        // ⚠️ entry.w を直接使わない。夜勤の 1.5人工 が抜けて鳶計・土工計・総計が
        //    人ごとの合計と合わなくなる（2026-08-13 修正）。
        const workVal = isComp ? 0 : calcManDays(entry)
        const otVal = isComp ? 0 : (entry.o || 0)
        if (isTobiGroup(w.job)) {
          tobiDay += workVal
          tobiOtDay += otVal
        } else if (w.job === 'doko') {
          dokoDay += workVal
          dokoOtDay += otVal
        }
        grandDay += workVal
        grandOtDay += otVal
      }
    }

    // Add subcon counts to tobi/doko/grand totals
    for (const sc of subcons) {
      const entry = subconEntries[sc.id]?.[d]
      if (entry && entry.n > 0) {
        const isTobi = sc.type === 'tobi' || sc.type === '鳶業者' || sc.type === '鳶'
        const isDoko = sc.type === 'doko' || sc.type === '土工業者' || sc.type === '土工'
        if (isTobi) {
          tobiDay += entry.n
          tobiOtDay += entry.on || 0
        } else if (isDoko) {
          dokoDay += entry.n
          dokoOtDay += entry.on || 0
        }
        grandDay += entry.n
      }
      if (entry && entry.on > 0) {
        grandOtDay += entry.on
      }
    }

    tobi[d] = tobiDay
    doko[d] = dokoDay
    grand[d] = grandDay
    tobiOt[d] = tobiOtDay
    dokoOt[d] = dokoOtDay
    grandOt[d] = grandOtDay
    tobiTotal += tobiDay
    dokoTotal += dokoDay
    grandTotal += grandDay
    tobiOtTotal += tobiOtDay
    dokoOtTotal += dokoOtDay
    grandOtTotal += grandOtDay
  }

  // 浮動小数点誤差を丸める
  const r = (n: number) => Math.round(n * 10) / 10
  return {
    tobi, doko, grand, tobiOt, dokoOt, grandOt,
    tobiTotal: r(tobiTotal), dokoTotal: r(dokoTotal), grandTotal: r(grandTotal),
    tobiOtTotal: r(tobiOtTotal), dokoOtTotal: r(dokoOtTotal), grandOtTotal: r(grandOtTotal),
  }
}

// ── 警告の収集 ──

/** 休みの日に出勤していた場合の区分。強い順（法定休日 > 祝日 > 所定休日） */
export type RestDayWorkType = '日曜' | '祝日' | '休日'

/**
 * 休日・日曜の出勤警告
 *
 * 2026-08-03 統合。以前は「日曜出勤」と「休日出勤」を別々に集めてバナーを2枚
 * 出していたが、日曜はカレンダー上も休みに設定されているのが通常なので、
 * 同じ1日が両方に現れて二重表示になっていた（2026-08-02 日比大介の事例:
 * 「日曜出勤あり 日比大介(2日)」と「休日出勤あり 日比大介(2日/休日)」が並んだ）。
 *
 * 1日につき必ず1件だけ、最も強い区分で報告する。日曜を優先するのは法定休日
 * （割増 1.35 倍）で、給与上の扱いが所定休日より重いため。
 */
export function collectRestDayWorkWarnings(
  year: number,
  month: number,
  daysInMonth: number,
  calendarDays: Record<string, DayType> | null,
  workers: Pick<Worker, 'id' | 'name'>[],
  workerEntries: Record<string, Record<number, AttEntry | null>>,
): { workerName: string; day: number; dayType: RestDayWorkType }[] {
  const warnings: { workerName: string; day: number; dayType: RestDayWorkType }[] = []
  for (const w of workers) {
    const entries = workerEntries[String(w.id)] || {}
    for (let d = 1; d <= daysInMonth; d++) {
      const entry = entries[d]
      // 有給(p)は出勤ではないので対象外（統合前の両関数と同じ条件）
      if (!entry || !(entry.w > 0) || entry.p) continue

      const isSunday = getDow(year, month, d) === 0
      const calDay = calendarDays?.[String(d)]
      const isCalendarRest = calDay === 'off' || calDay === 'holiday'
      if (!isSunday && !isCalendarRest) continue

      warnings.push({
        workerName: w.name,
        day: d,
        dayType: isSunday ? '日曜' : calDay === 'holiday' ? '祝日' : '休日',
      })
    }
  }
  return warnings
}
