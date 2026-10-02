/**
 * 賃金を見られない評価者（職長・事務）に返す評価の項目（許可リスト・2026-10-02 総合点検）。
 * ここに無い項目（raiseAmount・raiseBaseAmount・finalScores・totalScore・manualScore・rank・evaluatorWeights・approvedBy など）は返さない。
 * 旧形式（評価者1人・scores 直下）の evaluatorId / scores / comment も評価入力の画面が読むので入れる。
 */
export const EVALUATOR_VIEW_KEYS: readonly string[] = [
  'id', 'workerId', 'workerName', 'evaluationDate', 'status', 'evaluatorIds', 'reviews', 'metrics', 'yearsFromHire',
  'createdAt', 'updatedAt',
  'evaluatorId', 'evaluatorName', 'scores', 'comment', 'submittedAt', 'date',
]
