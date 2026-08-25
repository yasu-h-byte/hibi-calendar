/**
 * 賃金分析（代表専用）の計算ロジック
 *
 * 目的: ベトナム人スタッフの「在籍年数に対して相対的に高い／低い」を複数の基準で判定する。
 * 今後の昇給評価（docs/evaluation-system.md）とは別軸の参考資料。
 *
 * ⚠️ 個人の賃金データを扱うため、呼び出し側で必ず代表（workerId=0）に限定すること。
 *
 * 昇給カーブと改定予定の定義は `lib/wage-curve.ts` にある（単一の真理）。ここでは参照のみ。
 */

import {
  curveWage, curveStartFor, revisedHourly, pendingChangesFor,
  SCHEDULED_WAGE_CHANGES, WAGE_REVISION_2026_10, MONTHLY_HOURS,
} from './wage-curve'

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

/**
 * 旧モデルの年平均昇給率（10年在籍で約2倍）。
 *
 * ⚠️ 2026-08-12 に **逓減定額カーブ（`lib/wage-curve.ts`）へ置き換え済み**。
 *    複利は基本給が上がるほど昇給額が膨らみ若手が薄くなるため不採用となった。
 *    ここに残しているのは新旧を並べて比較するためだけ。新しい計算に使わないこと。
 */
export const MODEL_RAISE_RATE = 0.07

/** 旧モデル上の時給 = 起点 × (1 + 率)^年。比較表示専用。 */
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

/* ────────────────────────────────────────────────
   個別事情の注記
   ──────────────────────────────────────────────── */

/**
 * 数字だけでは読み違える人の背景。
 *
 * この分析は在籍年数と時給しか見ないため、経歴に事情がある人は「不当に低い」と
 * 出てしまう。事情が分かっているものはここに書いて、フラグの横に理由が並ぶようにする。
 * **フラグから除外はしない**（見えなくすると解消の検討自体が忘れられるため）。
 *
 * `serviceYears` を入れると在籍年数をその値で上書きし、カーブとの比較も実態に合う。
 * 分からないうちは未設定にしておき、注記だけ出す。
 */
export const WAGE_CONTEXT: Record<number, {
  /** 一覧に出す短いラベル */
  label: string
  /** フラグの下に出す説明 */
  detail: string
  /** 実質の在籍年数（ブランクを除いた通算）。分かったら入れる */
  serviceYears?: number
}> = {
  105: {
    label: '再入社',
    detail: '一度退職して復帰した経緯があり、ブランクの分だけ同時期入社の他スタッフより低い。'
      + '在籍年数は最初の入社日からの通算なので、カーブとの差はその分だけ大きく出る。'
      + '将来的に解消する方針（時期未定）。退職・再入社の日付が分かれば serviceYears に入れると実態に合う。',
  },
}

export interface WageRow {
  id: number
  name: string
  visa: string
  hireDate: string
  /** 分析に使っている時給（basis により現在値または改定後） */
  hourly: number
  /** 人員マスタの現在値。basis に関わらず常に現在の額 */
  currentHourly: number
  /** 在籍年数 */
  years: number
  /** 制度上の段階 index（STAGES の添字） */
  stage: number
  /** 段階が在留資格と一致しない例外（試験不合格による早期移行など） */
  stageException?: boolean
  /** 個別事情の注記（再入社によるブランクなど）。WAGE_CONTEXT の該当分 */
  context?: (typeof WAGE_CONTEXT)[number]
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
  /** 旧7%複利モデル上の時給。比較表示専用 */
  model: number
  /** 旧モデルとの差 */
  devModel: number
  /** 現行カーブ（160円−8円×年）上の時給 */
  curve: number
  /** カーブとの差（＋＝カーブより高い／−＝カーブに届いていない） */
  devCurve: number
  /** 予定されている賃金改定の対象者か（事由は問わない） */
  revisionTarget: boolean
  /** その人に当たる予定の名前（「技能実習3号 移行」「2026年10月 一律改定」など） */
  changeLabels: string[]
  /** 予定をすべて織り込んだ改定後の時給（対象外なら現在の時給と同じ） */
  revised: number
  /** 改定による時給の上げ幅 */
  revisionGain: number
  /** 改定後のカーブとの差 */
  devCurveRevised: number
}

/* ────────────────────────────────────────────────
   逆転・外れ値チェック（異常値検出）
   ──────────────────────────────────────────────── */

export interface InversionPair {
  /** 在籍が長いのに時給が低い側 */
  senior: WageRow
  /** 在籍が短いのに時給が高い側 */
  junior: WageRow
  /** 時給差（junior − senior、常に正） */
  gap: number
}

/**
 * 「在籍が長いのに時給が低い」逆転ペアを全数列挙する（Kendall の不一致対）。
 *
 * τ（タウ）は順位相関: 1 なら完全に「長いほど高い」。0.9 超なら強い正相関。
 * 同時給のペアはどちらにも数えない。
 *
 * @param minYearGap 在籍差がこれ以下のペアは比較しない（誤差扱い）
 */
export function findInversions(rows: WageRow[], minYearGap = 0.3): {
  pairs: InversionPair[]; concordant: number; discordant: number; tau: number
} {
  const pairs: InversionPair[] = []
  let concordant = 0, discordant = 0
  for (const a of rows) for (const b of rows) {
    if (a.years - b.years <= minYearGap) continue
    if (a.hourly > b.hourly) concordant++
    else if (a.hourly < b.hourly) { discordant++; pairs.push({ senior: a, junior: b, gap: b.hourly - a.hourly }) }
  }
  pairs.sort((p, q) => q.gap - p.gap)
  const total = concordant + discordant
  return { pairs, concordant, discordant, tau: total ? (concordant - discordant) / total : 1 }
}

export interface StageOutliers {
  stage: number
  q1: number
  q3: number
  /** Q1 − 1.5×IQR を下回る人 */
  low: WageRow[]
  /** Q3 + 1.5×IQR を上回る人 */
  high: WageRow[]
}

/** 段階内の IQR 法（箱ひげ基準）による外れ値。3名以上の段階のみ判定する。 */
export function stageIQROutliers(rows: WageRow[]): StageOutliers[] {
  const out: StageOutliers[] = []
  for (const stage of [0, 1, 2, 3, 4]) {
    const m = rows.filter(r => r.stage === stage)
    if (m.length < 3) continue
    const hs = m.map(r => r.hourly).sort((a, b) => a - b)
    const q1 = hs[Math.floor((hs.length - 1) * 0.25)]
    const q3 = hs[Math.ceil((hs.length - 1) * 0.75)]
    const iqr = q3 - q1
    const low = m.filter(r => r.hourly < q1 - 1.5 * iqr)
    const high = m.filter(r => r.hourly > q3 + 1.5 * iqr)
    if (low.length || high.length) out.push({ stage, q1, q3, low, high })
  }
  return out
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
  /** 旧7%複利モデルの起点時給（＝在籍0年の人の時給。いなければ最低賃金×1.04で代用）。比較表示専用 */
  modelStart: number
  /** カーブの起点時給（＝現在の東京都最低賃金を10円切上げ） */
  curveStart: number
  /**
   * 実際の新規入社時給（在籍0.5年未満の最高額）。該当者がいなければ null。
   * カーブ起点との差が「入社時点でカーブより上か下か」を表す。
   */
  entryWage: number | null
  /** 予定されている賃金改定の集計 */
  revision: {
    /** 事由ごとの内訳（実施日順） */
    changes: {
      id: string
      effective: string
      label: string
      reason: string
      /** 一律の率で決めた改定ならその率 */
      rate?: number
      /** 対象者数 */
      count: number
      /** まだマスタに反映されていない人数 */
      pending: number
      /** この改定による年間人件費の増加（月額換算 × 12） */
      annualCost: number
    }[]
    /** 全予定の対象者（重複を除く）人数 */
    count: number
    /** まだマスタに反映されていない人数 */
    pending: number
    /** 全予定あわせた年間人件費の増加 */
    annualCost: number
  }
  /** 特定技能1号の報酬下限（地域別最低賃金 × 1.1） */
  tokuteiFloor: number
  /** 分析の基準日 YYYY-MM-DD。「実施日を過ぎたか」の判定はこれを使う */
  todayIso: string
  /** 何の時給で集計しているか */
  basis: WageBasis
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
/**
 * 分析の基準となる時給。
 *
 * - `current`  … 人員マスタの現在値。いま給与計算に使われている額
 * - `revised`  … 予定されている改定をすべて織り込んだ額。「改定後はどうなるか」を見る用
 *
 * 改定の実施日を過ぎてマスタが更新されれば両者は一致するので、その後はどちらでも同じ。
 */
export type WageBasis = 'current' | 'revised'

export function buildWageAnalysis(
  workers: WageInput[],
  todayIso: string,
  threshold = 20,
  basis: WageBasis = 'current',
): WageAnalysis {
  const nowMw = currentMinWage(todayIso)
  const today = new Date(todayIso + 'T00:00:00Z').getTime()

  const base = workers.map(w => {
    const years = w.hireDate
      ? Math.max(0, (today - new Date(w.hireDate + 'T00:00:00Z').getTime()) / (365.25 * 86400000))
      : 0
    // 実質の在籍年数が分かっている人（再入社など）はそちらを優先する
    const ctx = WAGE_CONTEXT[w.id]
    const yr = ctx?.serviceYears ?? Math.round(years * 10) / 10
    const mw = minWageAt(w.hireDate || todayIso)
    const start = roundUp10(mw)
    const currentHourly = w.hourlyRate ?? 0
    const revised = revisedHourly(w.id, currentHourly)
    // 段階平均・傾向線・昇給率・逆転判定など、以降の集計はすべて h を使う。
    // basis を切り替えるとページ全体が改定後の姿で計算される。
    const h = basis === 'revised' ? revised : currentHourly
    // 在留資格が示す段階と、在籍年数が示す段階がズレる場合がある
    // （例: 試験不合格で実習3号に上がれず特定技能へ早期移行）。実態は在籍年数側。
    const stage = stageOf(yr, w.visaType)
    const visaStage = ['実習1号', '実習2号', '実習3号', '特定1号', '特定2号']
      .indexOf(VISA_LABEL[w.visaType] || '')
    return {
      id: w.id, name: w.name, visa: VISA_LABEL[w.visaType] || w.visaType,
      hireDate: w.hireDate, hourly: h, currentHourly, revised, years: yr, stage,
      stageException: visaStage >= 0 && visaStage !== stage,
      context: ctx,
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

  // 旧モデルの起点は「いま入社した人の時給」。該当者がいなければ最低賃金から推定。
  const newest = base.filter(b => b.years < 0.5).sort((x, y) => y.hourly - x.hourly)[0]
  const modelStart = newest ? newest.hourly : Math.round(nowMw * 1.04)
  // カーブの起点は最賃連動（個人の契約時給に左右されないようにするため）
  const curveStart = curveStartFor(nowMw)

  const rows: WageRow[] = base.map(r => {
    const devStage = r.hourly - stageAvg[r.stage]
    const devTrend = r.hourly - (a + b1 * r.years)
    const peers = (cohort[(r.hireDate || '').slice(0, 7)] || []).filter(p => p.id !== r.id)
    const devCohort = peers.length
      ? r.hourly - peers.reduce((s, p) => s + p.hourly, 0) / peers.length
      : null
    const ds = [devStage, devTrend, devCohort].filter((v): v is number => v !== null)
    const model = modelWage(modelStart, r.years)
    const curve = curveWage(curveStart, r.years)
    return {
      ...r,
      realGain: r.cagr !== null && r.minWageCagr !== null ? r.cagr - r.minWageCagr : null,
      devStage, devTrend, devCohort,
      allLow: ds.length > 1 && ds.every(v => v < -threshold),
      allHigh: ds.length > 1 && ds.every(v => v > threshold),
      model, devModel: r.hourly - model,
      curve, devCurve: r.hourly - curve,
      revisionTarget: SCHEDULED_WAGE_CHANGES.some(c => c.targets[r.id] !== undefined),
      changeLabels: SCHEDULED_WAGE_CHANGES
        .filter(c => c.targets[r.id] !== undefined).map(c => c.label),
      revisionGain: r.revised - r.currentHourly,
      devCurveRevised: r.revised - curve,
    }
  })

  const targets = rows.filter(r => r.revisionTarget)
  const byId = new Map(rows.map(r => [r.id, r]))
  // 事由ごとの内訳。同じ人に複数の予定が当たる場合、コストは「その予定で実際に上がる分」
  // ＝ 予定額 − それまでに確定している額 で数える（二重計上を避ける）
  const changes = SCHEDULED_WAGE_CHANGES.map((c, ci) => {
    let annualCost = 0, pending = 0
    for (const id of Object.keys(c.targets).map(Number)) {
      const row = byId.get(id)
      if (!row) continue
      // この予定より前に確定している額（マスタの現在値 or 先行する予定の額）。
      // basis に左右されないよう currentHourly を使う
      const prior = SCHEDULED_WAGE_CHANGES.slice(0, ci)
        .reduce((v, p) => Math.max(v, p.targets[id] ?? 0), row.currentHourly)
      const gain = Math.max(0, c.targets[id] - prior)
      annualCost += gain * MONTHLY_HOURS * 12
      if (c.targets[id] > row.currentHourly) pending++
    }
    return {
      id: c.id, effective: c.effective, label: c.label, reason: c.reason, rate: c.rate,
      count: Object.keys(c.targets).filter(id => byId.has(Number(id))).length,
      pending, annualCost,
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
    curveStart,
    entryWage: newest ? newest.hourly : null,
    revision: {
      changes,
      count: targets.length,
      pending: targets.filter(r => r.revisionGain > 0).length,
      annualCost: targets.reduce((s, r) => s + r.revisionGain * MONTHLY_HOURS * 12, 0),
    },
    tokuteiFloor: nowMw * KENSETSU_TOKUTEI.minWageMultiplier,
    todayIso,
    basis,
  }
}
