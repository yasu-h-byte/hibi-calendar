import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, updateDoc, runTransaction } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { calcEvaluatorWeights } from '@/lib/evaluator-weights'
import { calcAttendanceMetrics as calcAttendanceMetricsLib, calcAttendanceBonus } from '@/lib/attendance-rate'
import { EvaluationScores, EvaluationReview } from '@/types'
// ⚠️ 評価ロジックは lib/evaluation-config.ts に集約。
//   フロントとAPIで重複定義してドリフトする事故を防ぐため、必ず単一の真理ソースを使う。
import {
  calculateManualScore,
  calculateRank,
  getRaiseAmount,
  yearsFromHire as calcYearsFromHire,
  RAISE_TABLE as DEFAULT_RAISE_TABLE,
  type RaiseTableRow,
} from '@/lib/evaluation-config'

/** 政仁さんのワーカーID */
const APPROVER_WORKER_ID = 1
/** 靖仁さん（admin）のワーカーID — super admin は workerIdが0 */
const ADMIN_WORKER_ID = 0

/**
 * 評価設定を取得（管理者カスタマイズがあればそれを優先、なければ共通モジュールのデフォルト）。
 * weights は admin がカスタマイズできない仕様（calculateManualScore に組み込み）。
 * raiseTable のみ admin 設定での上書きを許容する。
 */
async function getEvaluationSettings(): Promise<{
  raiseTable: RaiseTableRow[]
}> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) {
    return { raiseTable: DEFAULT_RAISE_TABLE }
  }
  const data = mainDoc.data()
  const settings = data.evaluationSettings as { raiseTable?: RaiseTableRow[] } | undefined
  return {
    raiseTable: settings?.raiseTable ?? DEFAULT_RAISE_TABLE,
  }
}

/**
 * 出席指標を算出（過去12ヶ月）— lib/attendance-rate.ts に集約済み
 * 評価日基準で算出する仕様にしてある（前回バグの「now ベース」では評価日と乖離する）。
 *
 * 詳細内訳（実出勤・試験・欠勤・帰国・補償・除外日数等）も保存して
 * 詳細モーダルで内訳確認できるようにする。
 */
async function calcMetricsForEvaluation(opts: {
  workerId: number
  evaluationDate: string
}): Promise<{
  attendanceRate: number
  overtimeAvg: number
  plUsage: number
  attendanceBonus: number
  rawRate: number
  workedDays: number
  presentDays: number
  plDays: number
  examDays: number
  restDays: number
  homeLeaveDays: number
  siteOffDays: number
  compensationDays: number
  totalOvertime: number
  prescribedTotal: number
  applicablePrescribed: number
  excludedDays: {
    beforeHire: number
    afterRetire: number
    homeLeave: number
    longAbsence: number
  }
  computedAt: string
}> {
  const r = await calcAttendanceMetricsLib({
    workerId: opts.workerId,
    periodEnd: opts.evaluationDate,
    monthsBack: 12,
  })
  return {
    attendanceRate: r.attendanceRate,
    overtimeAvg: r.overtimeAvg,
    plUsage: r.plDays,
    attendanceBonus: calcAttendanceBonus(r.attendanceRate),
    rawRate: r.rawRate,
    workedDays: r.workedDays,
    presentDays: r.presentDays,
    plDays: r.plDays,
    examDays: r.examDays,
    restDays: r.restDays,
    homeLeaveDays: r.homeLeaveDays,
    siteOffDays: r.siteOffDays,
    compensationDays: r.compensationDays,
    totalOvertime: r.totalOvertime,
    prescribedTotal: r.prescribedTotal,
    applicablePrescribed: r.applicablePrescribed,
    excludedDays: r.excludedDays,
    computedAt: new Date().toISOString(),
  }
}

// ────────────────────────────────────────
//  GET: 評価一覧 + ワーカーリスト + 設定 + 評価者情報
// ────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let stage = 'init'
  try {
    const { searchParams } = new URL(request.url)
    const workerId = searchParams.get('workerId')

    // 評価データ取得
    stage = 'get-evaluations'
    const evalSnap = await getDocs(collection(db, 'evaluations'))
    let evaluations = evalSnap.docs.map(d => ({ id: d.id, ...d.data() }))

    if (workerId) {
      evaluations = evaluations.filter(
        (e) => (e as { workerId?: number }).workerId === Number(workerId)
      )
    }

    // ワーカーデータ取得
    stage = 'get-main-data'
    const mainData = await getMainData()

    // 外国人ワーカーリスト（評価対象）
    stage = 'build-foreign-workers'
    const foreignWorkers = (mainData.workers || [])
      .filter(w => w && w.visa !== 'none' && !w.retired)
      .map(w => ({
        id: w.id,
        name: w.name || '',
        org: w.org || '',
        visa: w.visa || '',
        job: w.job || '',
        hireDate: w.hireDate || '',
      }))

    // 評価者リスト（職長 + 政仁さん + 靖仁さん）
    stage = 'build-evaluators'
    const evaluators: { id: number; name: string; job: string }[] = (mainData.workers || [])
      .filter(w => w && !w.retired && (w.job === 'shokucho' || w.id === APPROVER_WORKER_ID))
      .map(w => ({
        id: w.id,
        name: w.name || '',
        job: w.job || '',
      }))
    // super admin（靖仁さん、workerIdが0）はワーカーリストにいないので明示的に追加
    if (!evaluators.find(e => e.id === ADMIN_WORKER_ID)) {
      evaluators.push({ id: ADMIN_WORKER_ID, name: '日比靖仁', job: 'admin' })
    }

    // 評価設定
    stage = 'get-settings'
    const settings = await getEvaluationSettings()

    stage = 'response'
    return NextResponse.json({
      evaluations,
      workers: foreignWorkers,
      evaluators,
      settings,
    })
  } catch (error) {
    console.error(`Evaluation GET error at stage [${stage}]:`, error)
    const errMsg = error instanceof Error ? error.message : String(error)
    const errStack = error instanceof Error ? error.stack : undefined
    return NextResponse.json({ error: 'Failed to fetch evaluations', stage, detail: errMsg, stack: errStack }, { status: 500 })
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

      // 出席指標を自動算出（評価日基準・過去12ヶ月）
      const metricsRaw = await calcMetricsForEvaluation({
        workerId,
        evaluationDate,
      })
      // 詳細内訳を含む全フィールドを保存
      const metrics = { ...metricsRaw }

      const yearsFromHire = calcYearsFromHire(worker.hireDate)
      const evaluationId = `${workerId}_${evaluationDate}`
      const now = new Date().toISOString()

      // 評価者ウェイト（共働日数ベース）を算出
      const evaluatorWeights = await calcEvaluatorWeights(
        workerId,
        evaluatorIds,
        evaluationDate,
        mainData,
      )

      const evaluationData = {
        workerId,
        workerName,
        evaluationDate,
        status: 'collecting' as const,
        evaluatorIds,
        reviews: [] as EvaluationReview[],
        metrics,
        evaluatorWeights,
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

      // 注意: evaluatorId は 0（靖仁さん, super-admin）が正規の値なので、
      //       `!evaluatorId` は使わず null/undefined/型を明示チェックする。
      if (!evaluationId || typeof evaluatorId !== 'number' || !evaluatorName || !scores) {
        return NextResponse.json({ error: 'evaluationId, evaluatorId, evaluatorName, scores は必須です' }, { status: 400 })
      }

      const evalRef = doc(db, 'evaluations', evaluationId)

      // ⚠️ 2026-05-08 修正: runTransaction で race condition を解消。
      //   2人以上の評価者が同時に submit しても、トランザクション内で再読み込みされる
      //   ため reviews 配列の片方が消失することがない。
      let workerName = ''
      let newStatus: 'collecting' | 'reviewing' = 'collecting'
      try {
        await runTransaction(db, async (tx) => {
          const evalSnap = await tx.get(evalRef)
          if (!evalSnap.exists()) {
            throw new Error('NOT_FOUND')
          }
          const current = evalSnap.data()
          workerName = (current.workerName as string) || ''
          if (current.status !== 'collecting') {
            throw new Error('NOT_COLLECTING')
          }
          // evaluatorIds に含まれるか確認
          const evaluatorIds = current.evaluatorIds as number[]
          if (!evaluatorIds.includes(evaluatorId)) {
            throw new Error('NOT_EVALUATOR')
          }
          // reviews配列を更新（既存なら上書き、なければ追加）
          const reviews = ((current.reviews || []) as EvaluationReview[]).slice()
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
          newStatus = allSubmitted ? 'reviewing' : 'collecting'

          tx.update(evalRef, {
            reviews,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          })
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === 'NOT_FOUND') {
          return NextResponse.json({ error: '評価セッションが見つかりません' }, { status: 404 })
        }
        if (msg === 'NOT_COLLECTING') {
          return NextResponse.json({ error: '収集中の評価セッションのみレビューを提出できます' }, { status: 400 })
        }
        if (msg === 'NOT_EVALUATOR') {
          return NextResponse.json({ error: 'この評価者は評価予定者リストに含まれていません' }, { status: 403 })
        }
        throw e
      }

      await logActivity(
        String(evaluatorId),
        'evaluation.submitReview',
        `${workerName} の個別評価を提出`,
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

      // 注意: approvedBy も 0（靖仁さん）が正規の値
      if (!evaluationId || typeof approvedBy !== 'number' || !finalScores) {
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

      // finalScores から重み付きスコア算出（共通ロジック）
      const manualScoreBreakdown = calculateManualScore(finalScores)
      const manualScore = Math.round(manualScoreBreakdown.total * 10) / 10
      const attendanceBonus = (current.metrics as { attendanceBonus: number }).attendanceBonus
      const totalScore = Math.round((manualScore + attendanceBonus) * 10) / 10
      const rank = calculateRank(totalScore)

      // 昇給額
      const yearsFromHire = current.yearsFromHire as number
      const raiseAmount = getRaiseAmount(rank, yearsFromHire, undefined, settings.raiseTable)

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

    // ── 承認済み評価を最新ロジックで再計算（2026-05-15 追加） ──
    // 過去にロジック不整合や計算ミスで誤った値が保存されたセッションを、
    // 現在のロジック (lib/evaluation-config.ts) で再計算して保存し直す。
    // 評価内容 (finalScores) は変更しない。スコア・ランク・昇給額のみ更新する。
    //
    // body 例: { action: 'recalculateApproved', evaluationId: '204_2026-05-07' }
    // body 例: { action: 'recalculateApproved', all: true }  // 全承認済みを一括
    if (action === 'recalculateApproved') {
      const { evaluationId, all } = body as { evaluationId?: string; all?: boolean }
      const settings = await getEvaluationSettings()

      const targets: string[] = []
      if (all) {
        const allSnap = await getDocs(collection(db, 'evaluations'))
        allSnap.forEach(d => {
          if (d.data().status === 'approved') targets.push(d.id)
        })
      } else if (evaluationId) {
        targets.push(evaluationId)
      } else {
        return NextResponse.json({ error: 'evaluationId か all=true のどちらか必須' }, { status: 400 })
      }

      const results: { id: string; before: { rank?: string; raise?: number; total?: number }; after: { rank: string; raise: number; total: number } }[] = []
      for (const id of targets) {
        const ref = doc(db, 'evaluations', id)
        const snap = await getDoc(ref)
        if (!snap.exists()) continue
        const d = snap.data()
        if (d.status !== 'approved') continue
        const finalScores = d.finalScores as EvaluationScores
        if (!finalScores) continue

        const breakdown = calculateManualScore(finalScores)
        const manualScore = Math.round(breakdown.total * 10) / 10
        const bonus = (d.metrics?.attendanceBonus as number) ?? 0
        const totalScore = Math.round((manualScore + bonus) * 10) / 10
        const newRank = calculateRank(totalScore)
        const years = d.yearsFromHire as number
        const newRaise = getRaiseAmount(newRank, years, undefined, settings.raiseTable)

        results.push({
          id,
          before: { rank: d.rank, raise: d.raiseAmount, total: d.totalScore },
          after: { rank: newRank, raise: newRaise, total: totalScore },
        })

        await updateDoc(ref, {
          manualScore,
          totalScore,
          rank: newRank,
          raiseAmount: newRaise,
          recalculatedAt: new Date().toISOString(),
        })
      }
      await logActivity('admin', 'evaluation.recalculateApproved', `承認済み評価を再計算: ${results.length}件`)
      return NextResponse.json({ success: true, count: results.length, results })
    }

    // ── ウェイト再計算（個別セッション） ──
    if (action === 'recalculateWeights') {
      const { evaluationId } = body as { evaluationId: string }
      if (!evaluationId) {
        return NextResponse.json({ error: 'evaluationId は必須です' }, { status: 400 })
      }
      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価セッションが見つかりません' }, { status: 404 })
      }
      const data = evalSnap.data()
      const wId = data.workerId as number
      const evaluatorIds = (data.evaluatorIds || []) as number[]
      const evalDate = data.evaluationDate as string
      const evaluatorWeights = await calcEvaluatorWeights(wId, evaluatorIds, evalDate)
      await updateDoc(evalRef, {
        evaluatorWeights,
        updatedAt: new Date().toISOString(),
      })
      await logActivity('admin', 'evaluation.recalculateWeights', `${data.workerName} のウェイトを再計算`)
      return NextResponse.json({ success: true, evaluatorWeights })
    }

    // ── ウェイト一括再計算（既存セッションへの遡及適用） ──
    if (action === 'recalculateAllWeights') {
      const evalSnap = await getDocs(collection(db, 'evaluations'))
      const mainData = await getMainData()
      let updated = 0
      let skipped = 0
      const errors: string[] = []
      for (const snap of evalSnap.docs) {
        const data = snap.data()
        const status = data.status as string
        // 承認済みは再計算不要（ウェイトは多数決プリフィル用なので、承認後は意味を持たない）
        if (status === 'approved') {
          skipped++
          continue
        }
        try {
          const wId = data.workerId as number
          const evaluatorIds = (data.evaluatorIds || []) as number[]
          const evalDate = data.evaluationDate as string
          if (!wId || !evaluatorIds.length || !evalDate) {
            skipped++
            continue
          }
          const weights = await calcEvaluatorWeights(wId, evaluatorIds, evalDate, mainData)
          await updateDoc(doc(db, 'evaluations', snap.id), {
            evaluatorWeights: weights,
            updatedAt: new Date().toISOString(),
          })
          updated++
        } catch (e) {
          errors.push(`${snap.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await logActivity('admin', 'evaluation.recalculateAllWeights', `ウェイト一括再計算: ${updated}件更新, ${skipped}件スキップ`)
      return NextResponse.json({ success: true, updated, skipped, errors })
    }

    // ── 出勤指標 再計算（個別セッション） ──
    if (action === 'recalculateMetrics') {
      const { evaluationId } = body as { evaluationId: string }
      if (!evaluationId) {
        return NextResponse.json({ error: 'evaluationId は必須です' }, { status: 400 })
      }
      const evalRef = doc(db, 'evaluations', evaluationId)
      const evalSnap = await getDoc(evalRef)
      if (!evalSnap.exists()) {
        return NextResponse.json({ error: '評価セッションが見つかりません' }, { status: 404 })
      }
      const data = evalSnap.data()
      const wId = data.workerId as number
      const evalDate = data.evaluationDate as string
      const metricsRaw = await calcMetricsForEvaluation({
        workerId: wId,
        evaluationDate: evalDate,
      })
      // 詳細内訳を含む全フィールドを保存
      const metrics = { ...metricsRaw }
      await updateDoc(evalRef, {
        metrics,
        updatedAt: new Date().toISOString(),
      })
      await logActivity('admin', 'evaluation.recalculateMetrics', `${data.workerName} の出勤指標を再計算`)
      return NextResponse.json({ success: true, metrics })
    }

    // ── 出勤指標 一括再計算（既存セッションへの遡及適用） ──
    if (action === 'recalculateAllMetrics') {
      const evalSnap = await getDocs(collection(db, 'evaluations'))
      let updated = 0
      let skipped = 0
      const errors: string[] = []
      for (const snap of evalSnap.docs) {
        const data = snap.data()
        const status = data.status as string
        // 承認済みは再計算しない（既に最終確定済みのため）
        if (status === 'approved') {
          skipped++
          continue
        }
        try {
          const wId = data.workerId as number
          const evalDate = data.evaluationDate as string
          if (!wId || !evalDate) {
            skipped++
            continue
          }
          const metricsRaw = await calcMetricsForEvaluation({
            workerId: wId,
            evaluationDate: evalDate,
          })
          const metrics = { ...metricsRaw }
          await updateDoc(doc(db, 'evaluations', snap.id), {
            metrics,
            updatedAt: new Date().toISOString(),
          })
          updated++
        } catch (e) {
          errors.push(`${snap.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await logActivity('admin', 'evaluation.recalculateAllMetrics', `出勤指標 一括再計算: ${updated}件更新, ${skipped}件スキップ`)
      return NextResponse.json({ success: true, updated, skipped, errors })
    }

    // ── 設定保存（昇給テーブルのみ） ──
    // 2026-05-15: 重み係数(weights) は lib/evaluation-config.ts に固定値として埋め込み済みのため
    //   admin カスタマイズの対象外とした。raiseTable のみ上書き可能。
    if (action === 'saveSettings') {
      const { raiseTable } = body as { raiseTable: RaiseTableRow[] }

      if (!raiseTable || raiseTable.length === 0) {
        return NextResponse.json({ error: '昇給テーブルが空です' }, { status: 400 })
      }

      const mainRef = doc(db, 'demmen', 'main')
      const mainSnap = await getDoc(mainRef)
      if (!mainSnap.exists()) {
        return NextResponse.json({ error: 'Main document not found' }, { status: 500 })
      }

      await updateDoc(mainRef, {
        evaluationSettings: { raiseTable },
      })
      await logActivity('admin', 'evaluation.saveSettings', '昇給テーブルを更新')

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Evaluation POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
