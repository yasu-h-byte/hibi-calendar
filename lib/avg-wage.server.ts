import 'server-only'
/**
 * 平均日給の記録の読み書き（サーバー専用・個人の単価を含む）。計算と決まりは lib/avg-wage.ts。
 *
 * - 記録: Firestore `wageRateSnapshots/{YYYYMM}`（毎月1日時点の全員の日給。日次バックアップの対象）
 * - 毎月1日の自動処理（/api/wage-average/cron）が、その月の記録を作る。あわせて、まだ記録の無い月を
 *   AVG_WAGE_RESTORE_FROM_YM までさかのぼって人員マスタ（prev* の項目）から組み立てて残す（source: 'restored'）。
 *   人員マスタは1つ前の単価しか持たないので、次の改定で消える前に残しておく
 * - 画面へは平均と人数だけを渡す（/api/wage-average。pay.view の3人だけ）
 */
import { db } from '@/lib/firebase'
import { doc, setDoc, getDocs, collection } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute.server'
import { currentYmJst } from '@/lib/date-utils'
import {
  AVG_WAGE_RESTORE_FROM_YM, buildPeople, ymRange, ymToAsOf,
  type RawWageWorker, type WageRateSnapshot,
} from '@/lib/avg-wage'

export const AVG_WAGE_COLLECTION = 'wageRateSnapshots'

function rawWorkers(main: unknown): RawWageWorker[] {
  const ws = (main as { workers?: unknown[] })?.workers
  return Array.isArray(ws) ? (ws as RawWageWorker[]) : []
}

/** 人員マスタから ym の1日時点の記録を組み立てる（保存はしない） */
export function snapshotFromMaster(main: unknown, ym: string, source: WageRateSnapshot['source']): WageRateSnapshot {
  const asOf = ymToAsOf(ym)
  return { ym, asOf, source, takenAt: new Date().toISOString(), people: buildPeople(rawWorkers(main), asOf) }
}

/** 保存してある記録を全部読む（1か月1件・小さいので全件でよい） */
export async function loadStoredSnapshots(): Promise<Map<string, WageRateSnapshot>> {
  const snap = await getDocs(collection(db, AVG_WAGE_COLLECTION))
  const out = new Map<string, WageRateSnapshot>()
  snap.forEach(d => {
    const v = d.data() as WageRateSnapshot
    if (v && /^\d{6}$/.test(v.ym || '') && Array.isArray(v.people)) out.set(v.ym, v)
  })
  return out
}

/**
 * 画面用: 保存してある記録に、まだ記録の無い月（AVG_WAGE_RESTORE_FROM_YM 〜 今月）を人員マスタから組み立てて足す。
 * 足した分は保存しない（保存は毎月1日の自動処理だけが行う）。
 */
export async function loadSnapshotsForView(): Promise<WageRateSnapshot[]> {
  const [stored, main] = await Promise.all([loadStoredSnapshots(), getMainData()])
  const now = currentYmJst()
  for (const ym of ymRange(AVG_WAGE_RESTORE_FROM_YM, now)) {
    if (!stored.has(ym)) stored.set(ym, snapshotFromMaster(main, ym, ym === now ? 'cron' : 'restored'))
  }
  return [...stored.values()].filter(s => s.ym <= now).sort((a, b) => a.ym.localeCompare(b.ym))
}

/**
 * 毎月1日の自動処理: 今月の記録を作り、記録の無い過去の月も人員マスタから組み立てて残す。
 * 既にある月は書き換えない（その月の1日に残したものが正）。
 */
export async function recordMonthlySnapshots(): Promise<{ written: string[]; skipped: number }> {
  const [stored, main] = await Promise.all([loadStoredSnapshots(), getMainData({ fresh: true })])
  const now = currentYmJst()
  const written: string[] = []
  for (const ym of ymRange(AVG_WAGE_RESTORE_FROM_YM, now)) {
    if (stored.has(ym)) continue
    const s = snapshotFromMaster(main, ym, ym === now ? 'cron' : 'restored')
    if (s.people.length === 0) continue  // 中身の無い記録は残さない
    await setDoc(doc(db, AVG_WAGE_COLLECTION, ym), s)
    written.push(ym)
  }
  return { written, skipped: stored.size }
}
