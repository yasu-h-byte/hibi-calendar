/**
 * 平均日給の追跡（2026-11-14 代表「個々人の給与は毎年上がるけど、全体平均は新たな採用でキープする。その指標として把握したい」）。
 *
 * 基本単価（日額・時給・月給）を「1日いくら」にそろえ、日本人・外国人・全体の平均を毎月1日時点で記録する。
 * 割増・手当・欠勤・出勤日数は入れない（単価そのものの平均）。
 *
 * このファイルは**計算だけ**（個人のデータを持たない・画面からも import してよい）。
 * 記録の読み書きは lib/avg-wage.server.ts、渡すのは /api/wage-average（pay.view の3人だけ）。
 *
 * ## 日給へのそろえ方
 * | 区分 | 単価 | 日給 |
 * |---|---|---|
 * | 日本人（日給月給・旧契約） | rate（日額） | そのまま |
 * | 日本人（月給・新卒など） | salary | 月給 × 12 ÷ 310（給料表の「日給 × 310 = 年収」と同じ物差し） |
 * | 外国人（時給） | hourlyRate | 時給 × 7時間（給与計算の1日分と同じ・lib/compute-vn-salary.ts） |
 * | 外国人（固定月給） | salary | 月給 ÷ 20日（基本給の保証日数） |
 * | 外国人（日額だけ） | rate | そのまま |
 *
 * ## 平均が動いた理由（decomposeAverage）
 * 前の点 → 辞めた人を抜く → 続けている人の昇給 → 新しく入った人を足す → 今の点、の順にたどる。
 * 3つの差を足すと前後の平均の差にちょうど一致する（丸め前）。日本人と外国人の比率の変化は、
 * 「辞めた人」「入った人」の中に含まれる（外国人を多く採れば、入った人の効果が大きく下がる）。
 */

import { isEmployedOn } from './workers'

/** 外国人の1日の所定時間（給与計算の基本給・有給日給と同じ 7h） */
export const FOREIGN_HOURS_PER_DAY = 7
/** 日本人の年間の物差し（給料表の「ベース年収 = 日給 × 310」） */
export const JP_DAYS_PER_YEAR = 310
/** 外国人の固定月給の日数（基本給の保証 20日） */
export const FOREIGN_MONTHLY_DAYS = 20
/** 平均に入れない職種（現場で働く人だけを数える） */
export const AVG_WAGE_EXCLUDED_JOBS: readonly string[] = ['yakuin', 'jimu']
/**
 * 人員マスタから過去の点を組み立てる最初の月。
 * 人員マスタは「今の単価」と「1つ前の単価（prev*）」しか持たないので、さかのぼれるのは1回の改定ぶんだけ。
 * 2025年10月（日本人の前回の年次改定の時点）より前は資料からの取り込み（別途）で埋める。
 */
export const AVG_WAGE_RESTORE_FROM_YM = '202510'

export type WageGroup = 'jp' | 'foreign'
export type WageBasis = 'daily' | 'hourly' | 'monthly'
export type WageOrg = 'hibi' | 'hfu'

/** ある日の1人ぶん（記録に残す形。個人の単価なのでサーバーと pay.view の外に出さない） */
export interface WageRatePerson {
  id: number
  group: WageGroup
  org: WageOrg
  job: string
  /** 1日あたりの基本単価（円・整数） */
  daily: number
  basis: WageBasis
}

/** 毎月1日時点の記録（Firestore wageRateSnapshots/{YYYYMM}） */
export interface WageRateSnapshot {
  ym: string
  /** 何日時点の単価か 'YYYY-MM-01' */
  asOf: string
  /** cron = その月の1日に記録 ／ restored = 人員マスタの prev* からさかのぼって組み立てた（参考） */
  source: 'cron' | 'restored'
  takenAt: string
  people: WageRatePerson[]
}

export interface AvgFilter {
  org: 'all' | WageOrg
  /** 月給の人（新卒・固定月給）も入れるか */
  includeMonthly: boolean
}

export const DEFAULT_AVG_FILTER: AvgFilter = { org: 'all', includeMonthly: true }

export interface AvgStat {
  n: number
  avg: number | null
  min: number | null
  max: number | null
}

/** 人員マスタの生データ（demmen/main.workers の1件）のうち、ここで使う項目 */
export interface RawWageWorker {
  id: number
  org?: string
  visa?: string
  job?: string
  rate?: number
  hourlyRate?: number
  salary?: number
  hireDate?: string
  retired?: string | boolean
  rateFrom?: string
  prevRate?: number
  hourlyRateFrom?: string
  prevHourlyRate?: number
  salaryFrom?: string
  prevSalary?: number
}

export const ymToAsOf = (ym: string): string => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`

/** 'YYYYMM' の月を n か月ずらす */
export function shiftYm(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6)) - 1 + n
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1
  return `${yy}${String(mm).padStart(2, '0')}`
}

/** from から to まで（両端を含む）の 'YYYYMM' の並び */
export function ymRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let ym = from; ym <= to && out.length < 600; ym = shiftYm(ym, 1)) out.push(ym)
  return out
}

const pos = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined)

/**
 * asOf の日に有効だった単価。from より前なら prev（無ければ分からない＝undefined）。
 * 給与計算の「月途中は暦日按分」とは違い、ここは1日時点の単価だけを見る。
 */
export function valueOn(current: unknown, prev: unknown, from: string | undefined, asOf: string): number | undefined {
  if (from && asOf < from) return pos(prev)
  return pos(current)
}

/**
 * 人員マスタの1人を、asOf の日の「1日あたりの基本単価」にする。
 * 在籍していない・単価が分からない人は null。職種での除外はここではしない（記録には全員残す）。
 */
export function personOnDate(w: RawWageWorker, asOf: string): WageRatePerson | null {
  // 入社前・退職後（退職日の当日は在籍）・古い retired: true は数えない（lib/workers.ts の共通の判定）
  if (typeof w.id !== 'number' || !isEmployedOn(w as { hireDate?: string; retired?: string }, asOf)) return null
  const group: WageGroup = !w.visa || w.visa === 'none' ? 'jp' : 'foreign'
  const org: WageOrg = String(w.org || '').toLowerCase() === 'hfu' ? 'hfu' : 'hibi'
  const job = w.job || ''
  const salary = valueOn(w.salary, w.prevSalary, w.salaryFrom, asOf)
  const base = { id: w.id, group, org, job }
  if (group === 'foreign') {
    // 固定月給の人は月給が正（lib/compute-vn-salary.ts と同じ。時給は参考で持っているだけのことがある）
    if (salary) return { ...base, daily: Math.round(salary / FOREIGN_MONTHLY_DAYS), basis: 'monthly' }
    const hourly = valueOn(w.hourlyRate, w.prevHourlyRate, w.hourlyRateFrom, asOf)
    if (hourly) return { ...base, daily: Math.round(hourly * FOREIGN_HOURS_PER_DAY), basis: 'hourly' }
    const rate = valueOn(w.rate, w.prevRate, w.rateFrom, asOf)
    return rate ? { ...base, daily: Math.round(rate), basis: 'daily' } : null
  }
  const rate = valueOn(w.rate, w.prevRate, w.rateFrom, asOf)
  // 日本人は日額が正。日額が無く月給だけの人（新卒の月給）は年収の物差しで日給にそろえる
  if (rate) return { ...base, daily: Math.round(rate), basis: 'daily' }
  if (salary) return { ...base, daily: Math.round((salary * 12) / JP_DAYS_PER_YEAR), basis: 'monthly' }
  return null
}

/** 人員マスタ全員から、asOf の日の記録の中身を作る */
export function buildPeople(workers: RawWageWorker[], asOf: string): WageRatePerson[] {
  return workers
    .map(w => personOnDate(w, asOf))
    .filter((p): p is WageRatePerson => p !== null)
    .sort((a, b) => a.id - b.id)
}

/** 平均に入れる人か（職種・会社・月給の人） */
export function inScope(p: WageRatePerson, f: AvgFilter, group: 'all' | WageGroup): boolean {
  if (AVG_WAGE_EXCLUDED_JOBS.includes(p.job)) return false
  if (group !== 'all' && p.group !== group) return false
  if (f.org !== 'all' && p.org !== f.org) return false
  if (!f.includeMonthly && p.basis === 'monthly') return false
  return true
}

export function statOf(people: WageRatePerson[]): AvgStat {
  if (people.length === 0) return { n: 0, avg: null, min: null, max: null }
  const ds = people.map(p => p.daily)
  return {
    n: ds.length,
    avg: ds.reduce((s, v) => s + v, 0) / ds.length,
    min: Math.min(...ds),
    max: Math.max(...ds),
  }
}

export interface Decomposition {
  avgFrom: number | null
  avgTo: number | null
  nFrom: number
  nTo: number
  stayers: number
  leavers: number
  joiners: number
  /** 辞めた人を抜いたことによる平均の動き */
  leaverEffect: number
  /** 続けている人の昇給による平均の動き */
  raiseEffect: number
  /** 新しく入った人を足したことによる平均の動き */
  joinerEffect: number
  /** 続けている人1人あたりの昇給（日給） */
  raisePerStayer: number | null
  leaverAvg: number | null
  joinerAvg: number | null
}

const avgOf = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null)

/**
 * 2つの時点の平均の差を「辞めた人・続けている人の昇給・入った人」に分ける。
 * 続けている人＝両方の時点で対象に入っている人（会社や職種が変わって対象を出入りした人は、辞めた・入ったに数える）。
 */
export function decomposeAverage(from: WageRatePerson[], to: WageRatePerson[]): Decomposition {
  const toById = new Map(to.map(p => [p.id, p]))
  const fromIds = new Set(from.map(p => p.id))
  const stayFrom: number[] = [], stayTo: number[] = [], left: number[] = []
  for (const p of from) {
    const q = toById.get(p.id)
    if (q) { stayFrom.push(p.daily); stayTo.push(q.daily) } else left.push(p.daily)
  }
  const joined = to.filter(p => !fromIds.has(p.id)).map(p => p.daily)
  const avgFrom = avgOf(from.map(p => p.daily))
  const avgTo = avgOf(to.map(p => p.daily))
  const a1 = avgOf(stayFrom)   // 辞めた人を抜いたあと
  const a2 = avgOf(stayTo)     // 続けている人が昇給したあと
  let leaverEffect = 0, raiseEffect = 0, joinerEffect = 0
  if (avgFrom !== null && avgTo !== null) {
    if (a1 !== null && a2 !== null) {
      leaverEffect = a1 - avgFrom
      raiseEffect = a2 - a1
      joinerEffect = avgTo - a2
    } else {
      // 続けている人がいない（全員入れ替わり）: 差は全部「入った人」に寄せる
      leaverEffect = 0
      joinerEffect = avgTo - avgFrom
    }
  }
  return {
    avgFrom, avgTo,
    nFrom: from.length, nTo: to.length,
    stayers: stayFrom.length, leavers: left.length, joiners: joined.length,
    leaverEffect, raiseEffect, joinerEffect,
    raisePerStayer: stayFrom.length ? (stayTo.reduce((s, v) => s + v, 0) - stayFrom.reduce((s, v) => s + v, 0)) / stayFrom.length : null,
    leaverAvg: avgOf(left),
    joinerAvg: avgOf(joined),
  }
}

export interface HireNeed {
  /** 昇給を入れたあとの平均 */
  avgAfterRaise: number
  /** 必要な採用人数。null = その入社日給では何人採っても目標まで下がらない */
  needed: number | null
  /** needed 人を採ったあとの平均 */
  avgAfterHire: number | null
}

/**
 * 平均を目標に保つのに必要な採用人数。
 * (今の人数 × 昇給後の平均 + 採用 × 入社日給) ÷ (今の人数 + 採用) ≦ 目標 を満たす最小の採用人数。
 * 辞める人は入れない（辞める見込みがあるなら、その分だけ必要な人数は変わる）。
 */
export function requiredHires(args: { n: number; avgNow: number; raisePerPerson: number; target: number; entryDaily: number }): HireNeed {
  const { n, avgNow, raisePerPerson, target, entryDaily } = args
  const A = avgNow + raisePerPerson
  if (A <= target) return { avgAfterRaise: A, needed: 0, avgAfterHire: A }
  if (entryDaily >= target || n <= 0) return { avgAfterRaise: A, needed: null, avgAfterHire: null }
  // 浮動小数の誤差で1人多くならないよう、少しだけ引いてから切り上げる
  const needed = Math.max(0, Math.ceil((n * (A - target)) / (target - entryDaily) - 1e-9))
  return { avgAfterRaise: A, needed, avgAfterHire: (n * A + needed * entryDaily) / (n + needed) }
}

export interface AvgWagePoint {
  ym: string
  source: WageRateSnapshot['source']
  all: AvgStat
  jp: AvgStat
  foreign: AvgStat
  /** 対象の人のうち外国人の割合（0〜1） */
  foreignShare: number | null
}

export interface AvgWageComparison {
  from: string
  to: string
  all: Decomposition
  jp: Decomposition
  foreign: Decomposition
}

/** 画面へ渡す形（平均・人数・内訳だけ。1人ずつの単価は入れない） */
export interface AvgWageView {
  filter: AvgFilter
  points: AvgWagePoint[]
  /** 1年前の点がある月ごとの比較（新しい順）。1年前が無いうちは「最初の点 → 最新の点」を1つ */
  comparisons: AvgWageComparison[]
}

export function buildAvgWageView(snaps: WageRateSnapshot[], filter: AvgFilter): AvgWageView {
  const sorted = [...snaps].sort((a, b) => a.ym.localeCompare(b.ym))
  const byYm = new Map(sorted.map(s => [s.ym, s]))
  const pick = (s: WageRateSnapshot, g: 'all' | WageGroup) => s.people.filter(p => inScope(p, filter, g))
  const points: AvgWagePoint[] = sorted.map(s => {
    const all = pick(s, 'all')
    return {
      ym: s.ym,
      source: s.source,
      all: statOf(all),
      jp: statOf(pick(s, 'jp')),
      foreign: statOf(pick(s, 'foreign')),
      foreignShare: all.length ? all.filter(p => p.group === 'foreign').length / all.length : null,
    }
  })
  const compare = (a: WageRateSnapshot, b: WageRateSnapshot): AvgWageComparison => ({
    from: a.ym, to: b.ym,
    all: decomposeAverage(pick(a, 'all'), pick(b, 'all')),
    jp: decomposeAverage(pick(a, 'jp'), pick(b, 'jp')),
    foreign: decomposeAverage(pick(a, 'foreign'), pick(b, 'foreign')),
  })
  const comparisons: AvgWageComparison[] = []
  for (const s of [...sorted].reverse()) {
    const prev = byYm.get(shiftYm(s.ym, -12))
    if (prev) comparisons.push(compare(prev, s))
  }
  if (comparisons.length === 0 && sorted.length >= 2) comparisons.push(compare(sorted[0], sorted[sorted.length - 1]))
  return { filter, points, comparisons }
}
