import { describe, test, expect, vi, afterEach } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * 最低20日保証（2026-09-13）
 *
 * 欠勤控除の基準は「保証枠 = min(基本給ベース20日, 配置現場カレンダーの所定日数)」。
 * 閑散期にカレンダーの稼働日が20日未満でも、全日出勤なら基本給20日分をそのまま支給する（月給制）。
 * 改修前は 20日枠で残差を取っていたため、カレンダー18日の月に全部出ても2日分控除されていた。
 *
 * P=カレンダー稼働日数, W=出勤, C=現場都合休(0.6), R=欠, PL=有給。日曜は 6,13,20,27（2026-09）。
 */
const YM = '202609'
const H = 1513
const SUNDAYS = new Set([6, 13, 20, 27])
function buildMain(): MainData {
  return {
    workers: [{ id: 201, name: 'グエン', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: H * 7, hourlyRate: H, otMul: 1.25, hireDate: '2022-10-01', token: '' }],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { s: { workers: [201], subcons: [] } }, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}
function run(P: number, W: number, C: number, R: number, PL: number) {
  const cal: Record<string, string> = {}
  const att: Record<string, AttendanceEntry> = {}
  let n = 0; const workdays: number[] = []
  for (let d = 1; d <= 30; d++) {
    if (SUNDAYS.has(d)) { cal[String(d)] = 'holiday'; continue }
    if (n < P) { cal[String(d)] = 'work'; workdays.push(d); n++ } else cal[String(d)] = 'off'
  }
  let i = 0
  const put = (d: number, e: AttendanceEntry) => { att[`s_201_${YM}_${d}`] = e }
  for (let k = 0; k < W; k++) put(workdays[i++], { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry)
  for (let k = 0; k < C; k++) put(workdays[i++], { w: 0.6 } as AttendanceEntry)
  for (let k = 0; k < R; k++) put(workdays[i++], { r: 1 } as unknown as AttendanceEntry)
  for (let k = 0; k < PL; k++) put(workdays[i++], { p: 1 } as unknown as AttendanceEntry)
  const w = computeMonthly(buildMain(), att, {}, YM, 0, { s: P }, 20, { s: cal }).workers.find(x => x.id === 201)!
  return { w, days: Math.round(((w.salaryNetPay ?? w.netPay) / (H * 7)) * 100) / 100 }
}

describe('保証枠 = min(20, カレンダー所定日数)', () => {
  test('E: カレンダー18日・全日出勤 → 欠勤0、20日分保証', () => {
    const { w, days } = run(18, 18, 0, 0, 0)
    expect(w.guaranteeDays).toBe(18)
    expect(w.absence).toBe(0)
    expect(days).toBe(20)
  })
  test('F: カレンダー18日・欠1 → 欠勤1（19日分）', () => {
    const { w, days } = run(18, 17, 0, 1, 0)
    expect(w.absence).toBe(1); expect(days).toBe(19)
  })
  test('G: カレンダー18日・現場都合休2 → 補償日は保証枠内なので100%（20日分・2026-08分〜）', () => {
    const { w, days } = run(18, 16, 2, 0, 0)
    expect(w.absence).toBe(0); expect(w.compDays).toBe(2); expect(w.compInGuaranteeDays).toBe(2)
    expect(w.compAllowance).toBe(0); expect(days).toBe(20)
  })
  test('J: カレンダー18日・出16＋有給2 → 欠勤0（20日分）', () => {
    const { w, days } = run(18, 16, 0, 0, 2)
    expect(w.absence).toBe(0); expect(days).toBe(20)
  })
  test('L: カレンダー18日・欠1＋現場都合休2 → 本人欠勤1だけ控除（19日分）', () => {
    const { w, days } = run(18, 15, 2, 1, 0)
    expect(w.absence).toBe(1); expect(days).toBe(19)
  })
})

describe('カレンダー20日以上の月は従来どおり（20日枠）', () => {
  test('A: 23日全出勤 → 追加所定3日（23日分）', () => {
    const { w, days } = run(23, 23, 0, 0, 0)
    expect(w.guaranteeDays).toBe(20); expect(w.absence).toBe(0); expect(days).toBe(23)
  })
  test('C: 23日中 出18＋現場都合休5 → 枠内2日は100%、残り3日は60%（21.8日分）', () => {
    const { w, days } = run(23, 18, 5, 0, 0)
    expect(w.absence).toBe(0); expect(w.compInGuaranteeDays).toBe(2); expect(days).toBe(21.8)
  })
  test('H: 20日中 出15＋現場都合休5 → 補償日5日すべて枠内で100%（20日分）', () => {
    const { days } = run(20, 15, 5, 0, 0)
    expect(days).toBe(20)
  })
  // 2026-09-30（案A・9月分〜）: 保証日数 = 20 − 本人の欠勤。保証を超えた現場都合休は60%
  test('21日中 出18＋現場都合休2＋欠1 → 19日保証。現場都合休1日は100%・1日は60%（19.6日分）', () => {
    const { w, days } = run(21, 18, 2, 1, 0)
    expect(w.absence).toBe(1); expect(w.compInGuaranteeDays).toBe(1); expect(days).toBe(19.6)
  })
  test('21日中 出17＋現場都合休2＋欠2 → 18日保証（18.6日分）', () => {
    const { w, days } = run(21, 17, 2, 2, 0)
    expect(w.absence).toBe(2); expect(days).toBe(18.6)
  })
  // 保証は最低ライン。実際に働いた日より少なく払わない（2026-09-30 修正）
  test('21日中 出20＋欠1 → 働いた20日分（全日出勤の21日分より1日少ない）', () => {
    const { w, days } = run(21, 20, 0, 1, 0)
    expect(w.absence).toBe(0); expect(days).toBe(20)
  })
  test('22日中 出21＋欠1 → 働いた21日分（20日分に削らない）', () => {
    const { days } = run(22, 21, 0, 1, 0)
    expect(days).toBe(21)
  })
  test('22日中 出20＋欠2 → 働いた20日分', () => {
    const { days } = run(22, 20, 0, 2, 0)
    expect(days).toBe(20)
  })
  test('18日中 出17＋欠1 → 19日分（閑散月の保証から1日減る）', () => {
    const { days } = run(18, 17, 0, 1, 0)
    expect(days).toBe(19)
  })
  test('21日中 出19＋現場都合休1＋欠1 → 19.6日分（全日出勤20＋現場都合休1の20.6日分より1日少ない）', () => {
    const { days } = run(21, 19, 1, 1, 0)
    expect(days).toBe(19.6)
  })
  test('8月分（202608）は旧ルール: 21日中 出18＋現場都合休2＋欠1 → 20日分', async () => {
    const { PAYROLL_RULES } = await import('@/lib/compute')
    expect(PAYROLL_RULES.personalAbsenceReducesGuaranteeFromYm).toBe('202609')
  })
  test('I: 25日中 出20＋現場都合休5 → 欠勤0＋休業手当（23日分）', () => {
    const { days } = run(25, 20, 5, 0, 0)
    expect(days).toBe(23)
  })
  test('K: 23日中 出18＋有給2＋現場都合休3 → 欠勤0（21.8日分）', () => {
    const { days } = run(23, 18, 3, 0, 2)
    expect(days).toBe(21.8)
  })
})

describe('稼働日未入力の警告', () => {
  test('D: 稼働日23日のうち5日が空欄 → calendarBlankDays=5（計算は欠勤2のまま）', () => {
    const { w, days } = run(23, 18, 0, 0, 0)
    expect(w.calendarBlankDays).toBe(5)
    expect(w.absence).toBe(2); expect(days).toBe(18)
  })
  test('全日入力済みなら警告なし', () => {
    const { w } = run(18, 16, 2, 0, 0)
    expect(w.calendarBlankDays).toBeUndefined()
  })
  // 2026-10-09: 月の途中に開いたら、まだ来ていない日（今日を含む）は数えない
  describe('月の途中', () => {
    afterEach(() => { vi.useRealTimers() })
    test('9/25 に開くと、空欄の稼働日 22〜26日のうち 22・23・24日の3日だけ', () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T03:00:00Z'))  // 日本時間 9/25 12:00
      expect(run(23, 18, 0, 0, 0).w.calendarBlankDays).toBe(3)
    })
    test('9/15 に開くと、空欄の稼働日はまだ来ていないので警告なし', () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T03:00:00Z'))
      expect(run(23, 18, 0, 0, 0).w.calendarBlankDays).toBeUndefined()
    })
  })
})
