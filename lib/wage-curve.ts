/**
 * ベトナム人スタッフの賃金カーブ（逓減定額モデル）
 *
 * 2026-08-12 代表決定。従来の「年7%複利」から「昇給額 = 160円 − 8円 × 在籍年数」へ変更した。
 *
 * ## なぜ複利をやめたか
 * 7%複利は基本給が上がるほど昇給額が膨らむため、若手の伸びが薄い。為替の影響もあり
 * 在籍3年未満で帰国を希望する実習生が出始めたため、前厚（若手に厚い）カーブに変えた。
 *
 * ## このファイルの位置づけ
 * 昇給額の定義はここ 1 箇所に置く（単一の真理）。`/wage-analysis` のモデル表も、
 * `/evaluation` の評価テーブル（A評価）もここから導出している（2026-09-14 一本化・lib/evaluation-config.ts RAISE_TABLE）。
 * 値を変えるときはここだけを変える。
 *
 * ⚠️ クライアントにも配られるファイル。個人の時給・事情は書かない（予定表は lib/wage-plan.server.ts）。
 *
 * ※ 日本人社員の号俸制（docs/wage-system.md・lib/jp-wage.ts）は別体系。本ファイルの対象外。
 */

/* ────────────────────────────────────────────────
   カーブの定義
   ──────────────────────────────────────────────── */

/** 在籍0年→1年の昇給額（円） */
export const CURVE_BASE_RAISE = 160

/** 在籍年数が1年増えるごとに昇給額から差し引く額（円） */
export const CURVE_DECAY = 8

/**
 * 昇給額の下限（円）。11年目以降はこの額で頭打ちになる。
 *
 * ⚠️ ここを下げすぎると最低賃金の上昇（年4.5%前後）に負け、実質昇給がマイナスになる。
 *    かつて検討した「10年目以降2%」は在籍13年で法令下限（最賃×1.1）を割るため不採用とした。
 *    160/−8/下限80 でも在籍21年で割る計算。20年在籍者が出る前に
 *    「最賃連動フロア」か「到達点キャップ」の議論が必要。
 */
export const CURVE_MIN_RAISE = 80

/**
 * n年目 → (n+1)年目 の昇給額。
 *
 * @param yearIndex 昇給前の在籍年数（0 なら入社1年後の昇給）
 */
export function curveRaiseAt(yearIndex: number): number {
  return Math.max(CURVE_MIN_RAISE, CURVE_BASE_RAISE - CURVE_DECAY * yearIndex)
}

/**
 * カーブ上の時給。
 *
 * 昇給は年1回なので整数年で階段状に上がるが、在籍途中の人と比較するため
 * 端数年は次の昇給額で直線補間する。
 *
 * @param start 起点時給（= 入社時の時給）
 * @param years 在籍年数（小数可）
 */
export function curveWage(start: number, years: number): number {
  if (years <= 0) return start
  const full = Math.floor(years)
  let v = start
  for (let i = 0; i < full; i++) v += curveRaiseAt(i)
  return v + (years - full) * curveRaiseAt(full)
}

/**
 * カーブの起点時給。**東京都最低賃金を10円単位に切り上げた額**とする。
 *
 * 個人の契約時給ではなく最賃に紐づけるのは、起点を毎年の最賃改定に自動追従させるため。
 * 特定の入社者の時給を起点にすると、その人の条件次第でカーブ全体が動いてしまう。
 *
 * ⚠️ 実際の新規入社時給がこの額より高い場合がある（2026-08 時点で実勢 ¥1,270 / 起点 ¥1,230）。
 *    その差は「カーブより上でスタートしている」という意味になるので、
 *    `/wage-analysis` では実勢との差を併記して読み違えを防ぐこと。
 */
export function curveStartFor(minWage: number): number {
  return Math.ceil(minWage / 10) * 10
}

/* ────────────────────────────────────────────────
   賃金改定の予定（型と計算だけ）
   ──────────────────────────────────────────────── */

// ⚠️ 予定そのもの（誰が・いくらに）は lib/wage-plan.server.ts（サーバー専用）に置く。
//    このファイルは /evaluation など代表以外も開く画面の JS にも入るため、個人の金額を書かないこと。
//    2026-10-02: ここに予定表を置いていた頃は、ログインなしで取れる /_next/static のチャンクに
//    全員の予定時給・事情の注記が載っていた（npm run check:bundle で再発を検出する）

export interface ScheduledWageChange {
  /** 識別子 */
  id: string
  /** 実施日 YYYY-MM-DD */
  effective: string
  label: string
  reason: string
  /** 一律の率で決めた改定ならその率。個別事由なら未設定 */
  rate?: number
  /** workerId → 改定後の時給（円） */
  targets: Record<number, number>
}

/**
 * 予定をすべて織り込んだ後の時給。
 *
 * 複数の予定が同じ人に当たる場合は最も高い額を採る。マスタが既に予定額に達していれば
 * そのまま返す（予定値へ引き下げてしまわないため）。
 *
 * @param changes 予定の一覧。**個人の金額を含むためサーバー専用**（lib/wage-plan.server.ts）。
 *                画面では /api/wage-analysis/plan（代表だけ）から受け取ったものを渡す
 */
export function revisedHourly(id: number, current: number, changes: ScheduledWageChange[]): number {
  let v = current
  for (const c of changes) {
    const planned = c.targets[id]
    if (planned !== undefined) v = Math.max(v, planned)
  }
  return v
}

/** その人に当たる予定のうち、まだマスタに反映されていないもの。 */
export function pendingChangesFor(id: number, current: number, changes: ScheduledWageChange[]): ScheduledWageChange[] {
  return changes.filter(c => (c.targets[id] ?? 0) > current)
}

/** 月額換算に使う所定労働時間（時／月）。分析表示の共通前提。 */
export const MONTHLY_HOURS = 140
