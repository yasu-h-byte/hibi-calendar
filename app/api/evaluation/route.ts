import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { EvaluationScores, EvaluationWeights, RaiseTableRow, EvaluationReview } from '@/types'

// ────────────────────────────────────────
//  デフォルト設定
// ────────────────────────────────────────

const DEFAULT_WEIGHTS: EvaluationWeights = { japanese: 1.0, attitude: 1.5, skill: 1.2 }

const DEFAULT_RAISE_TABLE: RaiseTableRow[] = [
  { year: 1, S: 150, A: 100, B: 60, C: 0 },
  { year: 2, S: 120, A: 80, B: 50, C: 0 },
  { year: 3, S: 100, A: 60, B: 40, C: 0 },
  { year: 4, S: 80, A: 50, B: 30, C: 0 },
  { year: 5, S: 60, A: 40, B: 20, C: 0 },
  { year: 6, S: 40, A: 30, B: 15, C: 0 },
]

/** 政仁さんのワーカーID */
const APPROVER_WORKER_ID = 1
/** 靖仁さん（admin）のワーカーID — super admin は workerIdが0 */
const ADMIN_WORKER_ID = 0

// ────────────────────────────────────────
//  スコア計算ヘルパー
// ────────────────────────────────────────

/** ABC → 数値変換 */
function gradeToNum(g: 'A' | 'B' | 'C'): number {
  switch (g) {
    case 'A': return 3
    case 'B': return 2
    case 'C': return 1
  }
}

/** 重み付き手動スコア算出 */
function calcWeightedScore(scores: EvaluationScores, weights: EvaluationWeights): number {
  const japaneseSum =
    gradeToNum(scores.japanese.understanding) +
    gradeToNum(scores.japanese.reporting) +
    gradeToNum(scores.japanese.safety)

  const attitudeSum =
    gradeToNum(scores.attitude.punctuality) +
    gradeToNum(scores.attitude.safetyAwareness) +
    gradeToNum(scores.attitude.teamwork)

  const skillSum =
    gradeToNum(scores.skill.level) +
    gradeToNum(scores.skill.speed) +
    gradeToNum(scores.skill.planning)

  return japaneseSum * weights.japanese + attitudeSum * weights.attitude + skillSum * weights.skill
}

/** 出席率からボーナス算出 */
function calcAttendanceBonus(rate: number): number {
  if (rate >= 98) return 3
  if (rate >= 95) return 2
  if (rate >= 90) return 1
  return 0
}

/** 合計スコアからランク算出 */
function calcRank(totalScore: number): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (totalScore >= 30) return 'S'
  if (totalScore >= 25) return 'A'
  if (totalScore >= 20) return 'B'
  if (totalScore >= 15) return 'C'
  return 'D'
}

/** 昇給テーブルから昇給額を取得 */
function getRaiseAmount(
  rank: 'S' | 'A' | 'B' | 'C' | 'D',
  yearsFromHire: number,
  raiseTable: RaiseTableRow[],
): number {
  if (rank === 'D') return 0
  const maxYear = Math.max(...raiseTable.map(r => r.year))
  const yearKey = Math.min(yearsFromHire, maxYear)
  const row = raiseTable.find(r => r.year === yearKey)
  if (!row) return 0
  return row[rank] ?? 0
}

/** 入社日からの年数算出 */
function calcYearsFromHire(hireDate: string): number {
  if (!hireDate) return 1
  const hire = new Date(hireDate)
  const now = new Date()
  const diffMs = now.getTime() - hire.getTime()
  const years = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000))
  return Math.max(1, years)
}

/** 過去12ヶ月のYMキーリスト生成 */
function getPast12MonthsYM(): string[] {
  const result: string[] = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    result.push(ym)
  }
  return result
}

/** 評価設定を取得（存在しなければデフォルト） */
async function getEvaluationSettings(): Promise<{
  weights: EvaluationWeights
  raiseTable: RaiseTableRow[]
}> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) {
    return { weights: DEFAULT_WEIGHTS, raiseTable: DEFAULT_RAISE_TABLE }
  }
  const data = mainDoc.data()
  const settings = data.evaluationSettings as {
    weights?: EvaluationWeights
    raiseTable?: RaiseTableRow[]
  } | undefined

  return {
    weights: settings?.weights ?? DEFAULT_WEIGHTS,
    raiseTable: settings?.raiseTable ?? DEFAULT_RAISE_TABLE,
  }
}

/** 出席指標を算出（過去12ヶ月） */
async function calcAttendanceMetrics(
  workerId: number,
  workDays: Record<string, number>,
): Promise<{
  attendanceRate: number
  overtimeAvg: number
  plUsage: number
  attendanceBonus: number
}> {
  const ymList = getPast12MonthsYM()
  const attResults = await Promise.all(ymList.map(ym => getAttData(ym)))

  let totalWorkDays = 0
  let totalPlDays = 0
  let totalOT = 0
  let totalPrescribed = 0

  for (let i = 0; i < ymList.length; i++) {
    const ym = ymList[i]
    const att = attResults[i]

    const prescribed = workDays[ym] || 0
    totalPrescribed += prescribed

    for (const [key, entry] of Object.entries(att.d)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (pk.wid !== String(workerId)) continue
      if (pk.ym !== ym) continue

      const e = entry as { w: number; p?: boolean; o?: number }
      if (e.w > 0) totalWorkDays++
      if (e.p) totalPlDays++
      if (e.o) totalOT += e.o
    }
  }

  const attendanceRate = totalPrescribed > 0
    ? Math.round(((totalWorkDays + totalPlDays) / totalPrescribed) * 10000) / 100
    : 0

  const overtimeAvg = ymList.length > 0
    ? Math.round((totalOT / ymList.length) * 100) / 100
    : 0

  const attendanceBonus = calcAttendanceBonus(attendanceRate)

  return { attendanceRate, overtimeAvg, plUsage: totalPlDays, attendanceBonus }
}

// ────────────────────────────────────────
//  GET: 評価一覧 + ワーカーリスト + 設定 + 評価者情報
// ────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const workerId = searchParams.get('workerId')

    // 評価データ取得
    const evalSnap = await getDocs(collection(db, 'evaluations'))
    let evaluations = evalSnap.docs.map(d => ({ id: d.id, ...d.data() }))

    if (workerId) {
      evaluations = evaluations.filter(
        (e) => (e as { workerId?: number }).workerId === Number(workerId)
      )
    }

    // ワーカーデータ取得
    const mainData = await getMainData()

    // 外国人ワーカーリスト（評価対象）
    const foreignWorkers = mainData.workers
      .filter(w => w.visa !== 'none' && !w.retired)
      .map(w => ({
        id: w.id,
        name: w.name,
        org: w.org,
        visa: w.visa,
        job: w.job,
        hireDate: w.hireDate,
      }))

    // 評価者リスト（職長 + 政仁さん + 靖仁さん）
    const evaluators = mainData.workers
      .filter(w => !w.retired && (w.job === 'shokucho' || w.id === APPROVER_WORKER_ID))
      .map(w => ({
        id: w.id,
        name: w.name,
        job: w.job,
      }))
    // super admin（靖仁さん、workerIdが0）はワーカーリストにいないので明示的に追加
    if (!evaluators.find(e => e.id === ADMIN_WORKER_ID)) {
      evaluators.push({ id: ADMIN_WORKER_ID, name: '日比靖仁', job: 'admin' })
    }

    // 評価設定
    const settings = await getEvaluationSettings()

    return NextResponse.json({
      evaluations,
      workers: foreignWorkers,
      evaluators,
      settings,
    })
  } catch (error) {
    console.error('Evaluation GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch evaluations' }, { status: 500 })
  }
}

// ────────────────────────────────────────
//  POST: 評価セッション作成・レビュー提出・承認・設定保存
// ────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    // ── セッション作成 ──
    if (action === 'create') {
      const { workerId, workerName, evaluationDate, evaluatorIds: providedEvaluatorIds } = body as {
        workerId: number
        workerName: string
        evaluationDate: string
        evaluatorIds?: number[]
      }

      if (!workerId || !workerName || !evaluationDate) {
        return NextResponse.json({ error: 'workerId, workerName, evaluationDate は必須です' }, { status: 400 })
      }

      // ワーカー情報取得
      const mainData = await getMainData()
      const worker = mainData.workers.find(w => w.id === workerId)
      if (!worker) {
        return NextResponse.json({ error: 'ワーカーが見つかりません' }, { status: 404 })
      }

      // evaluatorIds: 指定がなければ全職長 + 政仁さん + 靖仁さん
      let evaluatorIds = providedEvaluatorIds
      if (!evaluatorIds || evaluatorIds.length === 0) {
        const shokuchoIds = mainData.workers
          .filter(w => !w.retired && w.job === 'shokucho')
          .map(w => w.id)
        evaluatorIds = Array.from(new Set([...shokuchoIds, APPROVER_WORKER_ID, ADMIN_WORKER_ID]))
      }

      // 出席指標を自動算出
      const metricsRaw = await calcAttendanceMetrics(workerId, mainData.workDays)
      const metrics = {
        attendanceRate: metricsRaw.attendanceRate,
        overtimeAvg: metricsRaw.overtimeAvg,
        plUsage: metricsRaw.plUsage,
        attendanceBonus: metricsRaw.attendanceBonus,
      }

      const yearsFromHire = calcYearsFromHire(worker.hireDate)
      const evaluationId = `${workerId}_${evaluationDate}`
      const now = new Date().toISOString()

      const evaluationData = {
        workerId,
        workerName,
        evaluationDate,
        status: 'collecting' as const,
        evaluatorIds,
        reviews: [] as EvaluationReview[],
        metrics,
        yearsFromHire,
        createdAt: now,
        updatedAt: now,
      }

      await setDoc(doc(db, 'evaluations', evaluationId), evaluationData)
      await logActivity('admin', 'evaluation.create', `${workerName} の評価セッションを作成`)

      return NextResponse.json({
        success: true,
        evaluation: { id: evaluationId, ...evaluationData },
      })
    }

    // ── 個別レビュー提出 ──
    if (action === 'submitReview') {
      const { evaluationId, evaluatorId, evaluatorName, scores, comment } = body as {
        evaluationId: string
        evaluatorId: number
        evaluatorName: string
        scores: EvaluationScores
        comment: string
      }

      if (!evaluationId || !evaluatorId || !evaluatorName || !scores) {
        return NextResponse.json({ error: 'evaluationId, evaluatorId, evaluatorName, scores は必須です' }, { status: 400 })
      }

      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価セッションが見つかりません' }, { status: 404 })
      }

      const current = evalSnap.data()
      if (current.status !== 'collecting') {
        return NextResponse.json({ error: '収集中の評価セッションのみレビューを提出できます' }, { status: 400 })
      }

      // evaluatorIds に含まれるか確認
      const evaluatorIds = current.evaluatorIds as number[]
      if (!evaluatorIds.includes(evaluatorId)) {
        return NextResponse.json({ error: 'この評価者は評価予定者リストに含まれていません' }, { status: 403 })
      }

      // reviews配列を更新（既存なら上書き、なければ追加）
      const reviews = (current.reviews || []) as EvaluationReview[]
      const existingIdx = reviews.findIndex(r => r.evaluatorId === evaluatorId)
      const newReview: EvaluationReview = {
        evaluatorId,
        evaluatorName,
        scores,
        comment: comment || '',
        submittedAt: new Date().toISOString(),
      }

      if (existingIdx >= 0) {
        reviews[existingIdx] = newReview
      } else {
        reviews.push(newReview)
      }

      // 全評価者が提出済みか判定
      const submittedIds = new Set(reviews.map(r => r.evaluatorId))
      const allSubmitted = evaluatorIds.every(id => submittedIds.has(id))
      const newStatus = allSubmitted ? 'reviewing' : 'collecting'

      await updateDoc(evalRef, {
        reviews,
        status: newStatus,
        updatedAt: new Date().toISOString(),
      })

      await logActivity(
        String(evaluatorId),
        'evaluation.submitReview',
        `${current.workerName} の個別評価を提出`,
      )

      return NextResponse.json({ success: true, status: newStatus })
    }

    // ── 承認（政仁さんが最終スコアを確定） ──
    if (action === 'approve') {
      const { evaluationId, approvedBy, finalScores, finalComment } = body as {
        evaluationId: string
        approvedBy: number
        finalScores: EvaluationScores
        finalComment?: string
      }

      if (!evaluationId || !approvedBy || !finalScores) {
        return NextResponse.json({ error: 'evaluationId, approvedBy, finalScores は必須です' }, { status: 400 })
      }

      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価セッションが見つかりません' }, { status: 404 })
      }

      const current = evalSnap.data()
      if (current.status !== 'reviewing') {
        return NextResponse.json({ error: 'レビュー中の評価セッションのみ承認できます' }, { status: 400 })
      }

      // 評価設定取得
      const settings = await getEvaluationSettings()

      // finalScores から重み付きスコア算出
      const manualScore = calcWeightedScore(finalScores, settings.weights)
      const attendanceBonus = (current.metrics as { attendanceBonus: number }).attendanceBonus
      const totalScore = manualScore + attendanceBonus
      const rank = calcRank(totalScore)

      // 昇給額
      const yearsFromHire = current.yearsFromHire as number
      const raiseAmount = getRaiseAmount(rank, yearsFromHire, settings.raiseTable)

      const now = new Date().toISOString()
      await updateDoc(evalRef, {
        status: 'approved',
        finalScores,
        finalComment: finalComment || '',
        manualScore,
        totalScore,
        rank,
        raiseAmount,
        approvedBy,
        approvedAt: now,
        updatedAt: now,
      })

      await logActivity(
        String(approvedBy),
        'evaluation.approve',
        `${current.workerName} の評価を承認（ランク: ${rank}）`,
      )

      return NextResponse.json({ success: true, rank, totalScore, raiseAmount })
    }

    // ── 設定保存（重み + 昇給テーブル） ──
    if (action === 'saveSettings') {
      const { weights, raiseTable } = body as {
        weights: EvaluationWeights
        raiseTable: RaiseTableRow[]
      }

      if (!weights || !raiseTable) {
        return NextResponse.json({ error: 'weights と raiseTable は必須です' }, { status: 400 })
      }

      if (weights.japanese <= 0 || weights.attitude <= 0 || weights.skill <= 0) {
        return NextResponse.json({ error: '重みは正の数である必要があります' }, { status: 400 })
      }
      if (raiseTable.length === 0) {
        return NextResponse.json({ error: '昇給テーブルが空です' }, { status: 400 })
      }

      const mainRef = doc(db, 'demmen', 'main')
      const mainSnap = await getDoc(mainRef)
      if (!mainSnap.exists()) {
        return NextResponse.json({ error: 'Main document not found' }, { status: 500 })
      }

      await updateDoc(mainRef, {
        evaluationSettings: { weights, raiseTable },
      })
      await logActivity('admin', 'evaluation.saveSettings', '評価設定を更新')

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Evaluation POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
