import 'server-only'
/**
 * 自動処理（Vercel Cron）の実行結果を残す（2026-11-10 全体点検）。決まりは lib/cron-status.ts。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, setDoc } from '@/lib/fsdb'
import { cronRunFromStatus, type CronName, type CronRunInfo } from '@/lib/cron-status'

/** demmen/system.cronRuns.{name} に1件だけ残す（上書き）。記録の失敗で本体の処理は止めない */
export async function recordCronRun(name: CronName, info: CronRunInfo): Promise<void> {
  try {
    // 子の値は必ず中身のあるマップ（空マップを渡さない・lint:firestore）
    await setDoc(doc(db, 'demmen', 'system'), { cronRuns: { [name]: info } }, { merge: true })
  } catch (e) {
    console.error(`[cron] ${name} の実行結果を記録できませんでした:`, e)
  }
}

/**
 * 自動処理の本体を包む。応答が 500 番台か、例外で落ちたら「失敗」として残す（それ以外は「成功」で上書き）。
 * 入口の鍵（requireCron）を通したあとに呼ぶこと。
 */
export async function withCronRecord(name: CronName, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const nowIso = new Date().toISOString()
  try {
    const res = await run()
    let detail: string | undefined
    if (res.status >= 500) {
      try {
        const j = await res.clone().json() as { error?: unknown; message?: unknown }
        detail = [j?.error, j?.message].filter(x => typeof x === 'string').join(' ') || undefined
      } catch { /* JSON でない応答は番号だけ残す */ }
    }
    await recordCronRun(name, cronRunFromStatus(res.status, nowIso, detail))
    return res
  } catch (e) {
    console.error(`[cron] ${name} が落ちました:`, e)
    await recordCronRun(name, { at: nowIso, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
    return NextResponse.json({ error: `${name} failed` }, { status: 500 })
  }
}
