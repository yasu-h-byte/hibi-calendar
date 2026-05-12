'use client'

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

// ── Helper functions ──

function gradeToScore(g: ABCGrade): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : 1
}

const WEIGHTS = { japanese: 1.0, attitude: 1.5, skill: 1.0, living: 1.0 }

function calculateManualScore(scores: EvaluationScores): {
  japanese: number
  attitude: number
  skill: number
  living: number
  japaneseW: number
  attitudeW: number
  skillW: number
  livingW: number
  total: number
} {
  const jp =
    gradeToScore(scores.japanese.understanding) +
    gradeToScore(scores.japanese.reporting) +
    gradeToScore(scores.japanese.safety)
  const att =
    gradeToScore(scores.attitude.punctuality) +
    gradeToScore(scores.attitude.safetyAwareness) +
    gradeToScore(scores.attitude.teamwork) +
    gradeToScore(scores.attitude.compliance || 'B')
  const sk =
    gradeToScore(scores.skill.level) +
    gradeToScore(scores.skill.speed) +
    gradeToScore(scores.skill.planning)
  const lv =
    gradeToScore(scores.living?.neighborCare || 'B') +
    gradeToScore(scores.living?.ruleCompliance || 'B') +
    gradeToScore(scores.living?.cleanliness || 'B')
  const jpW = jp * WEIGHTS.japanese
  const attW = att * WEIGHTS.attitude
  const skW = sk * WEIGHTS.skill
  const lvW = lv * WEIGHTS.living
  return {
    japanese: jp,
    attitude: att,
    skill: sk,
    living: lv,
    japaneseW: jpW,
    attitudeW: attW,
    skillW: skW,
    livingW: lvW,
    total: jpW + attW + skW + lvW,
  }
}

// 満点45.0（日本語9×1.0 + 勤務態度12×1.5 + 職業能力9×1.0 + 生活態度9×1.0）
// + 皆勤ボーナス最大3 → 最大48.0
function calculateRank(totalScore: number): EvaluationRank {
  if (totalScore >= 39) return 'S'    // 81%+
  if (totalScore >= 32) return 'A'    // 67%+
  if (totalScore >= 25) return 'B'    // 52%+
  if (totalScore >= 17) return 'C'    // 35%+
  return 'D'
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

// 昇給テーブル（1,300円スタート → 10年目で S:2,700 A:2,380 B:2,060 C:1,740 到達）
// D評価は現在時給の1%（法定最低限の昇給義務）
// 各ランク間の10年目差は均等（約320円）
const RAISE_TABLE: { year: number; S: number; A: number; B: number; C: number }[] = [
  { year: 1, S: 220, A: 170, B: 120, C: 80 },
  { year: 2, S: 200, A: 160, B: 110, C: 65 },
  { year: 3, S: 180, A: 140, B: 100, C: 55 },
  { year: 4, S: 170, A: 130, B: 90, C: 50 },
  { year: 5, S: 160, A: 120, B: 80, C: 50 },
  { year: 6, S: 140, A: 110, B: 75, C: 45 },
  { year: 7, S: 120, A: 90, B: 65, C: 35 },
  { year: 8, S: 110, A: 80, B: 60, C: 30 },
  { year: 9, S: 100, A: 80, B: 60, C: 30 },
]

function getRaiseAmount(rank: EvaluationRank, yearsFromHire: number, currentHourlyRate?: number): number {
  if (rank === 'D') {
    // D評価: 現在時給の1%（最低昇給義務）
    const rate = currentHourlyRate || 1300
    return Math.ceil(rate * 0.01)
  }
  const row = RAISE_TABLE.find(r => r.year === Math.min(yearsFromHire, 9)) || RAISE_TABLE[8]
  return row[rank as 'S' | 'A' | 'B' | 'C']
}

function yearsFromDate(dateStr: string): number {
  if (!dateStr) return 0
  const hire = new Date(dateStr)
  const now = new Date()
  let y = now.getFullYear() - hire.getFullYear()
  const mDiff = now.getMonth() - hire.getMonth()
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < hire.getDate())) y--
  return Math.max(1, y)
}

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
    const d = new Date(latestDate)
    d.setFullYear(d.getFullYear() + 1)
    return d.toISOString().slice(0, 10)
  }
  // 未評価: 入社日の次の記念日を表示（アラートは出さない）
  if (!hireDate) return '--'
  const hire = new Date(hireDate)
  const currentYears = yearsFromDate(hireDate)
  const nextY = Math.max(1, currentYears + 1)
  const d = new Date(hire)
  d.setFullYear(d.getFullYear() + nextY)
  return d.toISOString().slice(0, 10)
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
    if (!confirm('このセッションのウェイトを再計算しますか？\n（過去出勤データから共働日数を再集計します）')) return
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
        alert(`再計算に失敗しました: ${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`エラー: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRecalculatingWeights(false)
  }

  // ── ウェイト一括再計算（既存セッション全部） ──
  const handleRecalculateAllWeights = async () => {
    if (!confirm('全ての進行中セッション（収集中・最終確認待ち）のウェイトを再計算します。\n（承認済みは対象外）\n\n実行しますか？')) return
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
        alert(`一括再計算完了\n更新: ${d.updated}件\nスキップ: ${d.skipped}件${d.errors?.length ? `\nエラー: ${d.errors.length}件` : ''}`)
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(`再計算に失敗しました: ${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`エラー: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRecalculatingWeights(false)
  }

  // ── 出勤指標 一括再計算（既存セッション全部） ──
  const handleRecalculateAllMetrics = async () => {
    if (!confirm('全ての進行中セッションの出勤指標（出勤率・残業平均・有給取得・ボーナス）を再計算します。\n（承認済みは対象外）\n\n出勤率の100%超え等を直すために、新ロジックで再算出します。\n実行しますか？')) return
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
        alert(`✅ 出勤指標 一括再計算完了\n更新: ${d.updated}件\nスキップ: ${d.skipped}件${d.errors?.length ? `\nエラー: ${d.errors.length}件` : ''}`)
        await fetchData()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(`再計算に失敗しました: ${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`エラー: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRecalculatingWeights(false)
  }

  // ── 出勤指標 再計算（個別セッション） ──
  const handleRecalculateMetrics = async (evaluationId: string) => {
    if (!confirm('このセッションの出勤指標を再計算しますか？\n（過去出勤データから出勤率・残業平均等を再集計します）')) return
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
        alert(`再計算に失敗しました: ${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`エラー: ${e instanceof Error ? e.message : String(e)}`)
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
    setAuthUser(user)
    try {
      const [wRes, eRes] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/evaluation', { headers: { 'x-admin-password': password } }),
      ])
      if (wRes.ok) {
        const d = await wRes.json()
        const all: Worker[] = d.workers || []
        setWorkers(all.filter(w => w.visaType && w.visaType !== 'none' && !w.retired))
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
  useEffect(() => {
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
        // 確認ダイアログ — 提出完了が確実に伝わるように
        alert(`✅ ${targetName} さんの評価を${wasEditing ? '修正' : '提出'}しました\n\n他の評価対象者がいる場合は、上の「対象スタッフ」から続けて評価してください。`)
      } else {
        const err = await res.json().catch(() => ({}))
        alert(`❌ 提出に失敗しました\n\n${err.error || res.statusText}\n\nもう一度お試しください。`)
      }
    } catch (e) {
      alert(`❌ 通信エラー\n\n${e instanceof Error ? e.message : String(e)}\n\n通信状態を確認してもう一度お試しください。`)
    }
    setSaving(false)
  }

  // ── Create evaluation session ──
  const handleCreateSession = async () => {
    if (!createWorkerId || createEvaluatorIds.length === 0) {
      alert('対象スタッフと評価者を選択してください')
      return
    }
    setSaving(true)
    const { password } = getAuth()
    try {
      const worker = workers.find(w => w.id === createWorkerId)
      if (!worker) {
        alert('スタッフが見つかりません')
        setSaving(false)
        return
      }
      // 評価者が空の場合は evaluatorIds を送らず、APIのデフォルト動作（職長+政仁+靖仁）に任せる
      const requestBody: Record<string, unknown> = {
        action: 'create',
        workerId: createWorkerId,
        workerName: worker.name,
        evaluationDate: new Date().toISOString().slice(0, 10),
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
        alert(`✅ ${worker.name} さんの評価セッションを作成しました\n\n評価者 ${createEvaluatorIds.length}名に通知が送信されます。`)
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        alert(`❌ 作成に失敗しました\n\n${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`❌ エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`)
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
    const years = worker?.hireDate ? yearsFromDate(worker.hireDate) : 1
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
        setApproveSessionId(null)
        await fetchData()
        alert(`✅ ${session.workerName} さんの評価を承認しました\n\nランク: ${rank} / 推奨昇給: +${raiseAmount}円/h`)
      } else {
        const err = await res.json().catch(() => ({}))
        alert(`❌ 承認に失敗しました\n\n${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`❌ 通信エラー: ${e instanceof Error ? e.message : String(e)}`)
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
            <span className="text-[10px] text-gray-500 dark:text-gray-400 tabular-nums">
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
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {session.workerName}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                評価日: {session.evaluationDate}
                {session.approvedAt && ` / 承認日時: ${new Date(session.approvedAt).toLocaleString('ja-JP')}`}
              </p>
            </div>
            <div className="text-right">
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
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                評価者ウェイト
                <span className="ml-2 text-[11px] font-normal text-gray-500">
                  共働実績ベース（直近1年）：加重平均プリフィルで重みが効きます
                </span>
              </h4>
              {isAdmin && (
                <button
                  onClick={() => handleRecalculateWeights(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-[11px] font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  {recalculatingWeights ? '...' : '🔄 再計算'}
                </button>
              )}
            </div>
            {session.evaluatorWeights ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">評価者</th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="参考表示（ウェイトには影響しない）">直近90日<span className="text-[9px] opacity-60 ml-0.5">(参考)</span></th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="ウェイト算出の根拠">過去365日<span className="text-[9px] opacity-60 ml-0.5">(主)</span></th>
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
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                ウェイト未計算（旧形式セッション）。{isAdmin && '右上の「再計算」ボタンで算出できます。'}
              </p>
            )}
          </div>
        )}

        {/* 出席指標（詳細内訳付き） */}
        {session.metrics && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                出勤実績（過去1年）
                {session.metrics.computedAt && (
                  <span className="ml-2 text-[11px] font-normal text-gray-500">
                    （{new Date(session.metrics.computedAt).toLocaleString('ja-JP')} 計算）
                  </span>
                )}
              </h4>
              {isAdmin && session.status !== 'approved' && (
                <button
                  onClick={() => handleRecalculateMetrics(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-[11px] font-medium rounded-md border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 disabled:opacity-50"
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
                  <span className="ml-1 text-[10px] text-gray-400" title="100%キャップ前の生比率">
                    (生 {session.metrics.rawRate.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                <span className="text-gray-900 dark:text-white">{session.metrics.overtimeAvg.toFixed(1)}h/月</span>
                {session.metrics.totalOvertime != null && (
                  <span className="ml-1 text-[10px] text-gray-400">
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
                            {session.metrics.compensationDays} 日 <span className="text-[10px]">※対象外</span>
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
                <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
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
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
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
                            <div className="mt-1 text-[10px] font-normal opacity-90">
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
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                推奨昇給: +{session.raiseAmount}円/h（{session.yearsFromHire}年目テーブル）
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">評価管理</h1>

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

      {/* Tab Bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
        {visibleTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════════════ */}
      {/* Tab 1: 一覧 (List)                      */}
      {/* ═══════════════════════════════════════ */}
      {activeTab === 'list' && (
        <div className="space-y-4">
          {/* Create session button (admin only) */}
          {isAdmin && (
            <div className="flex justify-end gap-2 flex-wrap">
              <button
                onClick={handleRecalculateAllMetrics}
                disabled={recalculatingWeights}
                className="px-3 py-2 text-sm font-medium rounded-lg border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors disabled:opacity-50"
                title="進行中セッションの出勤率・残業平均・ボーナスを新ロジックで再計算"
              >
                {recalculatingWeights ? '再計算中...' : '📊 出勤指標 一括再計算'}
              </button>
              <button
                onClick={handleRecalculateAllWeights}
                disabled={recalculatingWeights}
                className="px-3 py-2 text-sm font-medium rounded-lg border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-50"
                title="進行中セッションのウェイトを過去出勤データから再計算"
              >
                {recalculatingWeights ? '再計算中...' : '🔄 ウェイト一括再計算'}
              </button>
              <button
                onClick={async () => {
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
                  setShowCreateModal(true)
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                評価セッション作成
              </button>
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">名前</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">在留資格</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">勤続</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase min-w-[260px]">提出状況</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">自分</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ランク</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">次回評価日</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {workers
                    .map(w => {
                      const wEvals = evaluations.filter(e => e.workerId === w.id)
                      const latest = wEvals.sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0]
                      const nextDate = nextEvalDate(w.hireDate || '', wEvals)
                      // アラートは「システムで評価済み＆1年経過」の場合のみ
                      const evaluated = hasBeenEvaluated(wEvals)
                      const isOverdue = evaluated && nextDate !== '--' && nextDate <= new Date().toISOString().slice(0, 10)
                      return { worker: w, latest, nextDate, isOverdue }
                    })
                    .sort((a, b) => {
                      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
                      return a.nextDate.localeCompare(b.nextDate)
                    })
                    .map(({ worker: w, latest, nextDate, isOverdue }) => {
                      const yrs = w.hireDate ? yearsFromDate(w.hireDate) : 0
                      // アクティブセッション（collecting/reviewing）優先、なければ最新の承認済み
                      const activeSession = evaluations
                        .filter(e => e.workerId === w.id && e.status !== 'approved')
                        .sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0]
                      const showSession = activeSession || latest
                      const youAreEvaluator = showSession && authUser && showSession.evaluatorIds.includes(authUser.workerId)
                      const youSubmitted = youAreEvaluator && showSession.reviews.some(r => r.evaluatorId === authUser?.workerId)
                      return (
                        <tr key={w.id} className="hover:bg-gray-50 dark:hover:bg-gray-750">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{w.name}</td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            {VISA_LABELS[w.visaType] || w.visaType}
                          </td>
                          <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            {yrs > 0 ? `${yrs}年` : '--'}
                          </td>
                          <td className="px-4 py-3">
                            {showSession ? (
                              <EvaluatorBadgeList session={showSession} compact />
                            ) : (
                              <span className="text-xs text-gray-400 dark:text-gray-500">未評価</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            {!showSession || showSession.status === 'approved' || !youAreEvaluator ? (
                              <span className="text-xs text-gray-400 dark:text-gray-500">―</span>
                            ) : youSubmitted ? (
                              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                                ✓ 提出済
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                                ⏳ 未提出
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            {latest?.rank ? (
                              <button
                                onClick={() => setDetailSessionId(latest.id)}
                                className={`font-bold hover:underline ${rankColor(latest.rank)}`}
                                title="承認時の詳細を表示"
                              >
                                {latest.rank}
                              </button>
                            ) : '--'}
                          </td>
                          <td className="px-4 py-3 text-sm whitespace-nowrap">
                            <span className={isOverdue ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-600 dark:text-gray-300'}>
                              {nextDate}
                            </span>
                            {isOverdue && (
                              <span className="ml-1 inline-block px-1.5 py-0.5 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 text-xs rounded-full font-bold">
                                期限超過
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1 flex-wrap">
                              {showSession && showSession.status !== 'approved' && youAreEvaluator && (
                                <button
                                  onClick={() => {
                                    setSelectedWorkerId(w.id)
                                    setActiveTab('review')
                                  }}
                                  className={`px-3 py-1 text-xs font-medium rounded-lg ${
                                    youSubmitted
                                      ? 'border border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30'
                                      : 'bg-blue-500 text-white hover:bg-blue-600'
                                  } transition-colors`}
                                >
                                  {youSubmitted ? '修正' : '評価入力'}
                                </button>
                              )}
                              {showSession && showSession.status === 'reviewing' && isAdmin && (
                                <button
                                  onClick={() => {
                                    setApproveSessionId(showSession.id)
                                    setFinalScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
                                    setFinalComment('')
                                    setActiveTab('approve')
                                  }}
                                  className="px-3 py-1 text-xs font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
                                >
                                  承認へ
                                </button>
                              )}
                              {showSession && isAdmin && (
                                <button
                                  onClick={() => setDetailSessionId(showSession.id)}
                                  className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  詳細
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  {workers.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                        外国人スタッフが登録されていません
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* 凡例 */}
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium border bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-300 dark:border-green-700">✓提出済</span>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium border bg-gray-50 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400 border-dashed border-gray-300 dark:border-gray-600">○未提出</span>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium border bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-300 dark:border-orange-800">○未提出(7日+)</span>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium border ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-900 bg-gray-50 dark:bg-gray-700/50">👤あなた</span>
              <span className="text-[10px] text-gray-400 ml-auto">バッジ・ランク・詳細ボタンで詳細表示</span>
            </div>
          </div>

          {/* Create Session Modal */}
          {showCreateModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-lg w-full mx-4 p-6">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">評価セッション作成</h2>

                {/* Worker selector */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    対象スタッフ
                  </label>
                  <select
                    value={createWorkerId ?? ''}
                    onChange={e => setCreateWorkerId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                  >
                    <option value="">選択してください</option>
                    {workers.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({VISA_LABELS[w.visaType] || w.visaType})
                      </option>
                    ))}
                  </select>
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
      {activeTab === 'review' && (
        <div className="space-y-6">
          {/* Worker selector */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スタッフ情報</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">名前</span>
                        <span className="font-medium text-gray-900 dark:text-white">{sw.name}</span>
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
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                        <div key={cat.key} className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
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
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                      スコアプレビュー
                      <span className="ml-2 text-[11px] font-normal text-gray-500">
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
                        onClick={() => setIsEditing(false)}
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
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
      {activeTab === 'approve' && isAdmin && (
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
                      <div key={session.id} className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 flex items-center justify-between">
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">{session.workerName}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            評価日: {session.evaluationDate} / {session.reviews.length}名が提出
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            setApproveSessionId(session.id)
                            // Pre-fill finalScores from weighted average (2026-05-12 改訂)
                            //   旧: 重み付き多数決（離散投票）→ 重みの小数差が吸収されてしまう
                            //   新: 加重平均 (A=3, B=2, C=1) → しきい値で ABC 変換
                            //   評価者全員の意見が連続的に反映され、小数重みが実質的に効く。
                            if (session.reviews.length > 0) {
                              const prefill = JSON.parse(JSON.stringify(EMPTY_SCORES)) as EvaluationScores
                              for (const item of EVAL_ITEMS) {
                                let weightedSum = 0
                                let totalWeight = 0
                                for (const r of session.reviews) {
                                  // 2026-05-12 スコープ分担:
                                  //   - 生活態度: 靖仁さん (id=0) のみ評価対象
                                  //   - その他カテゴリ: 靖仁さん以外（職長3 + 政仁さん）
                                  //   担当外カテゴリは weight=0 で加重平均から除外
                                  const isAdminEvaluator = r.evaluatorId === 0
                                  const isLivingCategory = item.category === 'living'
                                  if (isLivingCategory && !isAdminEvaluator) continue   // 生活態度を非adminは対象外
                                  if (!isLivingCategory && isAdminEvaluator) continue   // 非生活態度をadminは対象外

                                  const g = getScoreValue(r.scores, item.category, item.key)
                                  const gradeNum = g === 'A' ? 3 : g === 'B' ? 2 : 1
                                  // ウェイト未設定（旧セッション）は 1.0 にフォールバック
                                  const w = session.evaluatorWeights?.[r.evaluatorId]?.weight ?? 1.0
                                  weightedSum += gradeNum * w
                                  totalWeight += w
                                }
                                const avg = totalWeight > 0 ? weightedSum / totalWeight : 2
                                // しきい値: A=3, B=2, C=1 の中点で区切る
                                const best: ABCGrade = avg >= 2.5 ? 'A' : avg >= 1.5 ? 'B' : 'C'
                                const cat = prefill[item.category as keyof EvaluationScores] as Record<string, ABCGrade>
                                cat[item.key] = best
                              }
                              setFinalScores(prefill)
                            } else {
                              setFinalScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
                            }
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
            const years = worker?.hireDate ? yearsFromDate(worker.hireDate) : 1

            // Calculate final score preview
            const finalCalc = calculateManualScore(finalScores)
            const bonus = session.metrics?.attendanceBonus ?? 0
            const totalScore = finalCalc.total + bonus
            const rank = calculateRank(totalScore)
            const raiseAmount = getRaiseAmount(rank, years, worker?.hourlyRate)

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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
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
                                  <div className="mt-1 text-[10px] font-normal opacity-90">
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
                              <div className="text-[10px] font-normal opacity-70 mt-0.5">（重み付き加重平均）</div>
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
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
      {activeTab === 'monitor' && isAdmin && (
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-8 text-center text-gray-400 dark:text-gray-500">
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
                      className={`bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 ${
                        isReviewing
                          ? 'border-amber-400'
                          : isStale
                          ? 'border-orange-400'
                          : 'border-blue-400'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2 flex-wrap gap-2">
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
                              setFinalScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
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
      {activeTab === 'history' && isAdmin && (
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
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-8 text-center text-gray-400 dark:text-gray-500">
                    承認済みの評価がありません
                  </div>
                ) : (
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
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
                              <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{s.workerName}</td>
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
              className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-4xl w-full my-8 max-h-[90vh] overflow-y-auto"
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
