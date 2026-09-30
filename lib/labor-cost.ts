/**
 * 人件費（法定福利費の会社負担を含む）の年額の見込み（2026-09-30 代表依頼）
 *
 * 日本人の年次改定で「改定すると会社の負担が年間いくら増えるか」を見るための概算。
 * 実際の保険料は標準報酬月額（等級）で決まり、定時決定・随時改定の時期もずれるので、
 * ここは「年収 ÷ 12 を月額とみなし、料率を掛ける」だけの目安にとどめる。
 *
 * 料率は加入先（協会けんぽか建設国保か等）・年度で変わるので、画面で変えられるようにして
 * 既定値はここに置く。労災保険は、建設業の下請では元請の現場労災で賄われるので含めない。
 */

export interface WelfareRates {
  /** 厚生年金 会社負担（%） */
  pension: number
  /** 健康保険 会社負担（%） */
  health: number
  /** 介護保険 会社負担（%・40〜64歳だけ） */
  care: number
  /** 雇用保険 会社負担（%） */
  employment: number
  /** 子ども・子育て拠出金（%・会社のみ） */
  childContribution: number
  /** 子ども・子育て支援金 会社負担（%・2026年4月〜） */
  childSupport: number
}

/** 既定値（2026年度の目安・協会けんぽ東京・建設の事業）。画面で上書きできる */
export const DEFAULT_WELFARE_RATES: WelfareRates = {
  pension: 9.15,
  health: 4.955,
  care: 0.795,
  employment: 1.1,
  childContribution: 0.36,
  childSupport: 0.115,
}

export const WELFARE_RATE_LABELS: Record<keyof WelfareRates, string> = {
  pension: '厚生年金',
  health: '健康保険',
  care: '介護保険（40〜64歳）',
  employment: '雇用保険',
  childContribution: '子ども・子育て拠出金',
  childSupport: '子ども・子育て支援金',
}

/** 標準報酬月額の上限（厚生年金 65万円・健康保険 139万円） */
export const PENSION_MONTHLY_CAP = 650_000
export const HEALTH_MONTHLY_CAP = 1_390_000

/**
 * 年収に対する会社負担の法定福利費（年額・円）。
 * 年収 ÷ 12 を月額とみなし、厚生年金・健康保険（＋介護・支援金）は標準報酬の上限で頭打ちにする。
 * 子ども・子育て拠出金は厚生年金と同じ標準報酬（上限も同じ）、雇用保険は上限なし。
 */
export function employerWelfare(annualPay: number, age: number | null, r: WelfareRates): number {
  if (annualPay <= 0) return 0
  const monthly = annualPay / 12
  const pensionBase = Math.min(monthly, PENSION_MONTHLY_CAP) * 12
  const healthBase = Math.min(monthly, HEALTH_MONTHLY_CAP) * 12
  const careApplies = age !== null && age >= 40 && age < 65
  const pct = (v: number) => v / 100
  return Math.round(
    pensionBase * pct(r.pension + r.childContribution)
    + healthBase * pct(r.health + r.childSupport + (careApplies ? r.care : 0))
    + annualPay * pct(r.employment),
  )
}

export interface LaborCostRow {
  prevAnnual: number
  newAnnual: number
  payIncrease: number
  prevWelfare: number
  newWelfare: number
  welfareIncrease: number
  /** 人件費の増加（給与＋法定福利費） */
  totalIncrease: number
}

/** 1人分の新旧比較（年額）。日額 × 年間の支払日数 */
export function laborCostDelta(
  prevDaily: number, newDaily: number, paidDays: number, age: number | null, r: WelfareRates,
): LaborCostRow {
  const prevAnnual = prevDaily * paidDays
  const newAnnual = newDaily * paidDays
  const prevWelfare = employerWelfare(prevAnnual, age, r)
  const newWelfare = employerWelfare(newAnnual, age, r)
  return {
    prevAnnual, newAnnual, payIncrease: newAnnual - prevAnnual,
    prevWelfare, newWelfare, welfareIncrease: newWelfare - prevWelfare,
    totalIncrease: newAnnual - prevAnnual + newWelfare - prevWelfare,
  }
}

export function totalWelfarePercent(r: WelfareRates, withCare: boolean): number {
  return r.pension + r.health + r.employment + r.childContribution + r.childSupport + (withCare ? r.care : 0)
}
