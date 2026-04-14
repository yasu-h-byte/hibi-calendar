import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { ABCGrade, EvaluationScores, EvaluationWeights, EvaluationRank, RaiseTableRow } from '@/types'

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

// ────────────────────────────────────────
//  ヘルパー
// ────────────────────────────────────────

/** ABC → 数値変換 */
function gradeToNum(g: ABCGrade): number {
  switch (g) {
    case 'A': return 3
    case 'B': return 2
    case 'C': return 1
  }
}

/** 出席率からボーナス算出 */
function calcAttendanceBonus(rate: number): number {
  if (rate >= 98) return 3
  if (rate >= 95) return 2
  if (rate >= 90) return 1
  return 0
}

/** 合計スコアからランク算出 */
function calcRank(totalScore: number): EvaluationRank {
  if (totalScore >= 30) return 'S'
  if (totalScore >= 25) return 'A'
  if (totalScore >= 20) return 'B'
  if (totalScore >= 15) return 'C'
  return 'D'
}

/** 重み付き手動スコア算出 */
function calcManualScore(scores: EvaluationScores, weights: EvaluationWeights): number {
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

/** 入社日からの年数算出 */
function calcYearsFromHire(hireDate: string): number {
  if (!hireDate) return 1
  const hire = new Date(hireDate)
  const now = new Date()
  const diffMs = now.getTime() - hire.getTime()
  const years = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000))
  return Math.max(1, years)
}

/** 昇給テーブルから昇給額を取得 */
function lookupRaiseAmount(
  yearsFromHire: number,
  rank: EvaluationRank,
  raiseTable: RaiseTableRow[],
): number {
  // ランクDは昇給なし
  if (rank === 'D') return 0

  // 年数に対応する行を探す（最大年数を超えたら最後の行を使用）
  const maxYear = Math.max(...raiseTable.map(r => r.year))
  const yearKey = Math.min(yearsFromHire, maxYear)
  const row = raiseTable.find(r => r.year === yearKey)
  if (!row) return 0

  return row[rank] ?? 0
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

    // 所定労働日数
    const prescribed = workDays[ym] || 0
    totalPrescribed += prescribed

    // 当該ワーカーの出面を集計
    for (const [key, entry] of Object.entries(att.d)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (pk.wid !== String(workerId)) continue
      if (pk.ym !== ym) continue

      if (entry.w > 0) totalWorkDays++
      if (entry.p) totalPlDays++
      if (entry.o) totalOT += entry.o
    }
  }

  const attendanceRate = totalPrescribed > 0
    ? Math.round(((totalWorkDays + totalPlDays) / totalPrescribed) * 10000) / 100
    : 0

  const overtimeAvg = ymList.length > 0
    ? Math.round((totalOT / ymList.length) * 100) / 100
    : 0

  return {
    attendanceRate,
    overtimeAvg,
    plUsage: totalPlDays,
  }
}

// ────────────────────────────────────────
//  GET: 評価一覧 + ワーカーリスト + 設定
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

    // 外国人ワーカーリスト（hireDate付き）
    const mainData = await getMainData()
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

    // 評価設定
    const settings = await getEvaluationSettings()

    return NextResponse.json({
      evaluations,
      workers: foreignWorkers,
      settings,
    })
  } catch (error) {
    console.error('Evaluation GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch evaluations' }, { status: 500 })
  }
}

// ────────────────────────────────────────
//  POST: 評価の保存・提出・承認・設定保存
// ────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    // ── 下書き保存 ──
    if (action === 'save') {
      const { workerId, evaluatorId, evaluatorName, scores, comment } = body as {
        workerId: number
        evaluatorId: number
        evaluatorName: string
        scores: EvaluationScores
        comment: string
      }

      if (!workerId || !evaluatorId || !scores) {
        return NextResponse.json({ error: '必須項目が不足しています' }, { status: 400 })
      }

      // ワーカー情報取得
      const mainData = await getMainData()
      const worker = mainData.workers.find(w => w.id === workerId)
      if (!worker) {
        return NextResponse.json({ error: 'ワーカーが見つかりません' }, { status: 404 })
      }

      // 出席指標を自動算出
      const metrics = await calcAttendanceMetrics(workerId, mainData.workDays)
      const attendanceBonus = calcAttendanceBonus(metrics.attendanceRate)

      // 評価設定取得
      const settings = await getEvaluationSettings()

      // 重み付きスコア算出
      const manualScore = calcManualScore(scores, settings.weights)
      const totalScore = manualScore + attendanceBonus
      const rank = calcRank(totalScore)

      // 入社年数・昇給額
      const yearsFromHire = calcYearsFromHire(worker.hireDate)
      const raiseAmount = lookupRaiseAmount(yearsFromHire, rank, settings.raiseTable)

      const evaluationDate = new Date().toISOString().split('T')[0]
      const evaluationId = `${workerId}_${evaluationDate}`
      const now = new Date().toISOString()

      const evaluationData = {
        workerId,
        workerName: worker.name,
        evaluationDate,
        evaluatorId,
        evaluatorName,
        status: 'draft' as const,
        scores,
        comment: comment || '',
        metrics: {
          attendanceRate: metrics.attendanceRate,
          overtimeAvg: metrics.overtimeAvg,
          plUsage: metrics.plUsage,
          attendanceBonus,
        },
        manualScore,
        totalScore,
        rank,
        yearsFromHire,
        raiseAmount,
        createdAt: now,
        updatedAt: now,
      }

      await setDoc(doc(db, 'evaluations', evaluationId), evaluationData)
      await logActivity(String(evaluatorId), 'evaluation.save', `${worker.name} の評価を下書き保存`)

      return NextResponse.json({
        success: true,
        evaluation: { id: evaluationId, ...evaluationData },
      })
    }

    // ── 提出（職長 → 事業責任者へ） ──
    if (action === 'submit') {
      const { evaluationId } = body as { evaluationId: string }

      if (!evaluationId) {
        return NextResponse.json({ error: 'evaluationId は必須です' }, { status: 400 })
      }

      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価が見つかりません' }, { status: 404 })
      }

      const current = evalSnap.data()
      if (current.status !== 'draft') {
        return NextResponse.json({ error: '下書き状態の評価のみ提出できます' }, { status: 400 })
      }

      await updateDoc(evalRef, {
        status: 'submitted',
        updatedAt: new Date().toISOString(),
      })
      await logActivity(
        String(current.evaluatorId),
        'evaluation.submit',
        `${current.workerName} の評価を提出`,
      )

      return NextResponse.json({ success: true })
    }

    // ── 承認（事業責任者） ──
    if (action === 'approve') {
      const { evaluationId, approvedBy } = body as {
        evaluationId: string
        approvedBy: number
      }

      if (!evaluationId || !approvedBy) {
        return NextResponse.json({ error: 'evaluationId と approvedBy は必須です' }, { status: 400 })
      }

      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価が見つかりません' }, { status: 404 })
      }

      const current = evalSnap.data()
      if (current.status !== 'submitted') {
        return NextResponse.json({ error: '提出済みの評価のみ承認できます' }, { status: 400 })
      }

      const now = new Date().toISOString()
      await updateDoc(evalRef, {
        status: 'approved',
        approvedBy,
        approvedAt: now,
        updatedAt: now,
      })
      await logActivity(
        String(approvedBy),
        'evaluation.approve',
        `${current.workerName} の評価を承認`,
      )

      return NextResponse.json({ success: true })
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

      // バリデーション
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
