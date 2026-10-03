'use client'

// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
import { useEffect, useState, useCallback } from 'react'
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
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { todayJstIso, addMonthsSafe } from '@/lib/date-utils'
import { isAlreadyRetired } from '@/lib/workers'
import { can } from '@/lib/permissions'
// ⚠️ 評価ロジック（重み・テーブル・計算関数）は lib/evaluation-config.ts に集約。
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
function notifyBulkResult(what: string, d: { updated?: number; skipped?: number; errors?: unknown[] }) {
  const detail = `更新 ${d.updated ?? 0}件・対象外 ${d.skipped ?? 0}件`
  if (d.errors?.length) notify.error(`${what}を再計算できなかったセッションが ${d.errors.length}件あります`, detail)
  else notify.success(`${what}を再計算しました`, detail)
}

function rankColor(r: EvaluationRank): string {
  switch (r) {
    case 'S': return 'text-purple-600 dark:text-purple-400'
    case 'A': return 'text-blue-600 dark:text-blue-400'
    case 'B': return 'text-green-600 dark:text-green-400'
    case 'C': return 'text-yellow-600 dark:text-yellow-400'
    case 'D': return 'text-red-600 dark:text-red-400'
  }
}

const VISA_LABELS: Record<string, string> = {
  none: '日本人',
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号',
  jisshu: '技能実習', tokutei: '特定技能',
}

// 昇給テーブル / getRaiseAmount / yearsFromDate は lib/evaluation-config.ts に移動済み（import 経由）

/**
 * 次回評価日の計算:
 * - システムで一度も評価していない → 入社日の次の記念日（アラート対象外）
 * - 評価済み → 最後の承認済み評価日から1年後
 */
function nextEvalDate(hireDate: string, evaluations: Evaluation[]): string {
  const approved = evaluations.filter(e => e.status === 'approved')
  if (approved.length > 0) {
    // 最新の承認済み評価日から1年後
    const latestDate = approved
      .map(e => e.evaluationDate)
      .sort((a, b) => b.localeCompare(a))[0]
    return addMonthsSafe(latestDate, 12)
  }
  // 未評価: 入社日の次の記念日を表示（アラートは出さない）
  if (!hireDate) return '--'
  const currentYears = yearsFromDate(hireDate)
  const nextY = Math.max(1, currentYears + 1)
  return addMonthsSafe(hireDate, 12 * nextY)
}

/** システムで評価済みかどうか */
function hasBeenEvaluated(evaluations: Evaluation[]): boolean {
  return evaluations.some(e => e.status === 'approved')
}

function sessionStatusLabel(s: EvaluationSessionStatus, reviews: EvaluationReview[], evaluatorIds: number[]): { text: string; cls: string } {
  switch (s) {
    case 'collecting': {
      const count = reviews.length
      const total = evaluatorIds.length
      return {
        text: `収集中 (${count}/${total}提出)`,
        cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200',
      }
    }
    case 'reviewing':
      return { text: '最終確認中', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' }
    case 'approved':
      return { text: '承認済み', cls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200' }
    default:
      return { text: '不明', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
  }
}

import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'

// All 9 evaluation items in flat list for comparison table (generated from criteria definitions)
const EVAL_ITEMS = EVALUATION_CATEGORIES.flatMap(cat =>
  cat.criteria.map(c => ({ category: cat.key, key: c.key, label: c.label, A: c.A, B: c.B, C: c.C }))
)

// Category-level descriptions for section headers
const CATEGORY_INFO = Object.fromEntries(
  EVALUATION_CATEGORIES.map(c => [c.key, { label: c.label, icon: c.icon, color: c.color, weightLabel: c.weightLabel }])
)

function getScoreValue(scores: EvaluationScores, category: string, key: string): ABCGrade {
  const cat = scores[category as keyof EvaluationScores]
  return (cat as Record<string, ABCGrade>)[key]
}

function setScoreValue(scores: EvaluationScores, category: string, key: string, value: ABCGrade): EvaluationScores {
  const copy = JSON.parse(JSON.stringify(scores)) as EvaluationScores
  const cat = copy[category as keyof EvaluationScores] as Record<string, ABCGrade>
  cat[key] = value
  return copy
}

const EVALUATOR_COLORS = [
  { bg: 'bg-blue-100 dark:bg-blue-900', text: 'text-blue-700 dark:text-blue-300', header: 'bg-blue-500' },
  { bg: 'bg-green-100 dark:bg-green-900', text: 'text-green-700 dark:text-green-300', header: 'bg-green-500' },
  { bg: 'bg-orange-100 dark:bg-orange-900', text: 'text-orange-700 dark:text-orange-300', header: 'bg-orange-500' },
  { bg: 'bg-purple-100 dark:bg-purple-900', text: 'text-purple-700 dark:text-purple-300', header: 'bg-purple-500' },
]

/**
 * 評価者が当該カテゴリの評価対象かどうかを判定（2026-05-12 スコープ分担）
 *   - 生活態度 (living): 靖仁さん (id=0) のみ評価対象
 *   - 日本語/勤務態度/職業能力: 靖仁さん以外（職長 + 政仁さん）が対象
 */
function isCategoryInScope(evaluatorId: number, categoryKey: string): boolean {
  const isAdmin = evaluatorId === 0
  const isLiving = categoryKey === 'living'
  if (isLiving && !isAdmin) return false   // 生活態度は admin のみ
  if (!isLiving && isAdmin) return false   // 非生活態度は admin 以外
  return true
}

/**
 * 評価セッションの提出済み review から、最終評価の初期値（加重平均ベース）を計算する。
 *
 * 動作:
 *   - 各評価項目について、スコープ内の評価者の点数 (A=3,B=2,C=1) を重み付き加重平均
 *   - しきい値 ≥2.5=A / ≥1.5=B / それ以下=C
 *   - 該当評価者0人の項目は B のまま（EMPTY_SCORES のデフォルト）
 *   - 評価者の重みは session.evaluatorWeights から取得（未設定なら 1.0）
 *
 * 2026-05-13: 複数の入口（承認タブの「確認・承認」、一覧・履歴の「承認へ」）から
 *   呼ばれるため共通化。以前は片方の入口でこの初期化が走らず、全項目が「B」で
 *   表示されるバグがあった。
 */
function computePrefillScores(session: Evaluation): EvaluationScores {
  const prefill = JSON.parse(JSON.stringify(EMPTY_SCORES)) as EvaluationScores
  if (!session.reviews || session.reviews.length === 0) return prefill
  for (const item of EVAL_ITEMS) {
    let weightedSum = 0
    let totalWeight = 0
    for (const r of session.reviews) {
      if (!isCategoryInScope(r.evaluatorId, item.category)) continue
      const g = getScoreValue(r.scores, item.category, item.key)
      const gradeNum = g === 'A' ? 3 : g === 'B' ? 2 : 1
      const w = session.evaluatorWeights?.[r.evaluatorId]?.weight ?? 1.0
      weightedSum += gradeNum * w
      totalWeight += w
    }
    if (totalWeight === 0) continue   // 該当者0 → B のまま
    const avg = weightedSum / totalWeight
    const best: ABCGrade = avg >= 2.5 ? 'A' : avg >= 1.5 ? 'B' : 'C'
    const cat = prefill[item.category as keyof EvaluationScores] as Record<string, ABCGrade>
    cat[item.key] = best
  }
  return prefill
}

// 評価者IDから名前を引く（apiEvaluators 優先 → workers → ID表示）
function evaluatorNameLookup(
  id: number,
  apiEvaluators: { id: number; name: string }[],
  workers: { id: number; name: string }[],
): string {
  const a = apiEvaluators.find(e => e.id === id)
  if (a) return a.name
  const w = workers.find(w2 => w2.id === id)
  if (w) return w.name
  return `ID:${id}`
}

// "MM/DD HH:mm" 短縮形式
function fmtDateShort(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 提出日からの経過日数
function daysSince(iso: string): number {
  if (!iso) return 0
  const d = new Date(iso)
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

type TabId = 'list' | 'review' | 'monitor' | 'approve' | 'history'
type EvState = 'collecting' | 'reviewing' | 'approved' | 'none'
type EvFilter = 'all' | 'collecting' | 'reviewing' | 'approved' | 'soon' | 'mine'
const EV_COLS = 'lg:grid-cols-[minmax(0,1fr)_100px_60px_minmax(0,1fr)_60px_150px]'

const EMPTY_SCORES: EvaluationScores = {
  japanese: { understanding: 'B' as ABCGrade, reporting: 'B' as ABCGrade, safety: 'B' as ABCGrade },
  attitude: { punctuality: 'B' as ABCGrade, safetyAwareness: 'B' as ABCGrade, teamwork: 'B' as ABCGrade, compliance: 'B' as ABCGrade },
  skill: { level: 'B' as ABCGrade, speed: 'B' as ABCGrade, planning: 'B' as ABCGrade },
  living: { neighborCare: 'B' as ABCGrade, ruleCompliance: 'B' as ABCGrade, cleanliness: 'B' as ABCGrade },
}

// ── Main Component ──

export default function EvaluationPage() {
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
  const [saving, setSaving] = useState(false)
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
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'recalculateWeights', evaluationId }),
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
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'recalculateAllWeights' }),
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
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'recalculateAllMetrics' }),
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
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'recalculateMetrics', evaluationId }),
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

  const isAdmin = authUser?.role === 'admin' || authUser?.role === 'approver'
  // 評価カテゴリのスコープ分担（2026-05-12 ユーザー指示）
  //   - 靖仁さん (admin, id=0): 生活態度のみ評価
  //   - その他評価者: 日本語/勤務態度/職業能力の3つ（生活態度は非表示）
  const isAdminOnly = authUser?.role === 'admin' && authUser?.workerId === 0

  const getAuth = () => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { password, user } = JSON.parse(stored)
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
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/evaluation', { headers: { 'x-admin-password': password } }),
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
  const handleSubmitReview = async () => {
    if (!reviewSession || !authUser) return
    setSaving(true)
    const { password } = getAuth()
    const wasEditing = isEditing
    const targetName = reviewSession.workerName
    try {
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          action: 'submitReview',
          evaluationId: reviewSession.id,
          evaluatorId: authUser.workerId,
          evaluatorName: authUser.name,
          scores: myReview,
          comment: myComment,
        }),
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
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('提出', err.error || 'サーバが受け付けませんでした', '入力は画面に残っています。もう一度お試しください。')
      }
    } catch (e) {
      notify.failed('提出', e)
    }
    setSaving(false)
  }

  // ── Create evaluation session ──
  const handleCreateSession = async () => {
    const workerError = createWorkerId ? null : '対象スタッフを選んでください'
    const evaluatorError = createEvaluatorIds.length > 0 ? null : '評価者を1人以上選んでください'
    setCreateWorkerError(workerError)
    setCreateEvaluatorError(evaluatorError)
    if (workerError || evaluatorError) return
    setSaving(true)
    const { password } = getAuth()
    try {
      const worker = workers.find(w => w.id === createWorkerId)
      if (!worker) {
        notify.error('スタッフが見つかりません', '人員の一覧を読み直してから、もう一度選んでください。')
        setSaving(false)
        return
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
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify(requestBody),
      })
      if (res.ok) {
        setShowCreateModal(false)
        setCreateWorkerId(null)
        setCreateEvaluatorIds([])
        await fetchData()
        notify.success(`${worker.name} さんの評価セッションを作成しました`, `評価者 ${createEvaluatorIds.length}名に知らせが届きます。`)
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('作成', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('作成', e)
    }
    setSaving(false)
  }

  // ── Approve with final scores ──
  const handleApprove = async () => {
    if (!approveSessionId || !authUser) return
    const session = evaluations.find(e => e.id === approveSessionId)
    if (!session) return

    const calc = calculateManualScore(finalScores)
    const bonus = session.metrics?.attendanceBonus ?? 0
    const totalScore = calc.total + bonus
    const rank = calculateRank(totalScore)
    const worker = workers.find(w => w.id === session.workerId)
    // 2026-09-14: サーバと同じくセッション作成時に保存した「記念日の回数」で引く（旧: 今日時点の完了年数でズレていた）
    const years = session.yearsFromHire || (worker?.hireDate ? yearsFromDate(worker.hireDate) : 1)
    const raiseAmount = getRaiseAmount(rank, years, worker?.hourlyRate)

    setSaving(true)
    const { password } = getAuth()
    try {
      const res = await fetch('/api/evaluation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
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
          raiseAmount,
        }),
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
        notify.success(`${session.workerName} さんの評価を承認しました`, `ランク ${rank}・推奨昇給 +${finalRaise}円/h${floorNote}`)
      } else {
        const err = await res.json().catch(() => ({}))
        notify.failed('承認', err.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('承認', e)
    }
    setSaving(false)
  }

  // ── Score preview for review tab ──
  const reviewCalc = calculateManualScore(myReview)

  // ── ABC Radio Button ──
  // 各ランクの評価目安を常時表示し、選択中ランクの説明を強調する。
  function ABCRadio({
    value,
    onChange,
    label,
    disabled,
    descA,
    descB,
    descC,
  }: {
    value: ABCGrade
    onChange: (v: ABCGrade) => void
    label: string
    disabled?: boolean
    descA?: string
    descB?: string
    descC?: string
  }) {
    const grades: ABCGrade[] = ['A', 'B', 'C']
    const descs: Record<ABCGrade, string | undefined> = { A: descA, B: descB, C: descC }

    // 各ランクのスタイル定義
    const gradeStyles: Record<ABCGrade, {
      activeBtn: string
      activeRow: string
      mark: string
    }> = {
      A: {
        activeBtn: 'bg-green-500 text-white shadow-md',
        activeRow: 'bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700',
        mark: 'bg-green-500 text-white',
      },
      B: {
        activeBtn: 'bg-yellow-500 text-white shadow-md',
        activeRow: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700',
        mark: 'bg-yellow-500 text-white',
      },
      C: {
        activeBtn: 'bg-red-400 text-white shadow-md',
        activeRow: 'bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700',
        mark: 'bg-red-400 text-white',
      },
    }

    return (
      <div className="py-3">
        {/* 項目名 */}
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">
          {label}
        </div>

        {/* 各ランクの説明＋選択ボタンを行ごとにカード化 */}
        <div className="space-y-1.5">
          {grades.map(g => {
            const active = value === g
            const styles = gradeStyles[g]
            const desc = descs[g]
            const baseRow = active
              ? `border-2 ${styles.activeRow}`
              : 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60'
            return (
              <button
                key={g}
                type="button"
                disabled={disabled}
                onClick={() => onChange(g)}
                className={`w-full flex items-start gap-3 rounded-lg p-2.5 text-left transition-all ${baseRow} ${
                  disabled
                    ? 'opacity-60 cursor-not-allowed'
                    : 'hover:border-gray-400 dark:hover:border-gray-500 cursor-pointer'
                }`}
              >
                {/* ランクマーク */}
                <span
                  className={`flex-shrink-0 w-9 h-9 rounded-lg font-bold text-sm flex items-center justify-center transition-all ${
                    active
                      ? styles.activeBtn
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {g}
                </span>
                {/* 説明文 */}
                <span
                  className={`flex-1 text-xs leading-relaxed pt-1 ${
                    active
                      ? 'text-gray-900 dark:text-gray-100 font-medium'
                      : 'text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {desc || (g === 'A' ? '良好' : g === 'B' ? '標準' : '改善必要')}
                </span>
                {/* 選択中マーク */}
                {active && (
                  <span className="flex-shrink-0 text-green-600 dark:text-green-400 font-bold text-sm pt-1">
                    ✓
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Grade badge (small, for comparison table) ──
  function GradeBadge({ grade }: { grade: ABCGrade }) {
    let cls = 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200'
    if (grade === 'A') cls = 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
    if (grade === 'B') cls = 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
    if (grade === 'C') cls = 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
    return (
      <span className={`inline-block w-8 h-8 rounded-lg text-center leading-8 font-bold text-sm ${cls}`}>
        {grade}
      </span>
    )
  }

  // ── 評価者バッジ列（提出/未提出を視覚化、自分は青リング） ──
  function EvaluatorBadgeList({
    session,
    compact = false,
    showProgress = true,
  }: {
    session: Evaluation
    compact?: boolean
    showProgress?: boolean
  }) {
    const submitted = new Set(session.reviews.map(r => r.evaluatorId))
    const total = session.evaluatorIds.length
    const submittedCount = session.evaluatorIds.filter(id => submitted.has(id)).length
    const pct = total > 0 ? Math.round((submittedCount / total) * 100) : 0

    let progressColor = 'bg-blue-500'
    let progressLabel = `${submittedCount}/${total}名 提出`
    if (session.status === 'approved') {
      progressColor = 'bg-green-500'
      progressLabel = '承認済み'
    } else if (session.status === 'reviewing') {
      progressColor = 'bg-amber-500'
      progressLabel = '最終確認待ち'
    }

    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          {session.evaluatorIds.map(id => {
            const name = evaluatorNameLookup(id, apiEvaluators, workers)
            const review = session.reviews.find(r => r.evaluatorId === id)
            const isSubmitted = !!review
            const isMe = authUser?.workerId === id
            const cls = isSubmitted
              ? 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-300 dark:border-green-700'
              : 'bg-gray-50 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400 border-dashed border-gray-300 dark:border-gray-600'
            const ring = isMe ? 'ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-800' : ''
            const stale = isSubmitted ? '' : daysSince(session.createdAt) >= 7 ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800' : ''
            const tip = isSubmitted && review
              ? `${name}（${fmtDateShort(review.submittedAt)} 提出）`
              : `${name}（未提出${daysSince(session.createdAt) >= 7 ? ` / 開始から${daysSince(session.createdAt)}日経過` : ''}）`
            return (
              <span
                key={id}
                title={tip}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-medium border ${stale || cls} ${ring}`}
              >
                {isMe && <span className="opacity-70">👤</span>}
                <span className="opacity-70">{isSubmitted ? '✓' : '○'}</span>
                <span className={compact ? 'max-w-[5rem] truncate' : ''}>{name}</span>
              </span>
            )
          })}
        </div>
        {showProgress && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-[140px]">
              <div className={`h-full transition-all ${progressColor}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-3xs text-gray-500 dark:text-gray-400 tabular-nums">
              {progressLabel}
            </span>
          </div>
        )}
      </div>
    )
  }

  // ── 詳細ビュー（read-only 比較表 + コメント + 最終結果） ──
  function SessionDetailView({ session }: { session: Evaluation }) {
    const worker = workers.find(w => w.id === session.workerId)
    const years = worker?.hireDate ? yearsFromDate(worker.hireDate) : 1
    const submittedSet = new Set(session.reviews.map(r => r.evaluatorId))
    const pendingIds = session.evaluatorIds.filter(id => !submittedSet.has(id))

    return (
      <div className="space-y-4">
        {/* ヘッダー */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={56} />
              <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {session.workerName}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                評価日: {session.evaluationDate}
                {session.approvedAt && ` / 承認日時: ${new Date(session.approvedAt).toLocaleString('ja-JP')}`}
              </p>
              </div>
            </div>
            <div className="text-right flex items-center gap-2">
              {session.status === 'approved' && (
                <a
                  href={`/evaluation/${session.id}/print`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-900 text-white inline-flex items-center gap-1"
                  title="A4 1枚で評価表を印刷"
                >🖨 A4印刷</a>
              )}
              {session.status === 'approved' && session.rank && (
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-gray-500">ランク</span>
                  <span className={`text-3xl font-bold ${rankColor(session.rank)}`}>
                    {session.rank}
                  </span>
                </div>
              )}
              {session.status === 'reviewing' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  最終確認待ち
                </span>
              )}
              {session.status === 'collecting' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  {session.reviews.length}/{session.evaluatorIds.length}名 提出
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-sm">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">在留資格</span>
              <span className="text-gray-900 dark:text-white">
                {VISA_LABELS[worker?.visaType || ''] || worker?.visaType || '--'}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">入社日</span>
              <span className="text-gray-900 dark:text-white">{worker?.hireDate || '--'}</span>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">勤続年数</span>
              <span className="text-gray-900 dark:text-white">{years}年</span>
            </div>
            {session.status === 'approved' && session.totalScore != null && (
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">合計スコア</span>
                <span className="font-bold text-gray-900 dark:text-white">
                  {session.totalScore.toFixed(1)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 提出状況 */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
          <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">提出状況</h4>
          <EvaluatorBadgeList session={session} />
          {pendingIds.length > 0 && session.status !== 'approved' && (
            <p className="text-xs text-orange-600 dark:text-orange-400 mt-2">
              ⏳ {pendingIds.length}名の提出待ち
              {daysSince(session.createdAt) >= 7 && `（開始から${daysSince(session.createdAt)}日経過）`}
            </p>
          )}
        </div>

        {/* 評価者ウェイト */}
        {(session.evaluatorWeights || isAdmin) && session.status !== 'approved' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                評価者ウェイト
                <span className="ml-2 text-2xs font-normal text-gray-500">
                  共働実績ベース（直近1年）：加重平均プリフィルで重みが効きます
                </span>
              </h4>
              {isAdmin && (
                <button
                  onClick={() => handleRecalculateWeights(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-2xs font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  {recalculatingWeights ? '...' : '🔄 再計算'}
                </button>
              )}
            </div>
            {session.evaluatorWeights ? (
              <>
                {/* 動的キャップ情報 (2026-05-12 追加) */}
                {(() => {
                  const anyW = Object.values(session.evaluatorWeights || {}).find(w => w?.monthsWithData != null)
                  if (!anyW) return null
                  return (
                    <div className="mb-2 text-2xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 rounded-md">
                      📊 データのある月数: <strong>{anyW.monthsWithData}/12</strong> ヶ月
                      → 年共働キャップ: <strong>{anyW.dynamicCap}日</strong>
                      <span className="ml-2 opacity-80">
                        （旧システム稼働前の月はデータが少ないため、データのある月数で按分しキャップを縮小。
                        主担当職長が短期間でも適正なウェイトを得られるよう調整）
                      </span>
                      <div className="mt-1 opacity-80">
                        共働日 ＝ 対象スタッフの出勤日のうち「評価者が同じ現場に同じ日に出勤した日」または「評価者がその月の職長だった現場の日」（2026-09-10 から出面ベース）
                      </div>
                    </div>
                  )
                })()}
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">評価者</th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="参考表示（ウェイトには影響しない）">直近90日<span className="text-3xs opacity-60 ml-0.5">(参考)</span></th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="ウェイト算出の根拠">過去365日<span className="text-3xs opacity-60 ml-0.5">(主)</span></th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400">ウェイト</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {session.evaluatorIds.map(eid => {
                      const w = session.evaluatorWeights![eid]
                      const name = evaluatorNameLookup(eid, apiEvaluators, workers)
                      if (!w) {
                        return (
                          <tr key={eid}>
                            <td className="px-2 py-1 text-gray-700 dark:text-gray-300">{name}</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                          </tr>
                        )
                      }
                      const weightBarPct = Math.round(w.weight * 100)
                      const barColor = w.isApprover
                        ? 'bg-purple-400'
                        : w.weight >= 0.8
                        ? 'bg-green-400'
                        : w.weight >= 0.5
                        ? 'bg-blue-400'
                        : 'bg-gray-400'
                      return (
                        <tr key={eid}>
                          <td className="px-2 py-1 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            {name}
                            {w.isApprover && <span className="ml-1 text-purple-600 dark:text-purple-400" title="事業責任者">★</span>}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                            {w.isApprover ? '―' : `${w.recentPct}% (${w.recentDays}日)`}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                            {w.isApprover ? '―' : `${w.yearPct}% (${w.yearDays}日)`}
                          </td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                <div className={`h-full ${barColor}`} style={{ width: `${weightBarPct}%` }} />
                              </div>
                              <span className="font-bold tabular-nums w-10 text-right">{w.weight.toFixed(2)}</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                ウェイト未計算（旧形式セッション）。{isAdmin && '右上の「再計算」ボタンで算出できます。'}
              </p>
            )}
          </div>
        )}

        {/* 出席指標（詳細内訳付き） */}
        {session.metrics && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                出勤実績（過去1年）
                {session.metrics.computedAt && (
                  <span className="ml-2 text-2xs font-normal text-gray-500">
                    （{new Date(session.metrics.computedAt).toLocaleString('ja-JP')} 計算）
                  </span>
                )}
              </h4>
              {isAdmin && session.status !== 'approved' && (
                <button
                  onClick={() => handleRecalculateMetrics(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-2xs font-medium rounded-md border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 disabled:opacity-50"
                >
                  📊 再計算
                </button>
              )}
            </div>

            {/* サマリー */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率</span>
                <span className="font-bold text-lg text-gray-900 dark:text-white">{session.metrics.attendanceRate.toFixed(1)}%</span>
                {session.metrics.rawRate != null && session.metrics.rawRate > 100 && (
                  <span className="ml-1 text-3xs text-gray-400" title="100%キャップ前の生比率">
                    (生 {session.metrics.rawRate.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                <span className="text-gray-900 dark:text-white">{session.metrics.overtimeAvg.toFixed(1)}h/月</span>
                {session.metrics.totalOvertime != null && (
                  <span className="ml-1 text-3xs text-gray-400">
                    (合計 {session.metrics.totalOvertime.toFixed(1)}h)
                  </span>
                )}
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">有給取得</span>
                <span className="text-gray-900 dark:text-white">{session.metrics.plUsage}日</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率ボーナス</span>
                <span className="font-bold text-blue-600 dark:text-blue-400">+{session.metrics.attendanceBonus}点</span>
              </div>
            </div>

            {/* 詳細内訳（新ロジックで計算した分のみ表示） */}
            {session.metrics.applicablePrescribed != null && (
              <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {/* 出勤扱い内訳 */}
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
                    <div className="font-bold text-gray-700 dark:text-gray-300 mb-2">
                      出勤扱い内訳 <span className="text-gray-500 font-normal">合計 {session.metrics.presentDays?.toFixed(1) ?? '--'} 日</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">実出勤</span>
                        <span className="font-medium tabular-nums text-gray-900 dark:text-white">{session.metrics.workedDays?.toFixed(1) ?? '--'} 日</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">有給</span>
                        <span className="font-medium tabular-nums text-blue-600 dark:text-blue-400">{session.metrics.plDays ?? session.metrics.plUsage} 日</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">試験</span>
                        <span className="font-medium tabular-nums text-purple-600 dark:text-purple-400">{session.metrics.examDays ?? 0} 日</span>
                      </div>
                      {(session.metrics.compensationDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">補償（土曜0.6）</span>
                          <span className="font-medium tabular-nums text-gray-500" title="出勤率の分子・分母どちらにも入れない">
                            {session.metrics.compensationDays} 日 <span className="text-3xs">※対象外</span>
                          </span>
                        </div>
                      )}
                      {(session.metrics.restDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">欠勤</span>
                          <span className="font-medium tabular-nums text-red-600 dark:text-red-400">{session.metrics.restDays} 日</span>
                        </div>
                      )}
                      {(session.metrics.homeLeaveDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">帰国</span>
                          <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.homeLeaveDays} 日</span>
                        </div>
                      )}
                      {(session.metrics.siteOffDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">現場休</span>
                          <span className="font-medium tabular-nums text-gray-500">{session.metrics.siteOffDays} 日</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 期待出勤日内訳 */}
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
                    <div className="font-bold text-gray-700 dark:text-gray-300 mb-2">
                      期待出勤日 <span className="text-gray-500 font-normal">{session.metrics.applicablePrescribed} 日</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">月所定合計</span>
                        <span className="font-medium tabular-nums text-gray-900 dark:text-white">{session.metrics.prescribedTotal} 日</span>
                      </div>
                      {session.metrics.excludedDays && (
                        <>
                          {session.metrics.excludedDays.beforeHire > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 雇用前</span>
                              <span className="font-medium tabular-nums text-gray-500">{session.metrics.excludedDays.beforeHire} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.afterRetire > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 退職後</span>
                              <span className="font-medium tabular-nums text-gray-500">{session.metrics.excludedDays.afterRetire} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.homeLeave > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 帰国期間</span>
                              <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.excludedDays.homeLeave} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.longAbsence > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 長期不在(14日+)</span>
                              <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.excludedDays.longAbsence} 日</span>
                            </div>
                          )}
                          {Object.values(session.metrics.excludedDays).every(v => v === 0) && (
                            <div className="text-gray-400 italic">除外なし</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-2xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  💡 出勤率 = (実出勤 + 有給 + 試験) ÷ 期待出勤日 × 100（上限100%）。
                  ベトナム土曜の補償日（w=0.6）は分子・分母どちらにも含めません。
                  期待出勤日は月所定日数から雇用境界・帰国期間・長期不在を控除した値です。
                </div>
              </div>
            )}
          </div>
        )}

        {/* 評価者比較表（reviews が1件以上ある場合のみ） */}
        {session.reviews.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">評価者比較</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 w-32">
                      項目
                    </th>
                    {session.reviews.map((r, idx) => {
                      const w = session.evaluatorWeights?.[r.evaluatorId]
                      return (
                        <th
                          key={r.evaluatorId}
                          className={`px-3 py-3 text-center text-xs font-medium text-white border-b border-gray-200 dark:border-gray-700 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].header}`}
                        >
                          <div>{r.evaluatorName}</div>
                          {w && (
                            <div className="mt-1 text-3xs font-normal opacity-90">
                              {w.isApprover ? (
                                <span title={`事業責任者の固定ウェイト (${w.weight.toFixed(2)})`}>w={w.weight.toFixed(2)} ★</span>
                              ) : (
                                <span title={`過去365日 共働 ${w.yearDays}日 (うち直近90日 ${w.recentDays}日)${w.monthsWithData != null ? ` / データある月 ${w.monthsWithData}/12 (cap ${w.dynamicCap}日)` : ''}`}>
                                  w={w.weight.toFixed(2)}
                                  <span className="block opacity-80">年共働 {w.yearPct}% ({w.yearDays}日)</span>
                                </span>
                              )}
                            </div>
                          )}
                        </th>
                      )
                    })}
                    {session.status === 'approved' && session.finalScores && (
                      <>
                        <th className="px-3 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></th>
                        <th className="px-3 py-3 text-center text-xs font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 min-w-[100px]">
                          最終
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {EVAL_ITEMS.map((item, rowIdx) => {
                    // 担当外評価者を除外して「一致 / 分かれ」を判定（2026-05-12 スコープ反映）
                    const inScopeGrades = session.reviews
                      .filter(r => isCategoryInScope(r.evaluatorId, item.category))
                      .map(r => getScoreValue(r.scores, item.category, item.key))
                    const allSame = inScopeGrades.length > 0 && inScopeGrades.every(g => g === inScopeGrades[0])
                    const rowBg = rowIdx % 2 === 0 ? '' : 'bg-gray-50/50 dark:bg-gray-750/50'
                    return (
                      <tr key={`${item.category}_${item.key}`} className={rowBg}>
                        <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700">
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block w-2 h-2 rounded-full ${allSame ? 'bg-green-400' : 'bg-yellow-400'}`} />
                            {item.label}
                          </div>
                        </td>
                        {session.reviews.map(r => {
                          const inScope = isCategoryInScope(r.evaluatorId, item.category)
                          return (
                            <td key={r.evaluatorId} className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700">
                              {inScope ? (
                                <GradeBadge grade={getScoreValue(r.scores, item.category, item.key)} />
                              ) : (
                                <span className="text-gray-300 dark:text-gray-600 text-lg" title="担当外（評価対象外）">─</span>
                              )}
                            </td>
                          )
                        })}
                        {session.status === 'approved' && session.finalScores && (
                          <>
                            <td className="border-b border-gray-100 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></td>
                            <td className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700 bg-indigo-50/50 dark:bg-indigo-900/20">
                              <GradeBadge grade={getScoreValue(session.finalScores, item.category, item.key)} />
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-400" /> 全員一致
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" /> 意見分かれ
              </span>
            </div>
          </div>
        )}

        {/* コメント */}
        {session.reviews.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">評価者コメント</h4>
            <div className="space-y-3">
              {session.reviews.map((r, idx) => (
                <div key={r.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                  <p className={`text-xs font-medium ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                    {r.evaluatorName}
                    <span className="ml-2 text-gray-500 font-normal">
                      {fmtDateShort(r.submittedAt)} 提出
                    </span>
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">
                    {r.comment || '（コメントなし）'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 最終結果（承認済みのみ） */}
        {session.status === 'approved' && session.totalScore != null && session.rank && (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4">
            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">最終結果</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">手動スコア</span>
                <span className="font-medium text-gray-900 dark:text-white">{(session.manualScore ?? 0).toFixed(1)}</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">出勤率ボーナス</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">+{session.metrics?.attendanceBonus ?? 0}点</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">合計スコア</span>
                <span className="font-bold text-gray-900 dark:text-white">{session.totalScore.toFixed(1)}</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">ランク</span>
                <span className={`text-2xl font-bold ${rankColor(session.rank)}`}>{session.rank}</span>
              </div>
            </div>
            {session.raiseAmount != null && session.raiseAmount > 0 && (
              <p className="mt-3 text-sm font-bold text-green-600 dark:text-green-400">
                推奨昇給: +{session.raiseAmount}円/h（{session.yearsFromHire}回目の記念日の昇給）
              </p>
            )}
            {session.finalComment && (
              <div className="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">最終コメント:</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {session.finalComment}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

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
      const res = await fetch('/api/evaluation', { headers: { 'x-admin-password': password } })
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

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="賃金・評価"
        title="評価管理"
        sub="ベトナム人スタッフの年次評価。入社記念日ごとに評価して、時給を改定します"
        actions={isAdmin && effectiveTab === 'list' ? <>
          <ToolButton icon="chart" onClick={handleRecalculateAllMetrics} disabled={recalculatingWeights} title="進行中の評価の出勤率・残業平均・ボーナスを計算し直します">
            {recalculatingWeights ? '計算中...' : '出勤の指標を計算し直す'}
          </ToolButton>
          <ToolButton icon="users" onClick={handleRecalculateAllWeights} disabled={recalculatingWeights} title="進行中の評価の、評価者ごとの重みを出面から計算し直します">
            {recalculatingWeights ? '計算中...' : '評価者の重みを計算し直す'}
          </ToolButton>
          <button onClick={() => openCreate(null)}
            className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[0.9375rem] font-bold hover:bg-hibi-light inline-flex items-center gap-1.5">
            <span className="text-lg leading-none">＋</span>評価を始める
          </button>
        </> : undefined}
      />

      {/* 提出成功トースト — 8秒で自動フェード */}
      {submitSuccess && (
        <div className="sticky top-2 z-40 mb-4 animate-fadeIn">
          <div className="bg-green-500 dark:bg-green-600 text-white rounded-xl shadow-lg p-4 flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-2xl font-bold">
              ✓
            </div>
            <div className="flex-1">
              <p className="font-bold text-base">
                {submitSuccess.workerName} さんの評価を{submitSuccess.isEdit ? '修正' : '提出'}しました
              </p>
              <p className="text-xs text-green-50 mt-0.5 opacity-90">
                {new Date(submitSuccess.at).toLocaleString('ja-JP')} に保存完了
              </p>
            </div>
            <button
              onClick={() => setSubmitSuccess(null)}
              className="flex-shrink-0 text-white/80 hover:text-white text-sm px-2 py-1 rounded hover:bg-white/10"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <UnderlineTabs label="評価管理のタブ" active={effectiveTab} onChange={setActiveTab}
        tabs={visibleTabs.map(t => ({ key: t.id, label: t.label }))} />

      {/* ═══════════════════════════════════════ */}
      {/* Tab 1: 一覧 (List)                      */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'list' && (
        <div className="space-y-5">
          {/* ① 今やること */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {isAdmin ? (
              <TodoCard icon="pen" tone={collecting.length > 0 ? 'urgent' : 'ok'} title="評価中（入力が残っている）"
                big={collecting.length > 0 ? `${collecting.length}名` : 'ありません'}
                sub={collecting.length > 0
                  ? collecting.slice(0, 2).map(r => `${r.w.name}（まだ: ${missingNames(r.active!).join('・')}）`).join('／') + (collecting.length > 2 ? ` ほか${collecting.length - 2}名` : '')
                  : '入力を待っている評価はありません'}
                action={collecting.length > 0 ? '見る' : undefined} active={evFilter === 'collecting'}
                onClick={collecting.length > 0 ? () => toggleEvFilter('collecting') : undefined} />
            ) : (
              <TodoCard icon="pen" tone={myPending.length > 0 ? 'urgent' : 'ok'} title="あなたの入力待ち"
                big={myPending.length > 0 ? `${myPending.length}名` : 'ありません'}
                sub={myPending.length > 0 ? `${myPending.slice(0, 3).map(r => r.w.name).join('・')}。行を押して「評価を入力する」` : 'あなたが入力する評価はありません'}
                action={myPending.length > 0 ? '見る' : undefined} active={evFilter === 'mine'}
                onClick={myPending.length > 0 ? () => toggleEvFilter('mine') : undefined} />
            )}
            <TodoCard icon="check" tone={reviewing.length > 0 ? 'info' : 'ok'} title="承認待ち"
              big={reviewing.length > 0 ? `${reviewing.length}名` : 'ありません'}
              sub={reviewing.length > 0 ? `${reviewing.slice(0, 3).map(r => r.w.name).join('・')}。入力がそろいました。承認すると時給が決まります` : '承認を待っている評価はありません'}
              action={reviewing.length > 0 ? '見る' : undefined} active={evFilter === 'reviewing'}
              onClick={reviewing.length > 0 ? () => toggleEvFilter('reviewing') : undefined} />
            <TodoCard icon="clock" tone={soonRows.some(r => r.isOverdue) ? 'warn' : soonRows.length > 0 ? 'info' : 'ok'} title="もうすぐ評価日（60日以内）"
              big={soonRows.length > 0 ? `${soonRows.length}名` : 'ありません'}
              sub={soonRows.length > 0
                ? soonRows.slice(0, 3).map(r => `${r.w.name} ${r.nextDate}${r.isOverdue ? '（過ぎています）' : ''}`).join('・')
                : (() => { const next = evalRows.find(r => r.state !== 'collecting' && r.state !== 'reviewing' && r.nextDate !== '--'); return next ? `次は ${next.nextDate} の ${next.w.name}。近づくとここに出ます` : '近い評価日はありません' })()}
              action={soonRows.length > 0 ? '見る' : undefined} active={evFilter === 'soon'}
              onClick={soonRows.length > 0 ? () => toggleEvFilter('soon') : undefined} />
          </section>

          {/* ② 一覧 */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">ベトナム人スタッフ（{workers.length}名）</h2>
              <Segment value={(['all', 'collecting', 'reviewing', 'approved'] as const).includes(evFilter as 'all') ? evFilter as 'all' | 'collecting' | 'reviewing' | 'approved' : 'all'}
                onChange={v => setEvFilter(v)} items={[
                  ['all', `すべて ${evalRows.length}`], ['collecting', `評価中 ${collecting.length}`],
                  ['reviewing', `承認待ち ${reviewing.length}`], ['approved', `承認済み ${evalRows.filter(r => r.state === 'approved').length}`],
                ]} />
              {(evFilter === 'soon' || evFilter === 'mine') && (
                <button onClick={() => setEvFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[0.8125rem] font-bold">
                  {evFilter === 'soon' ? 'もうすぐ評価日の人' : 'あなたの入力待ち'}だけ表示中 ×
                </button>
              )}
              <SearchBox value={evQuery} onChange={setEvQuery} placeholder="名前で探す" />
            </div>
            <div className={`hidden lg:grid ${EV_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
              <span>名前</span><span>在留資格</span><span>勤続</span><span>今回の評価</span><span>ランク</span><span>次の評価日</span>
            </div>
            {workers.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">外国人スタッフが登録されていません</div>
            ) : shownRows.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">当てはまる人はいません</div>
            ) : shownRows.map(r => {
              const yrs = r.w.hireDate ? yearsFromDate(r.w.hireDate) : 0
              const st = STATE_CHIP[r.state]
              return (
                <div key={r.w.id} role="button" tabIndex={0}
                  onClick={() => setEvOpenId(r.w.id)}
                  onKeyDown={e => { if (e.key === 'Enter') setEvOpenId(r.w.id) }}
                  className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 ${EV_COLS} gap-x-3 gap-y-1.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums`}>
                  <span className="col-span-2 lg:col-span-1 flex items-center gap-2.5 min-w-0">
                    <WorkerAvatar name={r.w.name} src={photos[String(r.w.id)]} size={36} />
                    <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{r.w.name}</span>
                    {r.youAreEvaluator && r.state === 'collecting' && (r.youSubmitted ? <Chip tone="green">入力済み</Chip> : <Chip tone="amber">あなたの入力待ち</Chip>)}
                  </span>
                  <span><Chip tone="gray">{VISA_LABELS[r.w.visaType] || r.w.visaType}</Chip></span>
                  <span className="text-sm">{yrs > 0 ? `${yrs}年` : '—'}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    {r.state === 'none' ? <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{r.isOverdue ? '' : '次の評価日まで'}</span> : <Chip tone={st.tone}>{st.label}</Chip>}
                    {r.state === 'collecting' && r.active && progressDots(r.active)}
                  </span>
                  <span className={`text-lg font-bold ${r.latest?.rank ? rankColor(r.latest.rank) : 'text-gray-300 dark:text-gray-600'}`}>{r.latest?.rank || '—'}</span>
                  <span className="text-sm">
                    <span className={r.isOverdue ? 'text-red-700 dark:text-red-400 font-bold' : ''}>{r.nextDate}</span>
                    {r.isOverdue && <span className="ml-1"><Chip tone="red">過ぎています</Chip></span>}
                  </span>
                </div>
              )
            })}
          </section>

          {/* 一人の評価（右から開く） */}
          {openRow && (() => {
            const r = openRow
            const s = r.session
            const yrs = r.w.hireDate ? yearsFromDate(r.w.hireDate) : 0
            return (
              <SidePanel label={`${r.w.name} の評価`} onClose={() => setEvOpenId(null)}>
                <div className="p-6 space-y-5">
                  <div className="flex items-center gap-3">
                    <WorkerAvatar name={r.w.name} src={photos[String(r.w.id)]} size={52} />
                    <div className="flex-1 min-w-0">
                      <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white truncate">{r.w.name}</h2>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                        <Chip tone="gray">{VISA_LABELS[r.w.visaType] || r.w.visaType}</Chip>
                        {yrs > 0 && <span>勤続{yrs}年</span>}
                        {s && <span>／ 評価日 {s.evaluationDate}</span>}
                      </div>
                    </div>
                    <CloseButton onClick={() => setEvOpenId(null)} />
                  </div>

                  {!s ? (
                    <div className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-4 space-y-3">
                      <div className="text-sm">まだシステムで評価していません。次の評価日は <b className="tabular-nums">{r.nextDate}</b> です。</div>
                      {isAdmin && (
                        <button onClick={() => openCreate(r.w.id)} className="h-10 px-4 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light">この人の評価を始める</button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={STATE_CHIP[r.state].tone}>{STATE_CHIP[r.state].label}</Chip>
                        {r.state === 'collecting' && seesAllReviews && (
                          <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                            {s.evaluatorIds.length}人中{s.reviews.filter(rv => s.evaluatorIds.includes(rv.evaluatorId)).length}人が入力済み（始めてから{daysSince(s.createdAt)}日）
                          </span>
                        )}
                        {r.state === 'approved' && s.rank && (
                          <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">ランク <b className={`text-base ${rankColor(s.rank)}`}>{s.rank}</b>{s.raiseAmount != null && <>（昇給 {fmtYen(s.raiseAmount)}/時）</>}</span>
                        )}
                      </div>

                      <section>
                        <h3 className="text-base font-bold text-gray-900 dark:text-white mb-1">評価する人</h3>
                        {s.evaluatorIds.map(id => {
                          const rv = s.reviews.find(x => x.evaluatorId === id)
                          const days = daysSince(s.createdAt)
                          return (
                            <div key={id} className="flex items-center gap-2 py-2 border-t border-hibi-line dark:border-gray-700 text-sm">
                              <span className="flex-1 font-bold">{evaluatorNameLookup(id, apiEvaluators, workers)}{authUser?.workerId === id && <span className="ml-1.5 text-xs font-normal text-hibi-sub">（あなた）</span>}</span>
                              {rv ? <Chip tone="green">入力済み {fmtDateShort(rv.submittedAt)}</Chip>
                                : !seesAllReviews && authUser?.workerId !== id ? <span className="text-xs text-hibi-sub dark:text-gray-400">—</span>
                                : s.status === 'collecting' ? <Chip tone={days >= 7 ? 'red' : 'amber'}>まだ（{days}日）</Chip>
                                : <Chip tone="gray">入力なし</Chip>}
                            </div>
                          )
                        })}
                      </section>

                      {s.metrics && (
                        <section>
                          <h3 className="text-base font-bold text-gray-900 dark:text-white mb-2">出勤の指標（この1年）</h3>
                          <div className="grid grid-cols-3 gap-2.5">
                            {[
                              ['出勤率', `${(s.metrics.attendanceRate ?? 0).toFixed(1)}%`],
                              ['残業の平均', `${(s.metrics.overtimeAvg ?? 0).toFixed(1)}時間/月`],
                              ['欠勤', s.metrics.restDays != null ? `${s.metrics.restDays}日` : '—'],
                            ].map(([l, v]) => (
                              <div key={l} className="rounded-xl border border-hibi-line dark:border-gray-700 px-3.5 py-2.5">
                                <div className="text-xs text-hibi-sub dark:text-gray-400">{l}</div>
                                <div className="text-lg font-bold tabular-nums">{v}</div>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}

                      <div className="flex flex-wrap gap-2">
                        {s.status === 'collecting' && r.youAreEvaluator && (
                          <button onClick={() => goReview(r)} className="flex-1 h-11 px-4 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light">
                            {r.youSubmitted ? '自分の評価を直す' : '自分の評価を入力する'}
                          </button>
                        )}
                        {s.status === 'reviewing' && isAdmin && (
                          <button onClick={() => goApprove(s)} className="flex-1 h-11 px-4 rounded-[10px] bg-green-700 text-white text-sm font-bold hover:bg-green-800">承認へ進む</button>
                        )}
                        {isAdmin && (
                          <button onClick={() => { setEvOpenId(null); setDetailSessionId(s.id) }}
                            className="h-11 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                            くわしい内容（点数・コメント）
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </SidePanel>
            )
          })()}

          {/* Create Session Modal */}
          {showCreateModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-xl max-w-lg w-full mx-4 p-6">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">評価セッション作成</h2>

                {/* Worker selector */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    対象スタッフ
                  </label>
                  <select
                    value={createWorkerId ?? ''}
                    aria-invalid={!!createWorkerError}
                    onChange={e => { setCreateWorkerId(e.target.value ? Number(e.target.value) : null); setCreateWorkerError(null) }}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                  >
                    <option value="">選択してください</option>
                    {workers.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({VISA_LABELS[w.visaType] || w.visaType})
                      </option>
                    ))}
                  </select>
                  <FieldError>{createWorkerError}</FieldError>
                </div>

                {/* Evaluator checkboxes */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    評価者を選択
                  </label>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {allPossibleEvaluators.map(w => (
                      <label key={w.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createEvaluatorIds.includes(w.id)}
                          onChange={e => {
                            setCreateEvaluatorError(null)
                            if (e.target.checked) {
                              setCreateEvaluatorIds(prev => [...prev, w.id])
                            } else {
                              setCreateEvaluatorIds(prev => prev.filter(id => id !== w.id))
                            }
                          }}
                          className="rounded border-gray-300 dark:border-gray-600"
                        />
                        {w.name}
                        <span className="text-xs text-gray-400">
                          ({w.jobType})
                        </span>
                      </label>
                    ))}
                  </div>
                  <FieldError>{createEvaluatorError}</FieldError>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    選択済み: {createEvaluatorIds.length}名
                  </p>
                </div>

                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => {
                      setShowCreateModal(false)
                      setCreateWorkerId(null)
                      setCreateEvaluatorIds([])
                      setCreateWorkerError(null)
                      setCreateEvaluatorError(null)
                    }}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleCreateSession}
                    disabled={!createWorkerId || saving}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
                  >
                    {saving ? '作成中...' : '作成する'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 2: 評価入力 (My Review)              */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'review' && (
        <div className="space-y-6">
          {/* Worker selector */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              対象スタッフ
            </label>
            <select
              value={selectedWorkerId ?? ''}
              onChange={e => setSelectedWorkerId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
            >
              <option value="">選択してください</option>
              {reviewableWorkers.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name} ({VISA_LABELS[w.visaType] || w.visaType})
                </option>
              ))}
            </select>
            {reviewableWorkers.length === 0 && (
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                あなたが評価者として割り当てられたセッションがありません
              </p>
            )}
          </div>

          {selectedWorkerId && reviewSession && (
            <>
              {/* Worker info */}
              {(() => {
                const sw = workers.find(w => w.id === selectedWorkerId)
                if (!sw) return null
                const years = sw.hireDate ? yearsFromDate(sw.hireDate) : 1
                return (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スタッフ情報</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">名前</span>
                        <span className="font-medium text-gray-900 dark:text-white inline-flex items-center gap-2">
                          <WorkerAvatar name={sw.name} src={photos[String(sw.id)]} size={40} />{sw.name}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">在留資格</span>
                        <span className="text-gray-900 dark:text-white">{VISA_LABELS[sw.visaType] || sw.visaType}</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">入社日</span>
                        <span className="text-gray-900 dark:text-white">{sw.hireDate || '--'}</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">勤続年数</span>
                        <span className="text-gray-900 dark:text-white">{years}年</span>
                      </div>
                      {/* 時給は評価管理画面では非表示（運用方針） */}
                    </div>
                  </div>
                )
              })()}

              {/* Session status */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-gray-500 dark:text-gray-400">セッション状況: </span>
                    {(() => {
                      const st = sessionStatusLabel(
                        reviewSession.status,
                        reviewSession.reviews || [],
                        reviewSession.evaluatorIds || [],
                      )
                      return (
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>
                          {st.text}
                        </span>
                      )
                    })()}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    評価者: {reviewSession.evaluatorIds.length}名
                  </div>
                </div>
              </div>

              {/* If not submitted or editing: show ABC input form */}
              {(!hasSubmitted || isEditing) && (
                <>
                  {/* Attendance metrics */}
                  {reviewSession.metrics && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                      <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">出勤実績（過去1年）</h3>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div>
                          <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率</span>
                          <span className="font-medium text-gray-900 dark:text-white">{reviewSession.metrics.attendanceRate.toFixed(1)}%</span>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                          <span className="text-gray-900 dark:text-white">{reviewSession.metrics.overtimeAvg.toFixed(1)}h/月</span>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400 block text-xs">有給取得</span>
                          <span className="text-gray-900 dark:text-white">{reviewSession.metrics.plUsage}日</span>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率ボーナス</span>
                          <span className="font-bold text-blue-600 dark:text-blue-400">+{reviewSession.metrics.attendanceBonus}点</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ABC sections — generated from EVALUATION_CATEGORIES
                     2026-05-12 スコープ分担:
                       - 靖仁さん (isAdminOnly=true): 生活態度のみ
                       - その他評価者: 日本語/勤務態度/職業能力（生活態度は非表示） */}
                  <div className="space-y-4">
                    {EVALUATION_CATEGORIES.filter(cat => isAdminOnly ? cat.key === 'living' : cat.key !== 'living').map(cat => {
                      const bgColor = cat.color === 'blue' ? 'bg-blue-500' : cat.color === 'green' ? 'bg-green-500' : cat.color === 'teal' ? 'bg-teal-500' : 'bg-orange-500'
                      const catScores = myReview[cat.key]
                      return (
                        <div key={cat.key} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                          <div className={`${bgColor} px-4 py-2`}>
                            <h3 className="text-white font-bold text-sm">
                              {cat.icon} {cat.label} (重み {cat.weightLabel}{cat.key === 'attitude' ? ' — 最重要' : ''})
                            </h3>
                          </div>
                          <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-700">
                            {cat.criteria.map(c => (
                              <ABCRadio
                                key={c.key}
                                label={c.label}
                                value={(catScores as Record<string, ABCGrade>)[c.key]}
                                onChange={v => setMyReview(prev => ({
                                  ...prev,
                                  [cat.key]: { ...prev[cat.key], [c.key]: v }
                                }))}
                                descA={c.A}
                                descB={c.B}
                                descC={c.C}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Comment */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      コメント
                    </label>
                    <textarea
                      value={myComment}
                      onChange={e => setMyComment(e.target.value)}
                      rows={3}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                      placeholder="評価に関するコメントを入力..."
                    />
                  </div>

                  {/* Score preview — 担当カテゴリのみ表示 */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                      スコアプレビュー
                      <span className="ml-2 text-2xs font-normal text-gray-500">
                        （あなたの担当カテゴリの合計のみ表示）
                      </span>
                    </h3>
                    <div className="space-y-1 text-sm">
                      {!isAdminOnly && (
                        <>
                          <div className="flex justify-between text-gray-600 dark:text-gray-300">
                            <span>日本語: {reviewCalc.japanese}点 x1.0</span>
                            <span className="font-medium">= {reviewCalc.japaneseW.toFixed(1)}</span>
                          </div>
                          <div className="flex justify-between text-gray-600 dark:text-gray-300">
                            <span>勤務態度: {reviewCalc.attitude}点 x1.5</span>
                            <span className="font-medium">= {reviewCalc.attitudeW.toFixed(1)}</span>
                          </div>
                          <div className="flex justify-between text-gray-600 dark:text-gray-300">
                            <span>職業能力: {reviewCalc.skill}点 x1.0</span>
                            <span className="font-medium">= {reviewCalc.skillW.toFixed(1)}</span>
                          </div>
                        </>
                      )}
                      {isAdminOnly && (
                        <div className="flex justify-between text-gray-600 dark:text-gray-300">
                          <span>生活態度: {reviewCalc.living}点 x1.0</span>
                          <span className="font-medium">= {reviewCalc.livingW.toFixed(1)}</span>
                        </div>
                      )}
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                        <div className="flex justify-between text-gray-900 dark:text-white font-bold">
                          <span>担当部分合計: {(isAdminOnly ? reviewCalc.livingW : reviewCalc.japaneseW + reviewCalc.attitudeW + reviewCalc.skillW).toFixed(1)}点</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Submit button */}
                  <div className="flex gap-3 justify-end">
                    {isEditing && (
                      <button
                        onClick={syncMyReviewFromSaved}
                        className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        キャンセル
                      </button>
                    )}
                    <button
                      onClick={handleSubmitReview}
                      disabled={saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
                    >
                      {saving ? '送信中...' : isEditing ? '再提出する' : '提出する'}
                    </button>
                  </div>
                </>
              )}

              {/* If submitted and not editing: show read-only view */}
              {hasSubmitted && !isEditing && (
                <div className="space-y-4">
                  <div className="bg-green-50 dark:bg-green-900/30 border-2 border-green-300 dark:border-green-700 rounded-xl p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0 w-12 h-12 rounded-full bg-green-500 dark:bg-green-600 flex items-center justify-center text-white text-2xl font-bold shadow">
                          ✓
                        </div>
                        <div>
                          <p className="text-base font-bold text-green-800 dark:text-green-200">
                            {reviewSession.workerName} さんの評価を提出済みです
                          </p>
                          {(() => {
                            const my = reviewSession.reviews.find(r => r.evaluatorId === authUser?.workerId)
                            if (!my?.submittedAt) return null
                            return (
                              <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                                {new Date(my.submittedAt).toLocaleString('ja-JP')} に保存完了
                              </p>
                            )
                          })()}
                        </div>
                      </div>
                      <button
                        onClick={() => setIsEditing(true)}
                        className="px-4 py-2 text-sm font-medium rounded-lg border-2 border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50 transition-colors"
                      >
                        修正する
                      </button>
                    </div>
                  </div>

                  {/* My submitted review (read-only) */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">自分の評価</h3>
                    <div className="space-y-2">
                      {/* 自分の担当カテゴリの項目のみ表示 */}
                      {EVAL_ITEMS.filter(item => authUser && isCategoryInScope(authUser.workerId, item.category)).map(item => (
                        <div key={`${item.category}_${item.key}`} className="flex items-center justify-between py-1">
                          <span className="text-sm text-gray-600 dark:text-gray-300">{item.label}</span>
                          <GradeBadge grade={getScoreValue(myReview, item.category, item.key)} />
                        </div>
                      ))}
                    </div>
                    {myComment && (
                      <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                        <p className="text-xs text-gray-500 dark:text-gray-400">コメント:</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{myComment}</p>
                      </div>
                    )}
                  </div>

                  {/* Other evaluators' reviews (only visible after submitting own) */}
                  {reviewSession.reviews.filter(r => r.evaluatorId !== authUser?.workerId).length > 0 && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                      <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">他の評価者の結果</h3>
                      <div className="space-y-4">
                        {reviewSession.reviews
                          .filter(r => r.evaluatorId !== authUser?.workerId)
                          .map((review, idx) => (
                            <div key={review.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                              <p className={`text-sm font-medium mb-2 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                                {review.evaluatorName}
                              </p>
                              <div className="space-y-1">
                                {/* 当該評価者の担当カテゴリのみ表示 */}
                                {EVAL_ITEMS.filter(item => isCategoryInScope(review.evaluatorId, item.category)).map(item => (
                                  <div key={`${review.evaluatorId}_${item.category}_${item.key}`} className="flex items-center justify-between py-0.5">
                                    <span className="text-xs text-gray-600 dark:text-gray-300">{item.label}</span>
                                    <GradeBadge grade={getScoreValue(review.scores, item.category, item.key)} />
                                  </div>
                                ))}
                              </div>
                              {review.comment && (
                                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-gray-600 pt-2">
                                  {review.comment}
                                </p>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Pending evaluators */}
                  {(() => {
                    const submittedIds = (reviewSession.reviews || []).map(r => r.evaluatorId)
                    const pending = reviewSession.evaluatorIds.filter(id => !submittedIds.includes(id))
                    if (pending.length === 0) return null
                    return (
                      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                        <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">未提出の評価者</h3>
                        <div className="flex flex-wrap gap-2">
                          {pending.map(id => {
                            const w = workers.find(w2 => w2.id === id)
                            return (
                              <span key={id} className="inline-block px-2 py-1 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                {w?.name || `ID:${id}`}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}
            </>
          )}

          {!selectedWorkerId && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              対象スタッフを選択してください
            </div>
          )}

          {selectedWorkerId && !reviewSession && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              このスタッフのアクティブな評価セッションがありません
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 3: 承認 (Approval) - admin only      */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'approve' && isAdmin && (
        <div className="space-y-6">
          {/* Sessions in reviewing status */}
          {!approveSessionId && (
            <>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">最終確認待ち</h2>
              {evaluations.filter(e => e.status === 'reviewing').length === 0 ? (
                <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                  全員提出済みの評価セッションがありません
                </div>
              ) : (
                <div className="space-y-3">
                  {evaluations
                    .filter(e => e.status === 'reviewing')
                    .map(session => (
                      <div key={session.id} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={40} />
                          <div>
                          <p className="font-medium text-gray-900 dark:text-white">{session.workerName}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            評価日: {session.evaluationDate} / {session.reviews.length}名が提出
                          </p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setApproveSessionId(session.id)
                            setFinalScores(computePrefillScores(session))
                            setFinalComment('')
                          }}
                          className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
                          title="重み付き加重平均でプリフィル（A=3 B=2 C=1 の数値化→平均→ABC変換）"
                        >
                          確認・承認
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}

          {/* Approval detail view */}
          {approveSessionId && (() => {
            const session = evaluations.find(e => e.id === approveSessionId)
            if (!session) return null
            const worker = workers.find(w => w.id === session.workerId)
            // 2026-09-14: サーバの確定値と同じ年で引く（セッション保存値）
            const years = session.yearsFromHire || (worker?.hireDate ? yearsFromDate(worker.hireDate) : 1)

            // Calculate final score preview
            const finalCalc = calculateManualScore(finalScores)
            const bonus = session.metrics?.attendanceBonus ?? 0
            const totalScore = finalCalc.total + bonus
            const rank = calculateRank(totalScore)
            // 法令フロア（最賃×1.0 / 特定技能は×1.1）を適用したプレビュー。
            // 確定値はサーバ側が同じロジックで再計算する
            const floorPreview = applyLegalWageFloor({
              baseRaise: getRaiseAmount(rank, years, worker?.hourlyRate),
              currentHourlyRate: worker?.hourlyRate,
              visa: worker?.visaType,
              minWage: minWageAt(todayJstIso()),
            })
            const raiseAmount = floorPreview.raiseAmount

            return (
              <div className="space-y-6">
                {/* Back button */}
                <button
                  onClick={() => setApproveSessionId(null)}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  &larr; 一覧に戻る
                </button>

                {/* Worker info */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-3">
                    <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={48} />
                    {session.workerName} の評価
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">在留資格</span>
                      <span className="text-gray-900 dark:text-white">{VISA_LABELS[worker?.visaType || ''] || worker?.visaType}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">入社日</span>
                      <span className="text-gray-900 dark:text-white">{worker?.hireDate || '--'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">勤続年数</span>
                      <span className="text-gray-900 dark:text-white">{years}年</span>
                    </div>
                    {/* 時給は評価管理画面では非表示（運用方針） */}
                  </div>
                </div>

                {/* Comparison table */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300">評価者比較</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full">
                      <thead>
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 w-32">
                            項目
                          </th>
                          {session.reviews.map((review, idx) => {
                            const w = session.evaluatorWeights?.[review.evaluatorId]
                            return (
                              <th
                                key={review.evaluatorId}
                                className={`px-3 py-3 text-center text-xs font-medium text-white border-b border-gray-200 dark:border-gray-700 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].header}`}
                              >
                                <div>{review.evaluatorName}</div>
                                {w && (
                                  <div className="mt-1 text-3xs font-normal opacity-90">
                                    {w.isApprover ? (
                                      <span title={`事業責任者の固定ウェイト (${w.weight.toFixed(2)})`}>w={w.weight.toFixed(2)} ★</span>
                                    ) : (
                                      <span title={`過去365日 共働 ${w.yearDays}日 (うち直近90日 ${w.recentDays}日)`}>
                                        w={w.weight.toFixed(2)}
                                        <span className="block opacity-80">年共働 {w.yearPct}% ({w.yearDays}日)</span>
                                      </span>
                                    )}
                                  </div>
                                )}
                              </th>
                            )
                          })}
                          <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1">
                          </th>
                          <th className="px-3 py-3 text-center text-xs font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 min-w-[140px]">
                            最終評価
                            {session.evaluatorWeights && (
                              <div className="text-3xs font-normal opacity-70 mt-0.5">（重み付き加重平均）</div>
                            )}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {EVAL_ITEMS.map((item, rowIdx) => {
                          // 担当外評価者を除外して「一致 / 分かれ」を判定（2026-05-12 スコープ反映）
                          const inScopeGrades = session.reviews
                            .filter(r => isCategoryInScope(r.evaluatorId, item.category))
                            .map(r => getScoreValue(r.scores, item.category, item.key))
                          const allSame = inScopeGrades.length > 0 && inScopeGrades.every(g => g === inScopeGrades[0])
                          const rowBg = rowIdx % 2 === 0 ? '' : 'bg-gray-50/50 dark:bg-gray-750/50'
                          return (
                            <tr key={`${item.category}_${item.key}`} className={rowBg}>
                              <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700">
                                <div className="flex items-center gap-1.5">
                                  <span className={`inline-block w-2 h-2 rounded-full ${allSame ? 'bg-green-400' : 'bg-yellow-400'}`} />
                                  {item.label}
                                </div>
                              </td>
                              {session.reviews.map(review => {
                                const inScope = isCategoryInScope(review.evaluatorId, item.category)
                                return (
                                  <td key={review.evaluatorId} className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700">
                                    {inScope ? (
                                      <GradeBadge grade={getScoreValue(review.scores, item.category, item.key)} />
                                    ) : (
                                      <span className="text-gray-300 dark:text-gray-600 text-lg" title="担当外（評価対象外）">─</span>
                                    )}
                                  </td>
                                )
                              })}
                              <td className="border-b border-gray-100 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></td>
                              <td className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700 bg-indigo-50/50 dark:bg-indigo-900/20">
                                <div className="flex gap-1 justify-center">
                                  {(['A', 'B', 'C'] as ABCGrade[]).map(g => {
                                    const current = getScoreValue(finalScores, item.category, item.key)
                                    const active = current === g
                                    let cls = 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                                    if (active && g === 'A') cls = 'bg-green-500 text-white'
                                    if (active && g === 'B') cls = 'bg-yellow-500 text-white'
                                    if (active && g === 'C') cls = 'bg-red-400 text-white'
                                    return (
                                      <button
                                        key={g}
                                        onClick={() => setFinalScores(prev => setScoreValue(prev, item.category, item.key, g))}
                                        className={`w-8 h-8 rounded-lg font-bold text-xs transition-all ${cls} hover:opacity-80 cursor-pointer`}
                                      >
                                        {g}
                                      </button>
                                    )
                                  })}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {/* Legend */}
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-green-400" /> 全員一致
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" /> 意見分かれ
                    </span>
                  </div>
                </div>

                {/* Evaluator comments */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">評価者コメント</h3>
                  <div className="space-y-3">
                    {session.reviews.map((review, idx) => (
                      <div key={review.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                        <p className={`text-xs font-medium ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                          {review.evaluatorName}
                        </p>
                        <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                          {review.comment || '(コメントなし)'}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Final comment */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    最終コメント（政仁さん）
                  </label>
                  <textarea
                    value={finalComment}
                    onChange={e => setFinalComment(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                    placeholder="最終評価コメントを入力..."
                  />
                </div>

                {/* Score preview */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">最終スコアプレビュー</h3>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between text-gray-600 dark:text-gray-300">
                      <span>日本語: {finalCalc.japanese}点 x1.0</span>
                      <span className="font-medium">= {finalCalc.japaneseW.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600 dark:text-gray-300">
                      <span>勤務態度: {finalCalc.attitude}点 x1.5</span>
                      <span className="font-medium">= {finalCalc.attitudeW.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600 dark:text-gray-300">
                      <span>職業能力: {finalCalc.skill}点 x1.0</span>
                      <span className="font-medium">= {finalCalc.skillW.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600 dark:text-gray-300">
                      <span>生活態度: {finalCalc.living}点 x1.0</span>
                      <span className="font-medium">= {finalCalc.livingW.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-blue-600 dark:text-blue-400">
                      <span>出勤率ボーナス</span>
                      <span className="font-medium">+{bonus}点</span>
                    </div>
                    <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                      <div className="flex justify-between text-gray-900 dark:text-white font-bold">
                        <span>合計: {totalScore.toFixed(1)}点</span>
                        <span className={`text-lg ${rankColor(rank)}`}>ランク: {rank}</span>
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-gray-500 dark:text-gray-400 text-xs">
                          {years}年目テーブル適用
                        </span>
                        <span className="font-bold text-green-600 dark:text-green-400">
                          推奨昇給: +{raiseAmount}円/h
                        </span>
                      </div>
                      {floorPreview.floored && (
                        <div className="mt-1.5 text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg px-2.5 py-1.5">
                          ⚖️ 法令下限により調整: テーブル値 +{floorPreview.baseRaise}円 では下限時給
                          {floorPreview.legalMinRate}円（最低賃金{worker?.visaType?.startsWith('tokutei') ? '×1.1（建設特定技能の認定要件）' : ''}）を
                          下回るため、+{raiseAmount}円 に底上げされます
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Approve button */}
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={() => setApproveSessionId(null)}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    戻る
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={saving}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
                  >
                    {saving ? '承認中...' : '承認する'}
                  </button>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 4: 進捗監視 (Monitor) — admin only   */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'monitor' && isAdmin && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">進行中の評価セッション</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              ※ 収集中のセッションを横並びで確認できます
            </p>
          </div>
          {(() => {
            const inProgress = evaluations
              .filter(e => e.status !== 'approved')
              .sort((a, b) => {
                // reviewing を先頭に、次に古い createdAt 順（停滞しているもの優先）
                if (a.status !== b.status) return a.status === 'reviewing' ? -1 : 1
                return (a.createdAt || '').localeCompare(b.createdAt || '')
              })
            if (inProgress.length === 0) {
              return (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400 dark:text-gray-500">
                  進行中の評価セッションはありません
                </div>
              )
            }
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {inProgress.map(s => {
                  const total = s.evaluatorIds.length
                  const submitted = new Set(s.reviews.map(r => r.evaluatorId)).size
                  const ageDays = daysSince(s.createdAt)
                  const isStale = ageDays >= 7 && s.status === 'collecting'
                  const isReviewing = s.status === 'reviewing'
                  return (
                    <div
                      key={s.id}
                      className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4 border-l-4 ${
                        isReviewing
                          ? 'border-amber-400'
                          : isStale
                          ? 'border-orange-400'
                          : 'border-blue-400'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2 flex-wrap gap-2">
                        <div className="flex items-center gap-3">
                          <WorkerAvatar name={s.workerName} src={photos[String(s.workerId)]} size={40} />
                          <div>
                          <h3 className="font-bold text-gray-900 dark:text-white">{s.workerName}</h3>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            評価日: {s.evaluationDate}
                            <span className="ml-2">
                              開始: {s.createdAt ? new Date(s.createdAt).toLocaleDateString('ja-JP') : '--'}
                              {ageDays > 0 && (
                                <span className={isStale ? 'text-orange-600 dark:text-orange-400 font-medium ml-1' : 'ml-1'}>
                                  ({ageDays}日経過)
                                </span>
                              )}
                            </span>
                          </p>
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            isReviewing
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                          }`}
                        >
                          {isReviewing ? '⚖️ 最終確認待ち' : `📝 収集中 ${submitted}/${total}`}
                        </span>
                      </div>
                      <EvaluatorBadgeList session={s} />
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          onClick={() => setDetailSessionId(s.id)}
                          className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                          詳細
                        </button>
                        {isReviewing && (
                          <button
                            onClick={() => {
                              setApproveSessionId(s.id)
                              setFinalScores(computePrefillScores(s))
                              setFinalComment('')
                              setActiveTab('approve')
                            }}
                            className="px-3 py-1 text-xs font-medium rounded-lg bg-green-500 text-white hover:bg-green-600"
                          >
                            承認へ
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 5: 履歴 (History) — admin only       */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'history' && isAdmin && (
        <div className="space-y-4">
          {(() => {
            const approved = evaluations.filter(e => e.status === 'approved')
            const years = Array.from(new Set(approved.map(e => e.evaluationDate.slice(0, 4)))).sort().reverse()
            const filtered = historyYear === 'all'
              ? approved
              : approved.filter(e => e.evaluationDate.startsWith(historyYear))
            const sorted = filtered.sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))
            return (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="text-lg font-bold text-gray-900 dark:text-white">承認済み評価履歴</h2>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 dark:text-gray-400">年で絞り込み:</label>
                    <select
                      value={historyYear}
                      onChange={e => setHistoryYear(e.target.value)}
                      className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-900 dark:text-white"
                    >
                      <option value="all">すべて</option>
                      {years.map(y => (
                        <option key={y} value={y}>{y}年</option>
                      ))}
                    </select>
                  </div>
                </div>

                {sorted.length === 0 ? (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400 dark:text-gray-500">
                    承認済みの評価がありません
                  </div>
                ) : (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">名前</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">評価日</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">勤続</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">合計</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ランク</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">推奨昇給</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">承認日</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                          {sorted.map(s => (
                            <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                              <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
                                <WorkerAvatar name={s.workerName} src={photos[String(s.workerId)]} size={28} className="mr-2" />{s.workerName}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">{s.evaluationDate}</td>
                              <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300 whitespace-nowrap">{s.yearsFromHire}年</td>
                              <td className="px-4 py-3 text-sm text-center text-gray-700 dark:text-gray-200 whitespace-nowrap font-medium">{s.totalScore?.toFixed(1) ?? '--'}</td>
                              <td className="px-4 py-3 text-center whitespace-nowrap">
                                {s.rank ? (
                                  <span className={`text-lg font-bold ${rankColor(s.rank)}`}>{s.rank}</span>
                                ) : '--'}
                              </td>
                              <td className="px-4 py-3 text-sm text-center whitespace-nowrap">
                                {s.raiseAmount != null && s.raiseAmount > 0 ? (
                                  <span className="text-green-600 dark:text-green-400 font-medium">+{s.raiseAmount}円</span>
                                ) : (
                                  <span className="text-gray-400">--</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                                {s.approvedAt ? new Date(s.approvedAt).toLocaleDateString('ja-JP') : '--'}
                              </td>
                              <td className="px-4 py-3 text-center whitespace-nowrap">
                                <button
                                  onClick={() => setDetailSessionId(s.id)}
                                  className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                                >
                                  詳細
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                      合計 {sorted.length} 件
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      )}

      {/* ═══════════════════════════════════════ */}
      {/* Detail Modal — どのタブからも開ける         */}
      {/* ═══════════════════════════════════════ */}
      {detailSessionId && (() => {
        const session = evaluations.find(e => e.id === detailSessionId)
        if (!session) return null
        return (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
            onClick={() => setDetailSessionId(null)}
          >
            <div
              className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-xl max-w-4xl w-full my-8 max-h-[90vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">評価セッション詳細</h2>
                <button
                  onClick={() => setDetailSessionId(null)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
                  aria-label="閉じる"
                >
                  ✕
                </button>
              </div>
              <div className="p-6">
                <SessionDetailView session={session} />
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
