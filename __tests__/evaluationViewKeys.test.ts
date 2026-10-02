/**
 * 評価 API（app/api/evaluation）が賃金を見られない評価者に返す項目は許可リスト（2026-10-02 総合点検）。
 * 旧: raise* / final* / rank を正規表現で「消す」方式で、承認時に書く項目を足すたびに消し漏れの余地があった。
 */
import { describe, test, expect, vi } from 'vitest'

const caller = { actor: 30 as number | 'super-admin', canSeeWage: false }
const evaluationDoc = {
  workerId: 104, workerName: 'フン', evaluationDate: '2026-05-07', status: 'approved',
  evaluatorIds: [30, 31, 1, 0],
  reviews: [
    { evaluatorId: 30, evaluatorName: '白戸', scores: { a: 'A' }, comment: '自分の', submittedAt: '2026-05-01' },
    { evaluatorId: 31, evaluatorName: '大川', scores: { a: 'B' }, comment: '他人の', submittedAt: '2026-05-02' },
  ],
  metrics: { attendanceRate: 98, overtimeAvg: 10, plUsage: 3, attendanceBonus: 2 },
  yearsFromHire: 2, createdAt: 'x', updatedAt: 'y',
  // 承認で書く項目（賃金）。評価者には返さない
  finalScores: { a: 'A' }, finalComment: 'c', manualScore: 80, totalScore: 82, rank: 'A', raiseAmount: 120,
  raiseFlooredToLegalMin: false, raiseBaseAmount: 120, raiseLegalMinRate: 1300, approvedBy: 1, approvedAt: 'z',
  evaluatorWeights: { 30: { weight: 1 } },
  // 将来足されるかもしれない項目（名前を知らなくても返さない）
  nextHourlyRate: 1700, bonusYen: 50000,
}

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}), getDoc: async () => ({ exists: () => false }), setDoc: async () => {}, updateDoc: async () => {},
  collection: () => ({}), runTransaction: async () => {},
  getDocs: async () => ({ docs: [{ id: '104_2026-05-07', data: () => structuredClone(evaluationDoc) }] }),
}))
vi.mock('@/lib/compute', () => ({
  getMainData: async () => ({ workers: [
    { id: 104, name: 'フン', visa: 'tokutei1', job: 'tobi', hireDate: '2024-05-07' },
    { id: 30, name: '白戸', visa: 'none', job: 'shokucho' },
    { id: 1, name: '日比政仁', visa: 'none', job: 'yakuin' },
  ], sites: [], mforeman: {} }),
}))
vi.mock('@/lib/auth', () => ({
  checkApiAuth: async () => true,
  requireCap: async () => null,
  callerCan: async (_r: unknown, cap: string) => cap === 'wage.view' ? caller.canSeeWage : false,
  getApiAuthUser: async () => ({ authorized: true, actor: caller.actor }),
}))
vi.mock('@/lib/activity', () => ({ logActivity: async () => {} }))

const get = async () => {
  const { GET } = await import('@/app/api/evaluation/route')
  const res = await GET(new Request('http://x/api/evaluation') as never)
  return res.json() as Promise<{ evaluations: Record<string, unknown>[]; settings: { raiseTable: unknown[] } }>
}

describe('評価者に返す項目', () => {
  test('許可リストに賃金の項目が無い', async () => {
    const { EVALUATOR_VIEW_KEYS } = await import('@/app/api/evaluation/route')
    for (const k of EVALUATOR_VIEW_KEYS) {
      expect(/^raise|^final|Score$|^rank$|^evaluatorWeights$|approved/.test(k), k).toBe(false)
    }
    expect(EVALUATOR_VIEW_KEYS).toContain('reviews')
    expect(EVALUATOR_VIEW_KEYS).toContain('metrics')
  })
  test('職長（wage.view なし）: 自分のレビューだけ・賃金の項目は名前を知らなくても返らない', async () => {
    caller.actor = 30; caller.canSeeWage = false
    const { evaluations, settings } = await get()
    expect(evaluations).toHaveLength(1)
    const e = evaluations[0]
    expect(Object.keys(e).sort()).toEqual(
      ['createdAt', 'evaluationDate', 'evaluatorIds', 'id', 'metrics', 'reviews', 'status', 'updatedAt', 'workerId', 'workerName', 'yearsFromHire'],
    )
    expect((e.reviews as { evaluatorId: number }[]).map(r => r.evaluatorId)).toEqual([30])
    expect(settings).toEqual({ raiseTable: [] })
  })
  test('レビューを出していない職長には、承認済みの評価は返らない', async () => {
    caller.actor = 32; caller.canSeeWage = false
    expect((await get()).evaluations).toEqual([])
  })
  test('事業責任者（wage.view あり）には全部返る', async () => {
    caller.actor = 1; caller.canSeeWage = true
    const e = (await get()).evaluations[0]
    expect(e.raiseAmount).toBe(120)
    expect((e.reviews as unknown[]).length).toBe(2)
  })
})
