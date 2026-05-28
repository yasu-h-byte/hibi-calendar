import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { Worker } from '@/types'

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
 * @param ym       表示対象月 YYYYMM 形式
 */
export function isStillActiveForMonth(retired: string | undefined | null, ym: string): boolean {
  if (!retired) return true
  if (!/^\d{6}$/.test(ym)) return true  // ym 不正は安全側で表示
  const monthFirstDay = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`
  return retired >= monthFirstDay
}
