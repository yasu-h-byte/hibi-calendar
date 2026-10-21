'use client'
/**
 * 評価画面の状態・読み込み・処理（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない）。
 * 画面（page.tsx）は見た目だけ。タブごとの部品（components/*Tab.tsx）はここが返す ctx を受け取る。
 */

// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
// 2026-10-03: 飾りの絵文字を外した（線のアイコンか文字に）
import { useEffect, useState, useCallback } from 'react'
import { readAuth } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth } from '@/lib/api-client'
import { useSearchParams } from 'next/navigation'
import {
  Worker,
  ABCGrade,
  EvaluationSessionStatus,
  EvaluationRank,
  EvaluationScores,
  EvaluationMetrics,
  EvaluationReview,
  Evaluation,
  AuthUser,
} from '@/types'
import { fmtYen } from '@/lib/format'
import WorkerAvatar from '@/components/WorkerAvatar'
import { PageHeader, ToolButton, UnderlineTabs, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton, FieldError, type ChipTone } from '@/components/ui/PageParts'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { todayJstIso, addMonthsSafe } from '@/lib/date-utils'
import { isAlreadyRetired } from '@/lib/workers'
import { can } from '@/lib/permissions'
import { notifyBulkResult, rankColor, VISA_LABELS, nextEvalDate, hasBeenEvaluated, sessionStatusLabel, EVAL_ITEMS, CATEGORY_INFO, getScoreValue, setScoreValue, EVALUATOR_COLORS, isCategoryInScope, computePrefillScores, evaluatorNameLookup, fmtDateShort, daysSince, EV_COLS, EMPTY_SCORES, type TabId, type EvState, type EvFilter } from '@/lib/evaluation-view'
import { ABCRadio } from '@/components/evaluation/ABCRadio'
import { GradeBadge } from '@/components/evaluation/GradeBadge'
import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'
import { Icon } from '@/components/ui/Icon'
// 注意: 評価ロジック（重み・テーブル・計算関数）は lib/evaluation-config.ts に集約。
//   フロント・バックエンドで重複して定義すると過去のような不整合が再発する。
//   修正時は必ず lib/evaluation-config.ts だけを編集すること。
import {
  calculateManualScore,
  calculateRank,
  getRaiseAmount,
  applyLegalWageFloor,
  yearsFromHire as yearsFromDate,
} from '@/lib/evaluation-config'
import { minWageAt } from '@/lib/wage-analysis'

/** 一括再計算の結果の帯（更新・対象外・できなかった件数） */

export function useEvaluationPage() {
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<TabId>('list')

  // URL ?tab=xxx で初期タブを設定
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab === 'list' || tab === 'review' ||
        tab === 'monitor' || tab === 'approve' || tab === 'history') {
      setActiveTab(tab as TabId)
    }
  }, [searchParams])
  const [loading, setLoading] = useState(true)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [apiEvaluators, setApiEvaluators] = useState<{ id: number; name: string; job: string }[]>([])
  // 顔写真（2026-09-15 代表要望: 名前と顔がパッと分かるように）。無い人はイニシャル表示
  const { photos } = useWorkerPhotos()
  const [evFilter, setEvFilter] = useState<EvFilter>('all')
  const [evQuery, setEvQuery] = useState('')
  const [evOpenId, setEvOpenId] = useState<number | null>(null)

  // Review tab state
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null)
  const [myReview, setMyReview] = useState<EvaluationScores>(JSON.parse(JSON.stringify(EMPTY_SCORES)))
  const [myComment, setMyComment] = useState('')
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  // Approve tab state
  const [approveSessionId, setApproveSessionId] = useState<string | null>(null)
  const [finalScores, setFinalScores] = useState<EvaluationScores>(JSON.parse(JSON.stringify(EMPTY_SCORES)))
  const [finalComment, setFinalComment] = useState('')

  // Create session modal
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createWorkerId, setCreateWorkerId] = useState<number | null>(null)
  const [createEvaluatorIds, setCreateEvaluatorIds] = useState<number[]>([])
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [createEvaluatorError, setCreateEvaluatorError] = useState<string | null>(null)

  // 詳細閲覧モーダル
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null)

  // 履歴タブのフィルタ
  const [historyYear, setHistoryYear] = useState<string>('all')

  // ウェイト再計算状態
  const [recalculatingWeights, setRecalculatingWeights] = useState(false)

  // 提出成功通知（一時的に表示してフェード）
  const [submitSuccess, setSubmitSuccess] = useState<{
    workerName: string
    isEdit: boolean
    at: string
  } | null>(null)

  // 成功通知を一定時間後にクリア
  useEffect(() => {
    if (!submitSuccess) return
    const t = setTimeout(() => setSubmitSuccess(null), 8000)
    return () => clearTimeout(t)
  }, [submitSuccess])

  // ── ウェイト再計算（個別セッション） ──
  const handleRecalculateWeights = async (evaluationId: string) => {
    if (!(await confirmDialog({
      title: 'このセッションのウェイトを再計算しますか？',
      description: '過去の出面から共働日数を集計し直します。',
      confirmLabel: '再計算する',
    }))) return
    setRecalculatingWeights(true)
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recalculateWeights', evaluationId })
      })
      if (res.ok) {
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('再計算', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('再計算', e)
    }
    setRecalculatingWeights(false)
  }

  // ── ウェイト一括再計算（既存セッション全部） ──
  const handleRecalculateAllWeights = async () => {
    if (!(await confirmDialog({
      title: '進行中の全セッションのウェイトを再計算しますか？',
      description: '収集中・最終確認待ちのセッションが対象です。承認済みは変わりません。',
      confirmLabel: '再計算する',
    }))) return
    setRecalculatingWeights(true)
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recalculateAllWeights' })
      })
      if (res.ok) {
        const d = await res.json()
        notifyBulkResult('ウェイト', d)
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('再計算', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('再計算', e)
    }
    setRecalculatingWeights(false)
  }

  // ── 出勤指標 一括再計算（既存セッション全部） ──
  const handleRecalculateAllMetrics = async () => {
    if (!(await confirmDialog({
      title: '進行中の全セッションの出勤指標を再計算しますか？',
      description: '出勤率・残業平均・有給取得・ボーナスを今の決まりで出し直します。\n収集中・最終確認待ちのセッションが対象です。承認済みは変わりません。',
      confirmLabel: '再計算する',
    }))) return
    setRecalculatingWeights(true)
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recalculateAllMetrics' })
      })
      if (res.ok) {
        const d = await res.json()
        notifyBulkResult('出勤指標', d)
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('再計算', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('再計算', e)
    }
    setRecalculatingWeights(false)
  }

  // ── 出勤指標 再計算（個別セッション） ──
  const handleRecalculateMetrics = async (evaluationId: string) => {
    if (!(await confirmDialog({
      title: 'このセッションの出勤指標を再計算しますか？',
      description: '過去の出面から出勤率・残業平均などを集計し直します。',
      confirmLabel: '再計算する',
    }))) return
    setRecalculatingWeights(true)
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recalculateMetrics', evaluationId })
      })
      if (res.ok) {
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('再計算', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('再計算', e)
    }
    setRecalculatingWeights(false)
  }

  const isAdmin = can(authUser, 'wage.view')   // 権限表（lib/permissions.ts）で判定。旧: role の直書き（2026-10-21 総点検）
  // 評価カテゴリのスコープ分担（2026-05-12 ユーザー指示）
  //   - 靖仁さん (admin, id=0): 生活態度のみ評価
  //   - その他評価者: 日本語/勤務態度/職業能力の3つ（生活態度は非表示）
  const isAdminOnly = authUser?.role === 'admin' && authUser?.workerId === 0

  const getAuth = () => {
    try {
      const stored = readAuth()
      if (stored) {
        const { password, user } = stored
        return { password, user: user as AuthUser }
      }
    } catch { /* ignore */ }
    return { password: '', user: null }
  }

  const fetchData = useCallback(async () => {
    const { password, user } = getAuth()
    // 同じ人なら authUser の参照を変えない（2026-10-02 総合点検。旧: 再取得のたびに新しいオブジェクトになり、
    //   評価入力を同期し直す effect が走って、入力途中の点が黙って元に戻っていた）
    setAuthUser(prev => (prev && user && prev.workerId === user.workerId && prev.role === user.role) ? prev : user)
    try {
      const [wRes, eRes] = await Promise.all([
        fetchWithAuth('/api/workers', { password }),
        fetchWithAuth('/api/evaluation', { password }),
      ])
      if (wRes.ok) {
        const d = await wRes.json()
        const all: Worker[] = d.workers || []
        // 退職の判定は「今日の時点で退職日を過ぎたか」（lib/workers.ts isAlreadyRetired・2026-10-02 総合点検）。旧: `!w.retired` で退職「予定」の在籍者まで外れていた
        setWorkers(all.filter(w => w.visaType && w.visaType !== 'none' && !isAlreadyRetired(w.retired)))
      }
      if (eRes.ok) {
        const d = await eRes.json()
        setEvaluations(d.evaluations || [])
        if (d.evaluators) setApiEvaluators(d.evaluators)
      } else {
        // エラー詳細をコンソールに出力（デバッグ用）
        const errData = await eRes.json().catch(() => ({}))
        console.error('Evaluation API error:', eRes.status, errData)
      }
    } catch (e) {
      console.error('Evaluation fetch exception:', e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Review tab: load current user's review for selected worker ──
  // 保存済みの自分の評価を入力欄に入れ直す。対象者・評価の読み直しのときと、「修正する」のキャンセルで使う
  //   （2026-10-02 総合点検。旧: キャンセルは isEditing を戻すだけで、未保存の点が「提出済み」として表示されていた）
  const syncMyReviewFromSaved = useCallback(() => {
    if (!selectedWorkerId || !authUser) {
      setHasSubmitted(false)
      setIsEditing(false)
      setMyReview(JSON.parse(JSON.stringify(EMPTY_SCORES)))
      setMyComment('')
      return
    }
    const session = evaluations.find(
      e => e.workerId === selectedWorkerId &&
        e.evaluatorIds.includes(authUser.workerId) &&
        e.status !== 'approved'
    )
    if (!session) {
      setHasSubmitted(false)
      setIsEditing(false)
      setMyReview(JSON.parse(JSON.stringify(EMPTY_SCORES)))
      setMyComment('')
      return
    }
    const myExisting = session.reviews.find(r => r.evaluatorId === authUser.workerId)
    if (myExisting) {
      setMyReview(JSON.parse(JSON.stringify(myExisting.scores)))
      setMyComment(myExisting.comment)
      setHasSubmitted(true)
      setIsEditing(false)
    } else {
      setMyReview(JSON.parse(JSON.stringify(EMPTY_SCORES)))
      setMyComment('')
      setHasSubmitted(false)
      setIsEditing(false)
    }
  }, [selectedWorkerId, authUser, evaluations])
  useEffect(() => { syncMyReviewFromSaved() }, [syncMyReviewFromSaved])

  // Workers with active sessions where current user is an evaluator
  const reviewableWorkers = workers.filter(w =>
    evaluations.some(
      e => e.workerId === w.id &&
        e.status !== 'approved' &&
        authUser &&
        e.evaluatorIds.includes(authUser.workerId)
    )
  )

  // Get session for selected worker in review tab
  const reviewSession = selectedWorkerId && authUser
    ? evaluations.find(
      e => e.workerId === selectedWorkerId &&
        e.evaluatorIds.includes(authUser.workerId) &&
        e.status !== 'approved'
    )
    : null

  // All workers eligible to be evaluators (from API: shokucho + approver + admin)
  const allPossibleEvaluators = apiEvaluators.map(e => ({
    id: e.id,
    name: e.name,
    jobType: e.job === 'shokucho' ? '職長' : e.job === 'yakuin' ? '役員' : e.job,
  }))

  // ── Submit my review ──
  /** 提出。止めた（対象が無い）ときは null・サーバが断った/通信失敗（帯はここで出す）は false。SaveButton の約束どおり */
  const handleSubmitReview = async (): Promise<boolean | null> => {
    if (!reviewSession || !authUser) return null
    let ok = false
    const { password } = getAuth()
    const wasEditing = isEditing
    const targetName = reviewSession.workerName
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'submitReview',
          evaluationId: reviewSession.id,
          evaluatorId: authUser.workerId,
          evaluatorName: authUser.name,
          scores: myReview,
          comment: myComment
        })
      })
      if (res.ok) {
        await fetchData()
        // 成功バナーが見えるよう先頭にスクロール
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
        // 一時的に成功通知バナーを表示
        setSubmitSuccess({
          workerName: targetName,
          isEdit: wasEditing,
          at: new Date().toISOString(),
        })
        notify.success(`${targetName} さんの評価を${wasEditing ? '修正' : '提出'}しました`, 'ほかの評価対象者がいるときは、上の「対象スタッフ」から続けて評価してください。')
        ok = true
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('提出', err.error || 'サーバが受け付けませんでした', '入力は画面に残っています。もう一度お試しください。')
      }
    } catch (e) {
      notify.failed('提出', e)
    }
    return ok
  }

  // ── Create evaluation session ──
  /** セッション作成。入力の不備で止めた（欄の下の赤字）ときは null・サーバが断った/通信失敗（帯はここで出す）は false。SaveButton の約束どおり */
  const handleCreateSession = async (): Promise<boolean | null> => {
    const workerError = createWorkerId ? null : '対象スタッフを選んでください'
    const evaluatorError = createEvaluatorIds.length > 0 ? null : '評価者を1人以上選んでください'
    setCreateWorkerError(workerError)
    setCreateEvaluatorError(evaluatorError)
    if (workerError || evaluatorError) return null
    let ok = false
    const { password } = getAuth()
    try {
      const worker = workers.find(w => w.id === createWorkerId)
      if (!worker) {
        notify.error('スタッフが見つかりません', '人員の一覧を読み直してから、もう一度選んでください。')
        return null
      }
      // 評価者が空の場合は evaluatorIds を送らず、APIのデフォルト動作（職長+政仁+靖仁）に任せる
      const requestBody: Record<string, unknown> = {
        action: 'create',
        workerId: createWorkerId,
        workerName: worker.name,
        evaluationDate: todayJstIso(),   // toISOString は UTC 日付。JST 0〜9時に前日になるため不可
      }
      if (createEvaluatorIds.length > 0) {
        requestBody.evaluatorIds = createEvaluatorIds
      }
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })
      if (res.ok) {
        setShowCreateModal(false)
        setCreateWorkerId(null)
        setCreateEvaluatorIds([])
        await fetchData()
        notify.success(`${worker.name} さんの評価セッションを作成しました`, `評価者 ${createEvaluatorIds.length}名に知らせが届きます。`)
        ok = true
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('作成', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('作成', e)
    }
    return ok
  }

  const closeCreateModal = () => {
    setShowCreateModal(false)
    setCreateWorkerId(null)
    setCreateEvaluatorIds([])
    setCreateWorkerError(null)
    setCreateEvaluatorError(null)
  }

  // ── Approve with final scores ──
  /** 最終承認。止めた（対象が無い）ときは null・サーバが断った/通信失敗（帯はここで出す）は false。SaveButton の約束どおり */
  const handleApprove = async (): Promise<boolean | null> => {
    if (!approveSessionId || !authUser) return null
    const session = evaluations.find(e => e.id === approveSessionId)
    if (!session) return null

    const calc = calculateManualScore(finalScores)
    const bonus = session.metrics?.attendanceBonus ?? 0
    const totalScore = calc.total + bonus
    const rank = calculateRank(totalScore)
    const worker = workers.find(w => w.id === session.workerId)
    // 2026-09-14: サーバと同じくセッション作成時に保存した「記念日の回数」で引く（旧: 今日時点の完了年数でズレていた）
    const years = session.yearsFromHire || (worker?.hireDate ? yearsFromDate(worker.hireDate) : 1)
    const raiseAmount = getRaiseAmount(rank, years, worker?.hourlyRate)

    let ok = false
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'approve',
          evaluationId: approveSessionId,
          approvedBy: authUser.workerId,
          finalScores,
          finalComment,
          manualScore: calc.total,
          totalScore,
          rank,
          raiseAmount
        })
      })
      if (res.ok) {
        // 確定値はサーバが法令フロア適用込みで再計算する。表示はその値を使う
        const result = await res.json().catch(() => null)
        const finalRaise = result?.raiseAmount ?? raiseAmount
        const floorNote = result?.raiseFlooredToLegalMin
          ? ` 法令の下限（時給${result.raiseLegalMinRate}円）に合わせ、+${result.raiseBaseAmount}円 → +${finalRaise}円 に底上げしました。`
          : ''
        setApproveSessionId(null)
        await fetchData()
        // 昇給額の結果は読んで確かめたいので、閉じるまで残す（notify.success の sticky・2026-10-03）
        notify.success(`${session.workerName} さんの評価を承認しました`, `ランク ${rank}・推奨昇給 +${finalRaise}円/h${floorNote}`, { sticky: true })
        ok = true
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('承認', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('承認', e)
    }
    return ok
  }

  // ── Score preview for review tab ──
  const reviewCalc = calculateManualScore(myReview)

  // ── ABC Radio Button ──
  // 各ランクの評価目安を常時表示し、選択中ランクの説明を強調する。
  // ── Tabs ──
  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'list', label: '一覧' },
    { id: 'review', label: '評価入力' },
    { id: 'monitor', label: '進捗監視', adminOnly: true },
    { id: 'approve', label: '承認', adminOnly: true },
    { id: 'history', label: '履歴', adminOnly: true },
  ]

  const visibleTabs = tabs.filter(t => !t.adminOnly || isAdmin)
  // ?tab=approve などで見られないタブが選ばれたら一覧に戻す（何も出ない画面にしない）
  const effectiveTab: TabId = visibleTabs.some(t => t.id === activeTab) ? activeTab : 'list'


  // ── 一覧の行（2026-10-01 改修: 今やること・1人1行・右から開く）──
  const today = todayJstIso()
  const soonLimit = addMonthsSafe(today, 2)
  const evalRows = workers.map(w => {
    const wEvals = evaluations.filter(e => e.workerId === w.id)
    const latest = [...wEvals].sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0]
    const nextDate = nextEvalDate(w.hireDate || '', wEvals)
    const isOverdue = hasBeenEvaluated(wEvals) && nextDate !== '--' && nextDate <= today
    // 進行中（collecting/reviewing）優先、なければ最新（承認済み）
    const active = wEvals.filter(e => e.status !== 'approved').sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0]
    const session = active || latest
    const youAreEvaluator = !!(session && authUser && session.evaluatorIds.includes(authUser.workerId))
    const youSubmitted = youAreEvaluator && !!session?.reviews.some(r => r.evaluatorId === authUser?.workerId)
    const state: EvState = active ? (active.status === 'reviewing' ? 'reviewing' : 'collecting') : latest?.status === 'approved' ? 'approved' : 'none'
    const soon = !active && nextDate !== '--' && nextDate <= soonLimit
    return { w, latest, nextDate, isOverdue, active, session, youAreEvaluator, youSubmitted, state, soon }
  }).sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
    return a.nextDate.localeCompare(b.nextDate)
  })
  type EvRow = typeof evalRows[number]
  const collecting = evalRows.filter(r => r.state === 'collecting')
  const myPending = collecting.filter(r => r.youAreEvaluator && !r.youSubmitted)
  const reviewing = evalRows.filter(r => r.state === 'reviewing')
  // 評価を始めている人（評価中・承認待ち）は「もうすぐ評価日」に数えない（評価日を過ぎていても）
  const isSoonRow = (r: EvRow) => !r.active && (r.soon || r.isOverdue)
  const soonRows = evalRows.filter(isSoonRow)
  const missingNames = (s: Evaluation) => {
    const done = new Set(s.reviews.map(r => r.evaluatorId))
    return s.evaluatorIds.filter(id => !done.has(id)).map(id => evaluatorNameLookup(id, apiEvaluators, workers))
  }
  const shownRows = evalRows
    .filter(r => evFilter === 'all' || (evFilter === 'soon' ? isSoonRow(r) : evFilter === 'mine' ? (r.youAreEvaluator && !r.youSubmitted && r.state === 'collecting') : r.state === evFilter))
    .filter(r => !evQuery.trim() || r.w.name.replace(/[\s　]/g, '').toLowerCase().includes(evQuery.replace(/[\s　]/g, '').toLowerCase()))
  const openRow = evalRows.find(r => r.w.id === evOpenId) || null
  const STATE_CHIP: Record<EvState, { label: string; tone: ChipTone }> = {
    collecting: { label: '評価中', tone: 'red' },
    reviewing: { label: '承認待ち', tone: 'blue' },
    approved: { label: '承認済み', tone: 'green' },
    none: { label: 'まだ評価していない', tone: 'gray' },
  }
  // wage.view のない人（職長など）には、API が自分のレビューしか返さない（route.ts の shape-by-role）。
  //   ほかの評価者の入力状況は分からないので、件数・点・「まだ」を出さず、自分の状況だけ出す
  const seesAllReviews = can(authUser, 'wage.view')
  const progressDots = (s: Evaluation) => {
    if (!seesAllReviews) {
      const mine = !!authUser && s.evaluatorIds.includes(authUser.workerId)
      if (!mine) return null
      const done = s.reviews.some(r => r.evaluatorId === authUser!.workerId)
      return <span className="text-xs text-hibi-sub dark:text-gray-400">あなた: {done ? '入力済み' : 'まだ'}</span>
    }
    const done = new Set(s.reviews.map(r => r.evaluatorId))
    const n = s.evaluatorIds.filter(id => done.has(id)).length
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex gap-[3px]">
          {s.evaluatorIds.map((id, i) => <span key={i} className={`w-2.5 h-2.5 rounded-full ${i < n ? 'bg-green-700 dark:bg-green-400' : 'bg-gray-300 dark:bg-gray-600'}`} />)}
        </span>
        <span className="text-xs text-hibi-sub dark:text-gray-400 tabular-nums">{n}/{s.evaluatorIds.length}</span>
      </span>
    )
  }
  const openCreate = async (workerId: number | null) => {
    // 最新の評価者リストを取得してからモーダルを開く
    const { password } = getAuth()
    try {
      const res = await fetchWithAuth('/api/evaluation', { password })
      if (res.ok) {
        const d = await res.json()
        const evals = d.evaluators || []
        setApiEvaluators(evals)
        setCreateEvaluatorIds(evals.map((e: { id: number }) => e.id))
      }
    } catch { /* ignore */ }
    setCreateWorkerId(workerId)
    setEvOpenId(null)
    setShowCreateModal(true)
  }
  const goReview = (r: EvRow) => { setEvOpenId(null); setSelectedWorkerId(r.w.id); setActiveTab('review') }
  const goApprove = (s: Evaluation) => {
    setEvOpenId(null)
    setApproveSessionId(s.id)
    setFinalScores(computePrefillScores(s))
    setFinalComment('')
    setActiveTab('approve')
  }
  const toggleEvFilter = (f: EvFilter) => setEvFilter(evFilter === f ? 'all' : f)


  return {
    searchParams, activeTab, setActiveTab, loading, setLoading, authUser, setAuthUser, workers, setWorkers, evaluations, setEvaluations, apiEvaluators, setApiEvaluators, photos, evFilter, setEvFilter, evQuery, setEvQuery, evOpenId, setEvOpenId, selectedWorkerId, setSelectedWorkerId, myReview, setMyReview, myComment, setMyComment, hasSubmitted, setHasSubmitted, isEditing, setIsEditing, approveSessionId, setApproveSessionId, finalScores, setFinalScores, finalComment, setFinalComment, showCreateModal, setShowCreateModal, createWorkerId, setCreateWorkerId, createEvaluatorIds, setCreateEvaluatorIds, createWorkerError, setCreateWorkerError, createEvaluatorError, setCreateEvaluatorError, detailSessionId, setDetailSessionId, historyYear, setHistoryYear, recalculatingWeights, setRecalculatingWeights, submitSuccess, setSubmitSuccess, handleRecalculateWeights, handleRecalculateAllWeights, handleRecalculateAllMetrics, handleRecalculateMetrics, isAdmin, isAdminOnly, getAuth, fetchData, syncMyReviewFromSaved, reviewableWorkers, reviewSession, allPossibleEvaluators, handleSubmitReview, handleCreateSession, closeCreateModal, handleApprove, reviewCalc, tabs, visibleTabs, effectiveTab, today, soonLimit, evalRows, collecting, myPending, reviewing, isSoonRow, soonRows, missingNames, shownRows, openRow, STATE_CHIP, seesAllReviews, progressDots, openCreate, goReview, goApprove, toggleEvFilter,
  }
}

export type EvaluationPageCtx = ReturnType<typeof useEvaluationPage>
/** 一覧の 1 行（evalRows の要素） */
export type EvRow = EvaluationPageCtx['evalRows'][number]
