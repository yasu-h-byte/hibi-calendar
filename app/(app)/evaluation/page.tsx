'use client'

import { useEffect, useState, useCallback } from 'react'
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

type TabId = 'list' | 'review' | 'approve'

const EMPTY_SCORES: EvaluationScores = {
  japanese: { understanding: 'B' as ABCGrade, reporting: 'B' as ABCGrade, safety: 'B' as ABCGrade },
  attitude: { punctuality: 'B' as ABCGrade, safetyAwareness: 'B' as ABCGrade, teamwork: 'B' as ABCGrade, compliance: 'B' as ABCGrade },
  skill: { level: 'B' as ABCGrade, speed: 'B' as ABCGrade, planning: 'B' as ABCGrade },
  living: { neighborCare: 'B' as ABCGrade, ruleCompliance: 'B' as ABCGrade, cleanliness: 'B' as ABCGrade },
}

// ── Main Component ──

export default function EvaluationPage() {
  const [activeTab, setActiveTab] = useState<TabId>('list')
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

  const isAdmin = authUser?.role === 'admin' || authUser?.role === 'approver'
  const isAdminOnly = authUser?.role === 'admin' // 生活態度の入力はadminのみ

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
      }
    } catch { /* ignore */ }
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
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        alert(`作成に失敗しました: ${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`)
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
      }
    } catch { /* ignore */ }
    setSaving(false)
  }

  // ── Score preview for review tab ──
  const reviewCalc = calculateManualScore(myReview)

  // ── ABC Radio Button ──
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
    const descs = { A: descA, B: descB, C: descC }
    const [showDesc, setShowDesc] = useState(false)
    return (
      <div className="py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
            {descA && (
              <button type="button" onClick={() => setShowDesc(!showDesc)}
                className="text-gray-400 hover:text-blue-500 transition text-xs" title="評価基準を表示">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {grades.map(g => {
              const active = value === g
              let cls = 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
              if (active && g === 'A') cls = 'bg-green-500 text-white'
              if (active && g === 'B') cls = 'bg-yellow-500 text-white'
              if (active && g === 'C') cls = 'bg-red-400 text-white'
              return (
                <button
                  key={g}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(g)}
                  className={`w-10 h-10 rounded-lg font-bold text-sm transition-all ${cls} ${
                    disabled ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-80 cursor-pointer'
                  }`}
                >
                  {g}
                </button>
              )
            })}
          </div>
        </div>
        {showDesc && descA && (
          <div className="mt-2 space-y-1 text-xs bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            {grades.map(g => (
              <div key={g} className="flex gap-2">
                <span className={`font-bold w-5 shrink-0 ${g === 'A' ? 'text-green-600' : g === 'B' ? 'text-yellow-600' : 'text-red-500'}`}>{g}:</span>
                <span className="text-gray-600 dark:text-gray-400">{descs[g]}</span>
              </div>
            ))}
          </div>
        )}
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

  // ── Tabs ──
  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'list', label: '一覧' },
    { id: 'review', label: '評価入力' },
    { id: 'approve', label: '承認', adminOnly: true },
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
            <div className="flex justify-end">
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
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">入社日</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">勤続年数</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ステータス</th>
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
                      const st = latest
                        ? sessionStatusLabel(latest.status, latest.reviews || [], latest.evaluatorIds || [])
                        : { text: '未評価', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
                      const yrs = w.hireDate ? yearsFromDate(w.hireDate) : 0
                      return (
                        <tr key={w.id} className="hover:bg-gray-50 dark:hover:bg-gray-750">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{w.name}</td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                            {VISA_LABELS[w.visaType] || w.visaType}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{w.hireDate || '--'}</td>
                          <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300">
                            {yrs > 0 ? `${yrs}年` : '--'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>
                              {st.text}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {latest?.rank ? (
                              <span className={`font-bold ${rankColor(latest.rank)}`}>{latest.rank}</span>
                            ) : '--'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className={isOverdue ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-600 dark:text-gray-300'}>
                              {nextDate}
                            </span>
                            {isOverdue && (
                              <span className="ml-1 inline-block px-1.5 py-0.5 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 text-xs rounded-full font-bold">
                                期限超過
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {latest && latest.status !== 'approved' && authUser && latest.evaluatorIds.includes(authUser.workerId) && (
                              <button
                                onClick={() => {
                                  setSelectedWorkerId(w.id)
                                  setActiveTab('review')
                                }}
                                className="px-3 py-1 text-xs font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                              >
                                評価入力
                              </button>
                            )}
                            {latest && latest.status === 'reviewing' && isAdmin && (
                              <button
                                onClick={() => {
                                  setApproveSessionId(latest.id)
                                  setFinalScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
                                  setFinalComment('')
                                  setActiveTab('approve')
                                }}
                                className="px-3 py-1 text-xs font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors ml-1"
                              >
                                承認へ
                              </button>
                            )}
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
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">現在の時給</span>
                        <span className="font-medium text-gray-900 dark:text-white">
                          {sw.hourlyRate ? fmtYen(sw.hourlyRate) : '--'}
                        </span>
                      </div>
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

                  {/* ABC sections — generated from EVALUATION_CATEGORIES */}
                  <div className="space-y-4">
                    {EVALUATION_CATEGORIES.filter(cat => cat.key !== 'living' || isAdminOnly).map(cat => {
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

                  {/* Score preview */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スコアプレビュー</h3>
                    <div className="space-y-1 text-sm">
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
                      <div className="flex justify-between text-gray-600 dark:text-gray-300">
                        <span>生活態度: {reviewCalc.living}点 x1.0</span>
                        <span className="font-medium">= {reviewCalc.livingW.toFixed(1)}</span>
                      </div>
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                        <div className="flex justify-between text-gray-900 dark:text-white font-bold">
                          <span>手動合計: {reviewCalc.total.toFixed(1)}点</span>
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
                  <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-green-700 dark:text-green-300 font-medium">
                        評価を提出済みです
                      </p>
                      <button
                        onClick={() => setIsEditing(true)}
                        className="px-3 py-1 text-xs font-medium rounded-lg border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50"
                      >
                        修正する
                      </button>
                    </div>
                  </div>

                  {/* My submitted review (read-only) */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">自分の評価</h3>
                    <div className="space-y-2">
                      {EVAL_ITEMS.map(item => (
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
                                {EVAL_ITEMS.map(item => (
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
                            // Pre-fill finalScores from majority vote or first review
                            if (session.reviews.length > 0) {
                              // Use majority vote for each item
                              const majority = JSON.parse(JSON.stringify(EMPTY_SCORES)) as EvaluationScores
                              for (const item of EVAL_ITEMS) {
                                const grades = session.reviews.map(r => getScoreValue(r.scores, item.category, item.key))
                                const counts: Record<ABCGrade, number> = { A: 0, B: 0, C: 0 }
                                for (const g of grades) counts[g]++
                                const best = (['A', 'B', 'C'] as ABCGrade[]).sort((a, b) => counts[b] - counts[a])[0]
                                const cat = majority[item.category as keyof EvaluationScores] as Record<string, ABCGrade>
                                cat[item.key] = best
                              }
                              setFinalScores(majority)
                            } else {
                              setFinalScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
                            }
                            setFinalComment('')
                          }}
                          className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
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
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">現在の時給</span>
                      <span className="font-medium text-gray-900 dark:text-white">
                        {worker?.hourlyRate ? fmtYen(worker.hourlyRate) : '--'}
                      </span>
                    </div>
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
                          {session.reviews.map((review, idx) => (
                            <th
                              key={review.evaluatorId}
                              className={`px-3 py-3 text-center text-xs font-medium text-white border-b border-gray-200 dark:border-gray-700 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].header}`}
                            >
                              {review.evaluatorName}
                            </th>
                          ))}
                          <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1">
                          </th>
                          <th className="px-3 py-3 text-center text-xs font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 min-w-[140px]">
                            最終評価
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {EVAL_ITEMS.map((item, rowIdx) => {
                          const allGrades = session.reviews.map(r => getScoreValue(r.scores, item.category, item.key))
                          const allSame = allGrades.length > 0 && allGrades.every(g => g === allGrades[0])
                          const rowBg = rowIdx % 2 === 0 ? '' : 'bg-gray-50/50 dark:bg-gray-750/50'
                          return (
                            <tr key={`${item.category}_${item.key}`} className={rowBg}>
                              <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700">
                                <div className="flex items-center gap-1.5">
                                  <span className={`inline-block w-2 h-2 rounded-full ${allSame ? 'bg-green-400' : 'bg-yellow-400'}`} />
                                  {item.label}
                                </div>
                              </td>
                              {session.reviews.map(review => (
                                <td key={review.evaluatorId} className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700">
                                  <GradeBadge grade={getScoreValue(review.scores, item.category, item.key)} />
                                </td>
                              ))}
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
    </div>
  )
}
