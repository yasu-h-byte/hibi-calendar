/**
 * 夜間・定時の自動処理（Vercel Cron）の実行結果（2026-11-10 全体点検）。
 *
 * 旧: 失敗を外へ知らせていたのは日次バックアップ（lastBackup）と経費チェックだけ。
 *   有給の時効処理・領収書の読み取り・通勤時間の測定は、失敗しても応答に書くだけで誰も気づけなかった。
 * 新: 自動処理の入口を withCronRecord（lib/cron-status.server.ts）で包み、結果を demmen/system.cronRuns.{name} に残す。
 *   失敗が残っていれば代表の通知ベルに出す。次に成功すれば自動で消える。
 *
 * ここは純粋な決まりだけ（画面・テストからも読める）。書き込みは lib/cron-status.server.ts。
 */

/** 記録する自動処理。足すときはここに名前と呼び名を足す（呼び名が無いものは withCronRecord が受け付けない） */
export const CRON_LABEL = {
  'leave-expiry': '有給の時効処理（毎月1日）',
  'mf-receipts': '領収書の読み取り（毎朝）',
  'commute-measure': '通勤時間の測定',
  'wage-average': '平均日給の記録（毎月1日）',
} as const
export type CronName = keyof typeof CRON_LABEL

export interface CronRunInfo {
  /** 実行した時刻（ISO） */
  at: string
  ok: boolean
  /** 失敗の理由（内部の文は 200 字まで。成功なら無し） */
  error?: string
}

/** 応答から成功・失敗を決める。500 番台だけを失敗にする（「設定が無いので何もしない」「今日は対象外」は成功） */
export function cronRunFromStatus(status: number, nowIso: string, detail?: string): CronRunInfo {
  if (status >= 500) return { at: nowIso, ok: false, error: (detail || `応答 ${status}`).slice(0, 200) }
  return { at: nowIso, ok: true }
}

/** 通知ベルに出す文（失敗が残っているものだけ）。runs は demmen/system.cronRuns */
export function cronProblems(runs: Record<string, CronRunInfo | undefined> | null | undefined): string[] {
  if (!runs) return []
  const out: string[] = []
  for (const name of Object.keys(CRON_LABEL) as CronName[]) {
    const r = runs[name]
    if (!r || r.ok !== false) continue
    const day = typeof r.at === 'string' ? r.at.slice(0, 10) : ''
    out.push(`${CRON_LABEL[name]}が失敗しています${day ? `（${day}）` : ''}`)
  }
  return out
}
