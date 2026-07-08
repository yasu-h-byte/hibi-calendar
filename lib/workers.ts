import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { Worker } from '@/types'
import { todayJstIso } from './date-utils'

export async function getWorkers(): Promise<Worker[]> {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)

  if (!docSnap.exists()) {
    return []
  }

  const data = docSnap.data()
  const workers: Worker[] = (data.workers || []).map((w: Record<string, unknown>) => ({
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
 * カレンダー署名対象スタッフ判定の共通述語（2026-05-27 追加）
 *
 * 「外国人 × トークン保有 × 当該月在籍 × 当該月全期間帰国でない」の条件を
 * 一箇所に集約。以前は3 つの API ルート (status / public-sites / sign-self) で
 * 微妙に違う条件を書いていたためズレが発生しやすかった。
 *
 * @param worker  Firestore raw worker (visa, token, retired を持つ)
 * @param ym      "YYYY-MM" or "YYYYMM"
 * @param fullMonthHomeLeaveWorkerIds  当該月全期間帰国中のスタッフ ID 集合
 */
export function isCalendarSignTarget(
  worker: { id: number; visa?: string; token?: string; retired?: string },
  ym: string,
  fullMonthHomeLeaveWorkerIds: Set<number>,
): boolean {
  if (!worker.token) return false
  if (!worker.visa || worker.visa === 'none') return false  // 日本人は対象外
  if (!isStillActiveForMonth(worker.retired, ym)) return false
  if (fullMonthHomeLeaveWorkerIds.has(worker.id)) return false
  return true
}
