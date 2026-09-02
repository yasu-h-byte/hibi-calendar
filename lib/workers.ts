import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { Worker } from '@/types'
import { todayJstIso, addMonthsSafe } from './date-utils'

/**
 * 人員マスタの読み出し。
 *
 * ⚠️ **この map は許可リストになっている。** Firestore に保存されていても、ここに
 *    書き忘れたフィールドは呼び出し側に届かない。「保存したのに画面では未入力のまま」
 *    という形で表面化し、書き込み側を疑って時間を溶かす（2026-08-26 に birthDate で発生）。
 *    Worker 型にフィールドを足したら、必ずここにも足すこと。
 *    漏れは `__tests__/workersMapping.test.ts` が検出する。
 */
export async function getWorkers(): Promise<Worker[]> {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)

  if (!docSnap.exists()) {
    return []
  }

  return mapRawWorkers(docSnap.data().workers || [])
}

/**
 * demmen/main の workers 配列（生データ）を Worker 型へ写像する（2026-09-02 抽出）。
 *
 * main ドキュメントは約260KBあり、1リクエスト内で getWorkers / getStaffSites /
 * getSites がそれぞれ再読すると読みだけで数秒かかる。API側で main を1回だけ読み、
 * この関数で写像することで重複読みをなくす（スマホ出面が20秒かかった障害の対処）。
 * 許可リスト方式なので Worker 型にフィールドを足したら必ずここにも足すこと
 * （漏れは __tests__/workersMapping.test.ts が検出する）。
 */
export function mapRawWorkers(raw: unknown[]): Worker[] {
  const workers: Worker[] = (raw as Record<string, unknown>[]).map((w: Record<string, unknown>) => ({
    id: w.id as number,
    name: w.name as string,
    nameVi: (w.nameVi as string) || '',
    company: (w.org as string) === 'hfu' ? 'HFU' : '日比',
    visaType: (w.visa as string) || '',
    token: (w.token as string) || '',
    jobType: (w.job as string) || '',
    rate: (w.rate as number) || 0,
    hourlyRate: (w.hourlyRate as number) || undefined,
    otMul: (w.otMul as number) || 1.25,
    hireDate: (w.hireDate as string) || '',
    retired: (w.retired as string) || '',
    salary: (w.salary as number) || undefined,
    visaExpiry: (w.visaExpiry as string) || '',
    dispatchTo: (w.dispatchTo as string) || '',
    dispatchFrom: (w.dispatchFrom as string) || '',
    useOldRules: (w.useOldRules as boolean) || undefined,
    birthDate: (w.birthDate as string) || '',
    jpGrade: (w.jpGrade as string) || undefined,
    jpStep: (w.jpStep as number) || undefined,
    canDrive: typeof w.canDrive === 'boolean' ? (w.canDrive as boolean) : undefined,
    nonSmoker: typeof w.nonSmoker === 'boolean' ? (w.nonSmoker as boolean) : undefined,
    children: Array.isArray(w.children) ? (w.children as string[]) : undefined,
    breakShortenMin: (w.breakShortenMin as number) || undefined,
    breakShortenFrom: (w.breakShortenFrom as string) || undefined,
  }))

  return workers
}

export async function getWorkerByToken(token: string): Promise<Worker | null> {
  const workers = await getWorkers()
  return workers.find(w => w.token === token) || null
}

/**
 * 表示時に最新の workerName を解決するヘルパー（2026-05-13 追加）
 *
 * Why: 帰国情報・評価・申請などの永続レコードは作成時に workerName を
 *   キャッシュしているが、人員マスタで改名しても追従しないため、
 *   表示時にマスタからルックアップして最新名を保証する必要がある。
 *
 * - 通常: workers マスタから ID で引いた名前を返す
 * - フォールバック: マスタから見つからない場合（退職して削除等）は
 *   引数の cached を返す。それも無ければ `ID:{id}` を返す。
 *
 * 任意の name フィールドを持つ Worker 互換型を受け付ける汎用版。
 */
export function resolveWorkerName<T extends { id: number; name: string }>(
  workers: T[],
  workerId: number,
  cached?: string | null,
): string {
  const found = workers.find(w => w.id === workerId)
  if (found?.name) return found.name
  if (cached) return cached
  return `ID:${workerId}`
}

/**
 * 多数の workerId を一括ルックアップする場合の Map ヘルパー。
 * 大量レコードで find ループを毎回回すコストを避ける。
 */
export function buildWorkerNameMap<T extends { id: number; name: string }>(
  workers: T[],
): Map<number, string> {
  const m = new Map<number, string>()
  for (const w of workers) m.set(w.id, w.name)
  return m
}

/**
 * 「指定月にまだ在籍中」かを判定（2026-05-27 追加）
 *
 * - retired が空 / undefined → 常に在籍中 (true)
 * - retired が「表示月の月初」以降 → まだその月までは勤務する (true)
 *   例: ym=202606、retired=2026-06-30 → true（6月末日まで勤務）
 *   例: ym=202607、retired=2026-06-30 → false（既に退職済み）
 *
 * 用途:
 *   - 出面入力グリッド (api/attendance/grid)
 *   - 就業カレンダー署名対象 (api/calendar/*)
 *   - 退職予定バナー
 *
 * これにより `!w.retired` を使う既存箇所のバグ
 * （retired フィールドが入った瞬間に全画面から消える）を防ぐ。
 *
 * @param retired  YYYY-MM-DD 形式の退職日（空文字／undefined OK）
 * @param ym       表示対象月。"YYYYMM"（6桁）または "YYYY-MM"（7桁ダッシュ付き）の両方を受け付ける
 *                 2026-05-27: ダッシュ付き形式も受け付けるように修正
 *                 （以前は正規表現で6桁限定だったため YYYY-MM 渡しで安全側 true にフォール
 *                  バックし、退職者が表示画面に残るバグが発生していた）
 */
export function isStillActiveForMonth(retired: string | undefined | null, ym: string): boolean {
  if (!retired) return true
  if (!ym) return true  // ym 不在は安全側で表示
  // "YYYYMM" / "YYYY-MM" の両方に対応
  const normalized = ym.replace('-', '')
  if (!/^\d{6}$/.test(normalized)) return true  // 不正フォーマットは安全側で表示
  const monthFirstDay = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-01`
  return retired >= monthFirstDay
}

/**
 * 「その月までに入社済みか」を判定（2026-06 追加 / isStillActiveForMonth の入社版）
 *
 * - hireDate が空 → 入社日未設定（既存スタッフ扱い）→ true（対象）
 * - hireDate の年月 <= ym の年月 → 入社済み → true
 * - hireDate の年月 >  ym の年月 → 入社前 → false（対象外）
 *
 * 用途: 月次集計・原価・出面グリッド等で「入社前の月に表示しない」ためのガード。
 *   例: 濱上(hireDate 2026-06-01) は 202605 では false（5月に出さない）、202606 で true。
 */
export function isHiredByMonth(hireDate: string | undefined | null, ym: string): boolean {
  if (!hireDate) return true
  if (!ym) return true
  const normalized = ym.replace('-', '')
  if (!/^\d{6}$/.test(normalized)) return true
  const ymMonth = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}` // 'YYYY-MM'
  const hireMonth = hireDate.slice(0, 7)                                 // 'YYYY-MM'
  return hireMonth <= ymMonth
}

/**
 * 「今日時点で既に退職済み」かを判定（2026-06-XX 追加）
 *
 * - retired が空 → 退職予定なし → false（在籍中）
 * - retired < todayIso → 退職日が過去 → true（退職済み）
 * - retired >= todayIso → 退職予定だが今日時点では在籍 → false
 *
 * 用途:
 *   - ダッシュボードの「今日時点で在籍中のメンバー」判定
 *   - 自動有給付与通知の対象判定
 *   - アクセスログの「現役スタッフ」判定
 *
 * isStillActiveForMonth との違い:
 *   - isStillActiveForMonth(retired, ym): 月単位の集計対象判定
 *   - isAlreadyRetired(retired, todayIso): 今日時点で退職済みか判定
 *
 * @param retired   YYYY-MM-DD 形式の退職日
 * @param todayIso  YYYY-MM-DD 形式の今日の日付（省略時は new Date() を使用）
 */
export function isAlreadyRetired(
  retired: string | undefined | null,
  todayIso?: string,
): boolean {
  if (!retired) return false  // 退職予定なし
  const today = todayIso || todayJstIso()  // 既定は日本時間の今日（UTCだとJST朝に1日ズレる）
  return retired < today
}

/**
 * 道具代管理の対象者判定（2026-08-28 に日本人へ拡大）
 *
 * - 外国人（技能実習・特定技能）… 従来から対象
 * - 日本人の現場スタッフ（visa 無し/none で、役員・事務を除く）… 2026-08-28 追加
 * - 今日時点で退職済みは除外（退職「予定」日が未来なら在職中扱い）
 *
 * tool-budget API と スタッフスマホ画面の道具代カードの両方がこれを使う。
 * 判定を変えるときはここだけ直す。
 */
export function isToolBudgetEligible(w: {
  visa?: string | null
  job?: string | null
  retired?: string | null
  hireDate?: string | null
}, todayIso?: string): boolean {
  if (isAlreadyRetired(w.retired)) return false
  const visa = w.visa || 'none'
  if (visa.startsWith('jisshu') || visa.startsWith('tokutei')) return true
  if (visa === 'none') {
    // 役員・事務は対象外
    if (w.job === 'yakuin' || w.job === 'jimu') return false
    // 2026-08-31 代表決定: 日本人は**入社6ヶ月未満は対象外**。
    //   有給の初回付与（入社6ヶ月後）と発生タイミングを揃える。
    //   入社日が未登録の人は判定できないので対象に含める（従来どおり）。
    if (w.hireDate) {
      const today = todayIso || todayJstIso()
      if (today < addMonthsSafe(w.hireDate, TOOL_BUDGET_JP_MIN_MONTHS)) return false
    }
    return true
  }
  return false
}

/** 日本人の道具代が発生するまでの在籍月数（有給の初回付与と同じ6ヶ月） */
export const TOOL_BUDGET_JP_MIN_MONTHS = 6

/** 日本人の道具代が発生する日（入社6ヶ月後）。未登録なら null */
export function toolBudgetStartFor(hireDate?: string | null): string | null {
  return hireDate ? addMonthsSafe(hireDate, TOOL_BUDGET_JP_MIN_MONTHS) : null
}

/**
 * 区分別の既定予算から、そのスタッフの道具代既定額を返す（2026-08-28 追加）。
 *
 * 優先順位:
 *   外国人 … budgetByVisa[visaコード完全一致] → budgetByVisa['jisshu'/'tokutei'（区分まとめ）] → 既定額
 *   日本人 … budgetByJob[職種] → 既定額
 * 個別に setBudget した期間レコードがある場合はそちらが優先（呼び出し側で record?.budget ?? これ）。
 */
export function toolBudgetDefaultFor(
  w: { visa?: string | null; job?: string | null },
  cfg: {
    defaultBudget?: number
    budgetByVisa?: Record<string, number>
    budgetByJob?: Record<string, number>
  },
): number {
  const fallback = cfg.defaultBudget || 30000
  const visa = w.visa || 'none'
  if (visa !== 'none') {
    const group = visa.startsWith('jisshu') ? 'jisshu' : visa.startsWith('tokutei') ? 'tokutei' : ''
    return cfg.budgetByVisa?.[visa] ?? (group ? cfg.budgetByVisa?.[group] : undefined) ?? fallback
  }
  return cfg.budgetByJob?.[w.job || ''] ?? fallback
}

/**
 * カレンダー署名対象スタッフ判定の共通述語（2026-05-27 追加）
 *
 * 「外国人 × トークン保有 × 当該月在籍 × 当該月全期間帰国でない」の条件を
 * 一箇所に集約。以前は3 つの API ルート (status / public-sites / sign-self) で
 * 微妙に違う条件を書いていたためズレが発生しやすかった。
 *
 * ⚠️ **「トークンを持っている＝ベトナム人」は成り立たない**（2026-09-02 事故）。
 *   日本人スタッフにマイページ用トークンを発行した途端、`!!w.token` だけで
 *   判定していた通知・公開ページが日本人9名を「未署名」に数えた。署名は
 *   変形労働時間制（外国人のみ）の周知・同意なので、visa の判定が必須。
 *   新しい呼び出し箇所を書くときは必ずこの述語を通すこと。
 *
 * @param worker  Firestore raw worker（`visa`）でも Worker 型（`visaType`）でも可
 * @param ym      "YYYY-MM" or "YYYYMM"
 * @param fullMonthHomeLeaveWorkerIds  当該月全期間帰国中のスタッフ ID 集合
 */
export function isCalendarSignTarget(
  worker: { id: number; visa?: string; visaType?: string; token?: string; retired?: string },
  ym: string,
  fullMonthHomeLeaveWorkerIds: Set<number>,
): boolean {
  if (!worker.token) return false
  // raw worker は visa、Worker 型は visaType と名前が違うので両方を受ける
  const visa = worker.visa ?? worker.visaType
  if (!visa || visa === 'none') return false  // 日本人は対象外
  if (!isStillActiveForMonth(worker.retired, ym)) return false
  if (fullMonthHomeLeaveWorkerIds.has(worker.id)) return false
  return true
}
