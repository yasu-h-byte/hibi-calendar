/**
 * 合成ゴールデン（2026年9月分・10月分）— 2026-10-02 総合点検・提案3
 *
 * 本番データのゴールデン（goldenMaster.test.ts）は 2026-06〜08 の3か月で、9月分・10月分から始まる決まり
 * （案A・日本人の日曜割増なし・運転手当・適用開始日・全社所定27日・月途中入社）を含まない。
 * ここでは**架空の人**（時給・日給・月給はすべて架空）で 202609 / 202610 の計算結果を凍結する。
 *
 * 落ちたら「給与計算の挙動が変わった」。意図した変更なら
 *   UPDATE_GOLDEN=1 npx vitest run goldenSynthetic
 * で更新し、何がなぜ変わったかをコミットメッセージに書く（goldenMaster と同じ運用）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { computeMonthly, type MainData, type RawWorker } from '@/lib/compute'
import { calcMonthlyAllowances } from '@/lib/allowance'
import type { AttendanceEntry } from '@/types'

const EXPECTED_DIR = join(__dirname, 'fixtures', 'golden-synthetic', 'expected')
const UPDATE = process.env.UPDATE_GOLDEN === '1'
const MONTHS = ['202609', '202610'] as const

// ── 架空の人員（金額はすべて架空） ──
const WORKERS = [
  // 新ルール・時給。9/21 に時給改定（9月分は暦日按分・10月分は新時給）
  { id: 201, name: '合成A', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: 11200, hourlyRate: 1600, hourlyRateFrom: '2026-09-21', prevHourlyRate: 1400, otMul: 1.25, hireDate: '2022-10-01', token: '' },
  // 新ルール・時給。10/1 一律改定（9月分は旧時給）。HFU
  { id: 202, name: '合成B', org: 'hfu', visa: 'jisshu2', job: 'tobi', rate: 11900, hourlyRate: 1700, hourlyRateFrom: '2026-10-01', prevHourlyRate: 1550, otMul: 1.25, hireDate: '2023-04-01', token: '' },
  // 旧ルール・固定月給・7時間契約。10/1 に最賃対応（時給・日給・月給とも適用開始日つき）。HFU
  { id: 207, name: '合成C', org: 'hfu', visa: 'jisshu1', job: 'tobi', rate: 9100, hourlyRate: 1300, salary: 218834, rateFrom: '2026-10-01', prevRate: 9030, hourlyRateFrom: '2026-10-01', prevHourlyRate: 1290, salaryFrom: '2026-10-01', prevSalary: 217150, otMul: 1.25, hireDate: '2026-08-01', token: '', useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202609' },
  // 旧ルール・固定月給（6h40m換算）。日比
  { id: 104, name: '合成D', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 15000, hourlyRate: 2300, salary: 380000, otMul: 1.25, hireDate: '2020-01-01', token: '', useOldRules: true },
  // 旧ルール・10/26 入社（10月分だけ）
  { id: 209, name: '合成E', org: 'hfu', visa: 'jisshu1', job: 'tobi', rate: 9100, hourlyRate: 1300, salary: 218834, otMul: 1.25, hireDate: '2026-10-26', token: '', useOldRules: true },
  // 日本人・日給月給。10/1 号俸改定（9月分は旧日額）
  { id: 4, name: '合成F', org: 'hibi', visa: 'none', job: 'tobi', rate: 21000, rateFrom: '2026-10-01', prevRate: 20000, otMul: 1.25, hireDate: '2020-04-01', token: '', canDrive: true },
  // 日本人・月給制（役員以外）
  { id: 12, name: '合成G', org: 'hibi', visa: 'none', job: 'tobi_apprentice', rate: 0, salary: 232000, otMul: 1.25, hireDate: '2026-04-01', token: '' },
  // 役員
  { id: 1, name: '合成H', org: 'hibi', visa: 'none', job: 'yakuin', rate: 0, salary: 900000, otMul: 1.25, hireDate: '2015-01-01', token: '' },
] as unknown as RawWorker[]

const SITES = [
  { id: 'sat', name: '土曜稼働', start: '', end: '', foreman: 0, archived: false },
  { id: 'wk', name: '平日のみ', start: '', end: '', foreman: 0, archived: false },
  { id: 'near', name: '近い現場（運転手当なし）', start: '', end: '', foreman: 0, archived: false, noDriveAllowance: true },
]

function calendar(ym: string, saturday: boolean): { days: Record<string, string>; count: number } {
  const y = +ym.slice(0, 4), m = +ym.slice(4, 6)
  const n = new Date(y, m, 0).getDate()
  const days: Record<string, string> = {}
  let count = 0
  const holidays = ym === '202609' ? [21, 22, 23] : [12]   // 架空の祝日扱い（9月: 3日・10月: 1日）
  for (let d = 1; d <= n; d++) {
    const dw = new Date(y, m - 1, d).getDay()
    const work = dw !== 0 && (saturday || dw !== 6) && !holidays.includes(d)
    days[String(d)] = work ? 'work' : (holidays.includes(d) ? 'holiday' : 'off')
    if (work) count++
  }
  return { days, count }
}

/** 決定的な出面（乱数を使わない）。人×日で決まった規則で 出勤／残業／欠／0.6／有給／日曜／夜勤 を置く */
function attendance(ym: string, cals: Record<string, Record<string, string>>): { d: Record<string, AttendanceEntry>; drv: Record<string, { am?: number[]; pm?: number[] }> } {
  const y = +ym.slice(0, 4), m = +ym.slice(4, 6)
  const n = new Date(y, m, 0).getDate()
  const d: Record<string, AttendanceEntry> = {}
  const drv: Record<string, { am?: number[]; pm?: number[] }> = {}
  const T = (et = '17:00', o?: number): AttendanceEntry => ({ w: 1, st: '08:00', et, b1: 1, b2: 1, b3: 1, ...(o ? { o } : {}) } as unknown as AttendanceEntry)
  for (let day = 1; day <= n; day++) {
    const dw = new Date(y, m - 1, day).getDay()
    const put = (sid: string, wid: number, e: AttendanceEntry) => { d[`${sid}_${wid}_${ym}_${day}`] = e }
    // 201: 平日のみ現場。木曜は残業2h、第2土曜に臨時出勤、14日は欠
    if (cals.wk[day] === 'work') put('wk', 201, day === 14 ? { w: 0, r: 1 } as unknown as AttendanceEntry : T(dw === 4 ? '19:00' : '17:00', dw === 4 ? 2 : undefined))
    if (dw === 6 && day >= 8 && day <= 14) put('wk', 201, T())
    // 202: 土曜稼働現場。全日出勤、水曜は残業1h、第1日曜も出勤、2日は有給
    if (cals.sat[day] === 'work') put('sat', 202, day === 2 ? { p: 1, w: 0 } as unknown as AttendanceEntry : T(dw === 3 ? '18:00' : '17:00', dw === 3 ? 1 : undefined))
    if (dw === 0 && day <= 7) put('sat', 202, T())
    // 207: 土曜稼働現場。全日出勤、6日は0.6補、20日は欠、金曜は残業1h
    if (cals.sat[day] === 'work') put('sat', 207, day === 6 ? { w: 0.6 } as AttendanceEntry : day === 20 ? { w: 0, r: 1 } as unknown as AttendanceEntry : T(dw === 5 ? '18:00' : '17:00', dw === 5 ? 1 : undefined))
    // 104: 平日のみ現場。全日出勤、15日は有給、24日は0.6補。9月は 1〜10日が帰国（出面なし）
    if (cals.wk[day] === 'work' && !(ym === '202609' && day <= 10)) put('wk', 104, day === 15 ? { p: 1, w: 0 } as unknown as AttendanceEntry : day === 24 ? { w: 0.6 } as AttendanceEntry : T())
    // 209: 10/26 入社。入社日から全日
    if (ym === '202610' && day >= 26 && cals.sat[day] === 'work') put('sat', 209, T())
    // 4（日本人日給）: 土曜稼働現場で全日（6日勤務週あり）。第2日曜に出勤＋残業2h、17日は夜勤（日勤＋夜勤）、運転は月・水
    if (cals.sat[day] === 'work') put('sat', 4, { w: 1, ...(dw === 2 ? { o: 1.5 } : {}) } as AttendanceEntry)
    if (dw === 0 && day >= 8 && day <= 14) put('sat', 4, { w: 1, o: 2 } as AttendanceEntry)
    if (day === 17 && cals.sat[day] === 'work') put('sat', 4, { w: 1, ns: 1, nst: '20:00', net: '29:00', nb: 60 } as unknown as AttendanceEntry)
    if (cals.sat[day] === 'work' && (dw === 1 || dw === 3)) drv[`sat_${ym}_${day}`] = { am: [4], pm: dw === 1 ? [4] : [] }
    // 近い現場（運転手当なし）に 1日だけ出勤して運転
    if (day === 28 && cals.wk[day] === 'work') { put('near', 4, { w: 1 } as AttendanceEntry); drv[`near_${ym}_${day}`] = { am: [4], pm: [4] } }
    // 12（日本人月給制）: 平日のみ。9日は欠、第3土曜に出勤
    if (cals.wk[day] === 'work') put('wk', 12, day === 9 ? { w: 0, r: 1 } as unknown as AttendanceEntry : { w: 1 } as AttendanceEntry)
    if (dw === 6 && day >= 15 && day <= 21) put('wk', 12, { w: 1 } as AttendanceEntry)
    // 1（役員）: 平日
    if (cals.wk[day] === 'work') put('wk', 1, { w: 1 } as AttendanceEntry)
  }
  return { d, drv }
}

function sanitize(value: unknown): unknown {
  if (value instanceof Map || value instanceof Set) return undefined
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number(value.toFixed(6))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue
      const s = sanitize(v)
      if (s !== undefined) out[k] = s
    }
    return out
  }
  return value
}

function runMonth(ym: string) {
  const satCal = calendar(ym, true), wkCal = calendar(ym, false)
  const cals = { sat: satCal.days, wk: wkCal.days, near: wkCal.days }
  const main = {
    workers: WORKERS, sites: SITES, subcons: [],
    assign: { sat: { workers: [202, 207, 209, 4] }, wk: { workers: [201, 104, 12, 1] }, near: { workers: [4] } },
    massign: {}, billing: {}, workDays: { 202609: 24, 202610: 27 },
    siteWorkDays: { [ym]: { sat: satCal.count, wk: wkCal.count, near: wkCal.count } },
    locks: {}, plData: {}, defaultRates: { tobiRate: 30000, dokoRate: 24000 }, mforeman: {},
  } as unknown as MainData
  const att = attendance(ym, cals)
  const homeLeaves = ym === '202609' ? [{ workerId: 104, startDate: '2026-09-01', endDate: '2026-09-10' }] : []
  // 運転手当（2026年10月分〜）。loadMonthlyAllowances と同じ組み立て（Firestore を使わず直接）
  const noDrive = new Set(SITES.filter(s => (s as { noDriveAllowance?: boolean }).noDriveAllowance).map(s => s.id))
  const allowances = ym >= '202610'
    ? calcMonthlyAllowances(att.d, ym, {}, att.drv, WORKERS.filter(w => w.job === 'yakuin').map(w => w.id), undefined, noDrive, SITES)
    : undefined
  const result = computeMonthly(main, att.d, {}, ym, main.workDays[ym] || 0, main.siteWorkDays[ym], 20, cals, homeLeaves, allowances)
  return sanitize({
    workers: [...result.workers].sort((a, b) => a.id - b.id),
    sites: [...result.sites].sort((a, b) => a.id.localeCompare(b.id)),
    totals: result.totals,
  }) as { workers: Array<Record<string, unknown>> }
}

describe('合成ゴールデン（9月分・10月分・架空の人）', () => {
  for (const ym of MONTHS) {
    it(`${ym} の計算結果が凍結時と一致する`, () => {
      const actual = runMonth(ym)
      const file = join(EXPECTED_DIR, `${ym}.json`)
      if (UPDATE || !existsSync(file)) {
        mkdirSync(EXPECTED_DIR, { recursive: true })
        writeFileSync(file, JSON.stringify(actual, null, 1))
        return
      }
      expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf-8')))
    })
  }

  it('新しい決まりが実際に効いている（境界の確認）', () => {
    const sep = runMonth('202609').workers, oct = runMonth('202610').workers
    const w = (list: Array<Record<string, unknown>>, id: number) => list.find(x => x.id === id)!
    // 時給の適用開始日: 9/21 改定は9月分が按分、10/1 改定は9月分が旧時給・10月分が新時給
    expect(w(sep, 201).hourlyRate).toBe(1466.67)
    expect(w(oct, 201).hourlyRate).toBe(1600)
    expect(w(sep, 202).hourlyRate).toBe(1550)
    expect(w(oct, 202).hourlyRate).toBe(1700)
    // 固定月給の適用開始日
    expect(w(sep, 207).salary).toBe(217150)
    expect(w(oct, 207).salary).toBe(218834)
    // 日本人の年次改定（10/1）
    expect(w(sep, 4).rate).toBe(20000)
    expect(w(oct, 4).rate).toBe(21000)
    // 日曜の割増: 9月分はあり・10月分はなし（警告だけ）
    expect(w(sep, 4).legalHolidayAllowance).toBeGreaterThan(0)
    expect(w(oct, 4).legalHolidayAllowance).toBe(0)
    expect(w(oct, 4).sundayNoRestDays).toEqual([11])
    // 運転手当: 10月分から。「運転手当なし」の現場の便は数えない。9月分には無い
    expect(w(sep, 4).driveAllowance).toBeUndefined()
    expect(w(oct, 4).driveLegs).toBeGreaterThan(0)
    expect(w(oct, 4).driveAllowance).toBe((w(oct, 4).driveLegs as number) * 1000)
    // 案A: 本人の欠勤（カレンダーの仕事の日の「欠」）が保証から引かれる
    expect(w(sep, 201).personalAbsenceDays).toBe(1)
    expect(w(oct, 201).guaranteeDays).toBe(20)
    // 旧ルール: 10月は全社所定27日、10/26 入社は所定を日割り
    expect(w(oct, 104).workerPrescribedDays).toBe(27)
    expect(w(oct, 209).workerPrescribedDays).toBe(Math.round(27 * 6 / 31))
    expect(((w(oct, 209).payNotes || []) as Array<{ code: string }>).map(n => n.code)).not.toContain('belowWorkedDays')   // 2026-10-05 代表決定: 旧契約には出さない
    // 帰国（9月1〜10日）: 在籍日数の日割り
    expect(w(sep, 104).hkDays).toBe(10)
    // 休憩短縮（旧ルール7時間契約）
    expect(w(oct, 207).breakShortenAllowance).toBeGreaterThan(0)
    // 日本人月給制の欠勤控除（8月分〜）と土曜出勤の注意点
    expect(w(oct, 12).absentDeduction).toBeGreaterThan(0)
    expect((w(oct, 12).payNotes as Array<{ code: string }>).map(n => n.code)).toContain('jpMonthlyOffDayWork')
    // 役員には欠勤控除も注意点も付かない
    expect(w(oct, 1).absentDeduction).toBe(0)
    expect(w(oct, 1).payNotes).toBeUndefined()
  })
})
