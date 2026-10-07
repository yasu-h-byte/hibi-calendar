/**
 * 経営コックピットへ渡す「在籍スタッフの台帳と、これから5年の給料の見込み」（2026-10-07）
 *
 * 経営コックピットの「人員配置計画」（日比建設の中期計画の人件費・自社の人工）が読む。
 * 代表「在籍スタッフは DEDURA＋ から常に引っ張る。人件費はレイヤー（等級）ごと、在籍年数で給与が上がる」。
 *
 * 給料の上がり方の決まりは DEDURA＋ の1か所（lib/jp-wage.ts・lib/wage-curve.ts・lib/labor-cost.ts）で持ち、
 * ここで1人ずつ月ごとに見込みを出して渡す（経営コックピットに同じ決まりを書かない）。
 *
 * 見込みの前提（PROJECTION_ASSUMPTIONS）:
 *   - 日本人（日給月給・号俸）: 毎年10月1日に号俸が上がる。評語は基本の A（+4号）＋ 年齢調整。昇格は見込まない。
 *     入社6か月未満の10月は上げない。年の基本給 = 日額 × (所定290日 + 有給20日) = 310日（月はその12分の1）
 *   - 日本人の新卒の月給: 入社1年は月給のまま、その後は 1G の月給と同じくらいの号から（stepForDaily）
 *   - ベトナム人（時給）: 入社した月に毎年、逓減カーブの昇給（A 評価 = カーブどおり）。月の給料 = 時給 × 140時間
 *   - 月給の人（時給が無い）: 据え置き
 *   - 会社負担の社会保険: employerWelfare（標準報酬の上限・介護は40〜64歳）
 *   - 残業・手当・賞与は入れない（経営コックピット側で、締めた月の実際の支給額と比べて補う）
 *   - 役員（yakuin）は給料の決まりの外なので見込みを出さない（役員報酬は帳簿で持つ）
 * 金額はすべて円。個人の給与を含むので、窓口は合言葉（checkIntegrationKey）で守り、経営コックピット側も経営者だけが見る。
 * 仕様: docs/integration.md
 */
import type { Worker } from '@/types'
import { ANNUAL_DAYS, PAID_LEAVE_DAYS, HYOGO_PITCH, MAX_STEP, ageAdjustment, ageOn, dailyForStep, stepForDaily, type JpGrade } from '@/lib/jp-wage'
import { curveRaiseAt, MONTHLY_HOURS } from '@/lib/wage-curve'
import { DEFAULT_WELFARE_RATES, employerWelfare } from '@/lib/labor-cost'
import { minWageAt } from '@/lib/wage-analysis'

export const PROJECTION_ASSUMPTIONS = {
  jpHyogo: 'A' as const,
  jpPaidDaysPerYear: ANNUAL_DAYS + PAID_LEAVE_DAYS,
  jpFirstRevisionMinMonths: 6,
  vnRaiseMultiplier: 1,
  vnMonthlyHours: MONTHLY_HOURS,
  note: '日本人は毎年10月に評語A＋年齢調整で号俸が上がる（昇格は見込まない）。ベトナム人は入社月に逓減カーブ（A評価）で時給が上がる。残業・手当・賞与は入れない',
}

export type Nationality = 'jp' | 'vn'

export interface ProjectedMonth {
  /** YYYY-MM */
  ym: string
  /** その月に在籍しているか（入社前・退職後は false） */
  active: boolean
  /** 一時帰国でその月まるごといない（承認済みの帰国） */
  homeLeave: boolean
  /** 基本給（円・月。残業・手当なし） */
  pay: number
  jpGrade?: string
  jpStep?: number
  hourly?: number
}

export interface IntegrationWorker {
  id: number
  name: string
  /** 'hbk' = 日比建設 / 'hfu' = エイチエフユナイテッド */
  company: 'hbk' | 'hfu'
  /** 日本人か（在留資格が無い）・ベトナム人か */
  nationality: Nationality
  /** yakuin 役員 / shokucho 職長 / tobi / tobi_apprentice 鳶見習い / doko 土工 / jimu 事務 */
  job: string
  /** none / jisshu1〜3 / tokutei1〜2 など */
  visaType: string
  visaExpiry: string | null
  hireDate: string | null
  retired: string | null
  /** 見込みの最初の月の年齢（生年月日が無ければ null） */
  age: number | null
  dispatchTo: string | null
  /** 現場に出る人か（役員・事務は false） */
  field: boolean
  pay: { kind: 'daily' | 'hourly' | 'monthly' | 'none'; daily?: number; hourly?: number; monthly?: number; jpGrade?: string; jpStep?: number }
  /** 締めた直近の月の実際の支給額（残業・手当込み・会社負担の社会保険なし）。無ければ null */
  lastClosed: { ym: string; totalCost: number } | null
  months: ProjectedMonth[]
  /** 月の見込みを年に足したもの（会社負担の社会保険を足した額も）。key は期の初めの年（2026 = 2026年10月〜2027年9月） */
  years: { fyStart: number; pay: number; welfare: number; total: number; activeMonths: number }[]
}

const JP_GRADES = new Set(['1G', '2G', '3G', '4G', '5G', '6G', 'doko'])

export function nationalityOf(w: Pick<Worker, 'visaType'>): Nationality {
  return !w.visaType || w.visaType === 'none' ? 'jp' : 'vn'
}

const ymAdd = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1)) // utc-ok（年月の足し算だけ）
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` // utc-ok
}
const isDateIso = (s?: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)

/**
 * 1人の月ごとの見込み（fromYm から months か月）。純粋な計算（テストできる）。
 * homeLeaves: 承認済みの一時帰国 [開始日, 終了日]
 */
export function projectWorker(
  w: Worker,
  fromYm: string,
  months: number,
  homeLeaves: { startDate: string; endDate: string }[] = [],
): ProjectedMonth[] {
  const out: ProjectedMonth[] = []
  const nat = nationalityOf(w)
  const hireYm = isDateIso(w.hireDate) ? w.hireDate!.slice(0, 7) : null
  const retiredDate = isDateIso(w.retired) ? w.retired! : w.retired ? '0000-00-00' : null // 'true' など日付でない退職は、もういない
  let grade = (w.jpGrade && JP_GRADES.has(w.jpGrade) ? w.jpGrade : null) as JpGrade | null
  let step = grade ? Math.min(MAX_STEP, Math.max(1, w.jpStep || (w.rate ? stepForDaily(grade, w.rate) : 1))) : 0
  let hourly = w.hourlyRate || 0
  const monthlySalary = w.salary || 0

  for (let i = 0; i < months; i++) {
    const ym = ymAdd(fromYm, i)
    const first = `${ym}-01`
    const last = `${ym}-28`
    // ── 昇給（その月の1日に効く。見込みの最初の月は今の台帳の額のまま） ──
    if (i > 0) {
      if (nat === 'jp' && grade && ym.endsWith('-10')) {
        const tenureOk = !hireYm || monthsDiff(hireYm, ym) >= PROJECTION_ASSUMPTIONS.jpFirstRevisionMinMonths
        if (tenureOk) {
          const age = isDateIso(w.birthDate) ? ageOn(w.birthDate!, first) : 35
          const pitch = Math.max(0, HYOGO_PITCH[PROJECTION_ASSUMPTIONS.jpHyogo] + ageAdjustment(age, grade))
          step = Math.min(MAX_STEP, step + pitch)
        }
      }
      if (nat === 'vn' && hourly > 0 && hireYm && ym.slice(5) === hireYm.slice(5) && ym > hireYm) {
        const yearsBefore = Math.floor(monthsDiff(hireYm, ym) / 12) - 1
        hourly += Math.round(curveRaiseAt(Math.max(0, yearsBefore)) * PROJECTION_ASSUMPTIONS.vnRaiseMultiplier)
      }
      // 日本人の新卒（月給・号俸なし）: 入社1年たったら 1G の月給と同じくらいの号へ
      if (nat === 'jp' && !grade && monthlySalary > 0 && hireYm && monthsDiff(hireYm, ym) === 12) {
        grade = '1G'
        step = stepForDaily('1G', (monthlySalary * 12) / PROJECTION_ASSUMPTIONS.jpPaidDaysPerYear)
      }
    }
    const active = (!hireYm || hireYm <= ym) && (!retiredDate || retiredDate >= last)
    const homeLeave = active && homeLeaves.some((h) => h.startDate <= first && h.endDate >= `${ym}-31`)
    let pay = 0
    if (active && !homeLeave) {
      if (grade) pay = Math.round((dailyForStep(grade, step) * PROJECTION_ASSUMPTIONS.jpPaidDaysPerYear) / 12)
      else if (nat === 'jp' && w.rate) pay = Math.round((w.rate * PROJECTION_ASSUMPTIONS.jpPaidDaysPerYear) / 12)
      else if (hourly > 0) pay = Math.round(hourly * PROJECTION_ASSUMPTIONS.vnMonthlyHours)
      else if (monthlySalary > 0) pay = monthlySalary
    }
    out.push({ ym, active, homeLeave, pay, ...(grade ? { jpGrade: grade, jpStep: step } : {}), ...(hourly > 0 ? { hourly } : {}) })
  }
  return out
}

function monthsDiff(fromYm: string, toYm: string): number {
  const [a, b] = fromYm.split('-').map(Number)
  const [c, d] = toYm.split('-').map(Number)
  return (c - a) * 12 + (d - b)
}

/** 月の見込みを期（10月〜9月）ごとに足す。会社負担の社会保険は年の基本給から */
export function sumByFiscalYear(months: ProjectedMonth[], age: number | null): IntegrationWorker['years'] {
  const by = new Map<number, { pay: number; activeMonths: number }>()
  for (const m of months) {
    const [y, mo] = m.ym.split('-').map(Number)
    const fy = mo >= 10 ? y : y - 1
    const cur = by.get(fy) ?? { pay: 0, activeMonths: 0 }
    cur.pay += m.pay
    if (m.active && !m.homeLeave) cur.activeMonths += 1
    by.set(fy, cur)
  }
  return [...by.entries()].map(([fyStart, v], i) => {
    // 社会保険は年の額で上限を見る（在籍した月数で年に直してから掛け、月数分に戻す）
    const annualized = v.activeMonths > 0 ? (v.pay / v.activeMonths) * 12 : 0
    const welfareYear = employerWelfare(annualized, age === null ? null : age + i, DEFAULT_WELFARE_RATES)
    const welfare = Math.round((welfareYear * v.activeMonths) / 12)
    return { fyStart, pay: v.pay, welfare, total: v.pay + welfare, activeMonths: v.activeMonths }
  })
}

export interface IntegrationWorkersResult {
  generatedAt: string
  /** 見込みの最初の月（YYYY-MM） */
  fromYm: string
  months: number
  assumptions: typeof PROJECTION_ASSUMPTIONS & { welfareRates: typeof DEFAULT_WELFARE_RATES }
  /** これから採る人の目安（等級ごとの初任の日額・ベトナム人の初任の時給） */
  starting: { jpDailyByGrade: Record<string, number>; vnHourly: number }
  workers: IntegrationWorker[]
}

/** 台帳と帰国・締めの記録から、返す形を組み立てる（純粋な計算） */
export function buildWorkersResult(input: {
  workers: Worker[]
  homeLeaves: { workerId: number; startDate: string; endDate: string }[]
  lastClosed: Map<number, { ym: string; totalCost: number }>
  fromYm: string
  months: number
  todayIso: string
}): IntegrationWorkersResult {
  const firstDay = `${input.fromYm}-01`
  const workers = input.workers
    // 見込みの最初の月より前に辞めた人は返さない（日付でない古い退職の印も）
    .filter((w) => !w.retired || (isDateIso(w.retired) && w.retired >= firstDay))
    .filter((w) => (w.jobType || '') !== 'yakuin')
    .map((w): IntegrationWorker => {
      const nat = nationalityOf(w)
      const age = isDateIso(w.birthDate) ? ageOn(w.birthDate!, firstDay) : null
      const months = projectWorker(w, input.fromYm, input.months, input.homeLeaves.filter((h) => h.workerId === w.id))
      const job = w.jobType || ''
      return {
        id: w.id,
        name: w.name,
        company: w.company === 'HFU' ? 'hfu' : 'hbk',
        nationality: nat,
        job,
        visaType: w.visaType || 'none',
        visaExpiry: w.visaExpiry || null,
        hireDate: w.hireDate || null,
        retired: w.retired || null,
        age,
        dispatchTo: w.dispatchTo || null,
        field: job !== 'jimu' && w.id !== 0 && w.id !== 1,
        pay: w.jpGrade
          ? { kind: 'daily', daily: w.rate, jpGrade: w.jpGrade, jpStep: w.jpStep }
          : w.hourlyRate
            ? { kind: 'hourly', hourly: w.hourlyRate }
            : w.salary
              ? { kind: 'monthly', monthly: w.salary }
              : w.rate
                ? { kind: 'daily', daily: w.rate }
                : { kind: 'none' },
        lastClosed: input.lastClosed.get(w.id) ?? null,
        months,
        years: sumByFiscalYear(months, age),
      }
    })
  return {
    generatedAt: new Date().toISOString(), // utc-ok（記録の時刻）
    fromYm: input.fromYm,
    months: input.months,
    assumptions: { ...PROJECTION_ASSUMPTIONS, welfareRates: DEFAULT_WELFARE_RATES },
    starting: {
      jpDailyByGrade: Object.fromEntries((['1G', '2G', '3G', '4G', '5G', '6G', 'doko'] as JpGrade[]).map((g) => [g, dailyForStep(g, 1)])),
      // 実際の入社時給は最賃を10円に切り上げた額のあたり（2026-08 実勢 1,270円）
      vnHourly: Math.ceil(minWageAt(input.todayIso) / 10) * 10,
    },
    workers,
  }
}

/** 台帳・帰国・締めの記録を読んで組み立てる（サーバーだけ）。months は既定 72（今月から6年） */
export async function loadIntegrationWorkers(opts: { months?: number } = {}): Promise<IntegrationWorkersResult> {
  const [{ getMainData }, { mapRawWorkers }, { getAllActiveHomeLeaves }, { db }, { doc, getDoc }, { todayJstIso, currentYmJst }] = await Promise.all([
    import('@/lib/compute'),
    import('@/lib/workers'),
    import('@/lib/homeLeave'),
    import('@/lib/firebase'),
    import('@/lib/fsdb'),
    import('@/lib/date-utils'),
  ])
  const today = todayJstIso()
  const ym6 = currentYmJst()
  const fromYm = `${ym6.slice(0, 4)}-${ym6.slice(4)}`
  const [main, homeLeaves] = await Promise.all([getMainData(), getAllActiveHomeLeaves()])
  const workers = mapRawWorkers(main.workers as unknown[])

  // 締めた直近の月の支給額（残業・手当込み）。今月の前の4か月から、新しい月を優先して1人1つ
  const lastClosed = new Map<number, { ym: string; totalCost: number }>()
  for (let back = 1; back <= 4; back++) {
    const ym = ymAdd(fromYm, -back)
    const key = ym.replace('-', '')
    for (const org of ['hibi', 'hfu', 'all']) {
      const snap = await getDoc(doc(db, 'payrollSnapshots', `${key}_${org}`)).catch(() => null)
      if (!snap?.exists()) continue
      const data = snap.data() as { workers?: { id: number; totalCost?: number }[] }
      for (const w of data.workers ?? []) {
        if (!lastClosed.has(w.id) && typeof w.totalCost === 'number' && w.totalCost > 0) lastClosed.set(w.id, { ym, totalCost: w.totalCost })
      }
    }
  }
  return buildWorkersResult({ workers, homeLeaves, lastClosed, fromYm, months: Math.min(120, Math.max(1, opts.months ?? 72)), todayIso: today })
}
