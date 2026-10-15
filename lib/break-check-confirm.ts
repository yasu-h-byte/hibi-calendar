/**
 * 承認の API が「休憩のチェックに打刻ミスの疑い」（409・code: break_check）を返したときの確認窓（2026-10-15）。
 * 画面から使う。承認してよければ true（呼び出し側は ackBreakCheck: true を付けて送り直す）。
 * 決まりは lib/break-check.ts。サーバー専用の lib/break-check.server.ts とは分けてある（確認窓は画面だけ）。
 */
import { confirmDialog } from './confirm-dialog'
import { breakIssuesMessage, BREAK_CHECK_CODE, type BreakIssue } from './break-check'

export function isBreakCheckResponse(j: unknown): j is { code: string; issues: BreakIssue[] } {
  return !!j && typeof j === 'object' && (j as { code?: unknown }).code === BREAK_CHECK_CODE
    && Array.isArray((j as { issues?: unknown }).issues)
}

export function confirmBreakCheck(issues: BreakIssue[], month?: number): Promise<boolean> {
  return confirmDialog({
    title: `休憩のチェックに打刻ミスの疑いがあります（${issues.length}件）`,
    description: `${breakIssuesMessage(issues, month)}\n\n直す場合は「やめる」を押して、時刻と休憩のチェックを直してから承認してください。`,
    confirmLabel: '確認したので承認する',
  })
}
