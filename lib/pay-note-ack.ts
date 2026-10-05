/**
 * 給与チェックの注意点を「確認した」と残す（2026-10-05 代表依頼）。
 *
 * 注意点（lib/payroll-validator.ts の warning）は画面を開くたびに計算し直して出すだけで、見て「このままでよい」と
 * 判断しても消せなかった（例: 月途中の時給改定の残業・約54円が、開くたびに出続ける）。確認して問題なしとしたものと、
 * まだ見ていないものの区別がつくようにする。
 *
 * 決まり:
 *   - 確認できるのは warning だけ。critical（法令割れなど）は直すまで消えない・締められない（確認では消さない）
 *   - 確認は「月 × 人 × 注意点の種類」ごとに1件。確認したときの文面（message）を一緒に残す
 *   - **確認したあとで文面（金額・日数）が変わったら、未確認に戻す**（出面を直して差額が増えた、など）
 *   - 帯の件数・メニューの赤い数字・締めの前の確認は、未確認のものだけを数える
 *   - 確認済みは消さずに灰色で残す（誰が・いつ・メモ）。取り消すと未確認に戻る
 *
 * ここは Firestore を読まない純粋な関数だけ（画面・API・締め・メニューの数字が同じ判定を使う）。
 */
import type { PayrollValidationIssue } from './payroll-validator'

export interface PayNoteAck {
  ym: string
  workerId: number
  /** 注意点の種類（PayrollValidationIssue.field。payNotes の code など） */
  code: string
  /** 確認したときの文面。今の文面と違えば未確認に戻す */
  message: string
  /** 確認した人のひとこと（任意） */
  note?: string
  by: string
  byName?: string
  at: string
}

/** 確認の記録の ID（月 × 人 × 種類） */
export const payNoteAckId = (ym: string, workerId: number, code: string) => `${ym}_${workerId}_${code}`

const keyOf = (workerId: number, code: string) => `${workerId}|${code}`

export interface AckedIssue extends PayrollValidationIssue { ack: PayNoteAck }

/**
 * 検算の結果を「未確認」と「確認済み」に分ける。
 * critical は常に未確認側。warning は、同じ人・同じ種類の確認があり、文面が確認したときと同じときだけ確認済み。
 */
export function splitIssuesByAck(
  issues: PayrollValidationIssue[], acks: PayNoteAck[],
): { open: PayrollValidationIssue[]; acked: AckedIssue[] } {
  const byKey = new Map(acks.map(a => [keyOf(a.workerId, a.code), a] as const))
  const open: PayrollValidationIssue[] = []
  const acked: AckedIssue[] = []
  for (const i of issues) {
    const a = i.severity === 'warning' ? byKey.get(keyOf(i.workerId, i.field)) : undefined
    if (a && a.message === i.message) acked.push({ ...i, ack: a })
    else open.push(i)
  }
  return { open, acked }
}

/** validatePayrolls と同じ形のまとめ（未確認だけを数える）＋確認済みの一覧 */
export function summarizeOpenIssues(issues: PayrollValidationIssue[], acks: PayNoteAck[]) {
  const { open, acked } = splitIssuesByAck(issues, acks)
  return {
    total: open.length,
    critical: open.filter(i => i.severity === 'critical').length,
    warning: open.filter(i => i.severity === 'warning').length,
    issues: open,
    affectedWorkerIds: [...new Set(open.map(i => i.workerId))],
    acked,
  }
}
