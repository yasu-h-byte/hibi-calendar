/**
 * 賃金分析（代表専用）の計算ロジック
 *
 * 目的: ベトナム人スタッフの「在籍年数に対して相対的に高い／低い」を複数の基準で判定する。
 * 今後の昇給評価（docs/evaluation-system.md）とは別軸の参考資料。
 *
 * ⚠️ 個人の賃金データを扱うため、呼び出し側で必ず代表（workerId=0）に限定すること。
 */

/**
 * 東京都 地域別最低賃金の推移（発効日ベース）。
 *
 * 出典: 厚生労働省／東京労働局の公示。2社の推移表で照合済み（2026-08）。
 * 2020年はコロナ禍により改定なし（2019年の1,013円が継続）。
 *
 * ⚠️ 毎年10月に改定される。改定のたびに1行追加すること。
 */
export const TOKYO_MIN_WAGE: { from: string; yen: number }[] = [
  { from: '2015-10-01', yen: 907 },
  { from: '2016-10-01', yen: 932 },
  { from: '2017-10-01', yen: 958 },
  { from: '2018-10-01', yen: 985 },
  { from: '2019-10-01', yen: 1013 },
  { from: '2020-10-01', yen: 1013 }, // 改定なし
  { from: '2021-10-01', yen: 1041 },
  { from: '2022-10-01', yen: 1072 },
  { from: '2023-10-01', yen: 1113 },
  { from: '2024-10-01', yen: 1163 },
  { from: '2025-10-03', yen: 1226 },
]

/** 指定日に適用されていた東京都最低賃金 */
export function minWageAt(dateIso: string): number {
  let v = TOKYO_MIN_WAGE[0].yen
  for (const r of TOKYO_MIN_WAGE) if (r.from <= dateIso) v = r.yen
  return v
}

/** 現時点の東京都最低賃金 */
export function currentMinWage(todayIso: string): number {
  return minWageAt(todayIso)
}

/** 10円単位に切り上げ（起点時給の丸め） */
export function roundUp10(v: number): number {
  return Math.ceil(v / 10) * 10
}

/**
 * 在留資格の段階。
 * 1年目=実習1号 / 2〜3年目=実習2号 / 4〜5年目=実習3号 / 6〜10年目=特定1号 / 8年目以降の試験合格者=特定2号
 * 在籍年数に直すと 0-1 / 1-3 / 3-5 / 5- となる。
 */
export const STAGES = [
  { key: '実習1号', years: '1年目', from: 0, to: 1 },
  { key: '実習2号', years: '2〜3年目', from: 1, to: 3 },
  { key: '実習3号', years: '4〜5年目', from: 3, to: 5 },
  { key: '特定技能1号', years: '6〜10年目', from: 5, to: 10.5 },
  { key: '特定技能2号', years: '8年目〜・試験合格', from: 7, to: 99 },
] as const

/* ────────────────────────────────────────────────
   昇給モデル（今後の設計値）
   ──────────────────────────────────────────────── */

/** 目標とする年平均昇給率。10年在籍で約2倍になる水準（2026-08 代表確定）。 */
export const MODEL_RAISE_RATE = 0.07

/** モデル上の時給 = 起点 × (1 + 率)^年 */
export function modelWage(start: number, years: number, rate = MODEL_RAISE_RATE): number {
  return start * Math.pow(1 + rate, years)
}

/**
 * 建設分野 特定技能1号の報酬に関する法令要件。
 *
 * 出典: 国土交通省 不動産・建設経済局 国際市場課長通知
 *       「建設特定技能受入計画における報酬額の認定について」
 *       国不国第654号（令和4年3月28日）／令和4年6月1日以降の申請に適用
 *
 * ① 報酬額（1-②③）:
 *    所定内賃金 ÷ 一月当たり所定労働時間 が、事業所の所在地の地域別最低賃金に
 *    1.1 を乗じた額（または地域別最低賃金の全国加重平均に1.1を乗じた額）を
 *    下回ってはならない。
 * ② 定期昇給（2-②）:
 *    定期昇給を予定していないと認定されない。さらに「一年当たりに見込まれる
 *    一月当たり所定内賃金の上昇額が千円未満」だと実質的な定期昇給と認められない。
 * ③ 支払方法: 1号特定技能外国人への報酬は全て月給制であることが前提。
 */
export const KENSETSU_TOKUTEI = {
  /** 地域別最低賃金に乗じる係数 */
  minWageMultiplier: 1.1,
  /** 定期昇給として認められる月額所定内賃金の年間上昇額の下限（円） */
  minAnnualRaiseMonthly: 1000,
  source: '国土交通省 国不国第654号（令和4年3月28日）',
} as const

/**
 * 外部の賃金参考データ。
 *
 * 出典: 厚生労働省「令和6年賃金構造基本統計調査（外国人労働者）」ほか。
 * ⚠️ いずれも全国値。首都圏のみに絞った公表値は見当たらないため、
 *    東京都は地域別最低賃金が全国最高であることを踏まえて割り引いて読むこと。
 */
export const MARKET_REFERENCE = [
  { label: '技能実習（全産業）', monthly: 182700, note: '令和6年 賃金構造基本統計調査' },
  { label: '技能実習（建設業）', monthly: 203025, note: '令和5年度' },
  { label: '特定技能（全産業）', monthly: 211200, note: '令和6年 賃金構造基本統計調査' },
  { label: '外国人労働者 全体', monthly: 242700, note: '令和6年 賃金構造基本統計調査' },
] as const

export interface WageRow {
  id: number
  name: string
  visa: string
  hireDate: string
  hourly: number
  /** 在籍年数 */
  years: number
  /** 制度上の段階 index（STAGES の添字） */
  stage: number
  /** 段階が在留資格と一致しない例外（試験不合格による早期移行など） */
  stageException?: boolean
  /** 入社時の東京都最低賃金 */
  hireMinWage: number
  /** 起点時給（入社時最低賃金を10円切上げ） */
  startWage: number
  /** 起点からの年平均昇給率（複利, %） */
  cagr: number | null
  /** 同期間の最低賃金上昇率（複利, %） */
  minWageCagr: number | null
  /** 実質（昇給率 − 最賃上昇率, ポイント） */
  realGain: number | null
  /** 現在の最低賃金に対する倍率 */
  vsMinWage: number
  /** 基準A: 同じ段階の平均との差 */
  devStage: number
  /** 基準B: 全体傾向線との差 */
  devTrend: number
  /** 基準C: 同期入社者の平均との差 */
  devCohort: number | null
  /** 3基準すべてで低い */
  allLow: boolean
  /** 3基準すべてで高い */
  allHigh: boolean
  /** 7%モデル上の時給（起点＝新規入社の時給） */
  model: number
  /** モデルとの差（＋なら今後の昇給を抑える余地あり） */
  devModel: number
}

export interface WageAnalysis {
  rows: WageRow[]
  stageAvg: number[]
  /** 全体傾向線 y = a + b * 年 */
  trend: { a: number; b: number }
  overallAvg: number
  currentMinWage: number
  /** 判定のしきい値（±この額を超えたら高い／低いとみなす） */
  threshold: number
  /** 昇給モデルの起点時給（＝在籍0年の人の時給。いなければ最低賃金×1.04で代用） */
  modelStart: number
  /** 特定技能1号の報酬下限（地域別最低賃金 × 1.1） */
  tokuteiFloor: number
}

/**
 * 制度上の段階を求める。
 *
 * 実習1号〜特定技能1号は在籍年数で決まるが、**特定技能2号だけは試験合格が要件**で
 * 年数からは判定できないため、在留資格が tokutei2 のときだけ段階4とする。
 *
 * @param years    在籍年数
 * @param visaType Worker.visaType（'tokutei2' のときのみ特別扱い）
 */
export function stageOf(years: number, visaType?: string): number {
  if (visaType === 'tokutei2') return 4
  if (years < 1) return 0
  if (years < 3) return 1
  if (years < 5) return 2
  return 3
}

export interface WageInput {
  id: number
  name: string
  visaType: string
  hireDate: string
  hourlyRate?: number
  retired?: string
}

const VISA_LABEL: Record<string, string> = {
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号', jisshu: '実習',
  tokutei1: '特定1号', tokutei2: '特定2号',
}

/**
 * 賃金分析を組み立てる。
 *
 * @param workers  対象スタッフ（外国人・時給が判明している在籍者）
 * @param todayIso 基準日 YYYY-MM-DD
 * @param threshold 高い／低いと判定する差額のしきい値（円）
 */
export function buildWageAnalysis(
  workers: WageInput[],
  todayIso: string,
  threshold = 20,
): WageAnalysis {
  const nowMw = currentMinWage(todayIso)
  const today = new Date(todayIso + 'T00:00:00Z').getTime()

  const base = workers.map(w => {
    const years = w.hireDate
      ? Math.max(0, (today - new Date(w.hireDate + 'T00:00:00Z').getTime()) / (365.25 * 86400000))
      : 0
    const yr = Math.round(years * 10) / 10
    const mw = minWageAt(w.hireDate || todayIso)
    const start = roundUp10(mw)
    const h = w.hourlyRate ?? 0
    // 在留資格が示す段階と、在籍年数が示す段階がズレる場合がある
    // （例: 試験不合格で実習3号に上がれず特定技能へ早期移行）。実態は在籍年数側。
    const stage = stageOf(yr, w.visaType)
    const visaStage = ['実習1号', '実習2号', '実習3号', '特定1号', '特定2号']
      .indexOf(VISA_LABEL[w.visaType] || '')
    return {
      id: w.id, name: w.name, visa: VISA_LABEL[w.visaType] || w.visaType,
      hireDate: w.hireDate, hourly: h, years: yr, stage,
      stageException: visaStage >= 0 && visaStage !== stage,
      hireMinWage: mw, startWage: start,
      cagr: yr > 0.5 && h > 0 ? (Math.pow(h / start, 1 / yr) - 1) * 100 : null,
      minWageCagr: yr > 0.5 ? (Math.pow(nowMw / mw, 1 / yr) - 1) * 100 : null,
      vsMinWage: h / nowMw,
    }
  })

  // 段階ごとの平均
  const stageAvg = [0, 1, 2, 3, 4].map(i => {
    const m = base.filter(b => b.stage === i)
    return m.length ? m.reduce((a, b) => a + b.hourly, 0) / m.length : 0
  })

  // 全体傾向線（新入社＝在籍0.5年未満は除外。起点が違うため線が歪む）
  const ex = base.filter(b => b.years > 0.5)
  let a = 0, b1 = 0
  if (ex.length > 1) {
    const n = ex.length
    const sx = ex.reduce((s, r) => s + r.years, 0)
    const sy = ex.reduce((s, r) => s + r.hourly, 0)
    const sxy = ex.reduce((s, r) => s + r.years * r.hourly, 0)
    const sxx = ex.reduce((s, r) => s + r.years * r.years, 0)
    const den = n * sxx - sx * sx
    if (den !== 0) { b1 = (n * sxy - sx * sy) / den; a = (sy - b1 * sx) / n }
  }

  // 同期（入社年月が同じ）
  const cohort: Record<string, typeof base> = {}
  base.forEach(r => {
    const k = (r.hireDate || '').slice(0, 7)
    ;(cohort[k] = cohort[k] || []).push(r)
  })

  // 昇給モデルの起点は「いま入社した人の時給」。該当者がいなければ最低賃金から推定。
  const newest = base.filter(b => b.years < 0.5).sort((x, y) => y.hourly - x.hourly)[0]
  const modelStart = newest ? newest.hourly : Math.round(nowMw * 1.04)

  const rows: WageRow[] = base.map(r => {
    const devStage = r.hourly - stageAvg[r.stage]
    const devTrend = r.hourly - (a + b1 * r.years)
    const peers = (cohort[(r.hireDate || '').slice(0, 7)] || []).filter(p => p.id !== r.id)
    const devCohort = peers.length
      ? r.hourly - peers.reduce((s, p) => s + p.hourly, 0) / peers.length
      : null
    const ds = [devStage, devTrend, devCohort].filter((v): v is number => v !== null)
    const model = modelWage(modelStart, r.years)
    return {
      ...r,
      realGain: r.cagr !== null && r.minWageCagr !== null ? r.cagr - r.minWageCagr : null,
      devStage, devTrend, devCohort,
      allLow: ds.length > 1 && ds.every(v => v < -threshold),
      allHigh: ds.length > 1 && ds.every(v => v > threshold),
      model, devModel: r.hourly - model,
    }
  })

  return {
    rows,
    stageAvg,
    trend: { a, b: b1 },
    overallAvg: rows.length ? rows.reduce((s, r) => s + r.hourly, 0) / rows.length : 0,
    currentMinWage: nowMw,
    threshold,
    modelStart,
    tokuteiFloor: nowMw * KENSETSU_TOKUTEI.minWageMultiplier,
  }
}
