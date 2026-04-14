'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Worker,
  ABCGrade,
  EvaluationStatus,
  EvaluationRank,
  EvaluationScores,
  EvaluationMetrics,
  Evaluation,
  AuthUser,
} from '@/types'
import { fmtYen } from '@/lib/format'

// ── Helper functions ──

function gradeToScore(g: ABCGrade): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : 1
}

const WEIGHTS = { japanese: 1.0, attitude: 1.5, skill: 1.2 }

function calculateManualScore(scores: EvaluationScores): {
  japanese: number
  attitude: number
  skill: number
  japaneseW: number
  attitudeW: number
  skillW: number
  total: number
} {
  const jp =
    gradeToScore(scores.japanese.understanding) +
    gradeToScore(scores.japanese.reporting) +
    gradeToScore(scores.japanese.safety)
  const att =
    gradeToScore(scores.attitude.punctuality) +
    gradeToScore(scores.attitude.safetyAwareness) +
    gradeToScore(scores.attitude.teamwork)
  const sk =
    gradeToScore(scores.skill.level) +
    gradeToScore(scores.skill.speed) +
    gradeToScore(scores.skill.planning)
  const jpW = jp * WEIGHTS.japanese
  const attW = att * WEIGHTS.attitude
  const skW = sk * WEIGHTS.skill
  return {
    japanese: jp,
    attitude: att,
    skill: sk,
    japaneseW: jpW,
    attitudeW: attW,
    skillW: skW,
    total: jpW + attW + skW,
  }
}

function calculateRank(totalScore: number): EvaluationRank {
  if (totalScore >= 29) return 'S'
  if (totalScore >= 24) return 'A'
  if (totalScore >= 18) return 'B'
  if (totalScore >= 12) return 'C'
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

const RAISE_TABLE: { year: number; S: number; A: number; B: number; C: number }[] = [
  { year: 1, S: 150, A: 100, B: 60, C: 0 },
  { year: 2, S: 120, A: 80, B: 50, C: 0 },
  { year: 3, S: 100, A: 60, B: 40, C: 0 },
  { year: 4, S: 80, A: 50, B: 30, C: 0 },
  { year: 5, S: 60, A: 40, B: 20, C: 0 },
  { year: 6, S: 40, A: 30, B: 15, C: 0 },
]

function getRaiseAmount(rank: EvaluationRank, yearsFromHire: number): number {
  if (rank === 'D') return 0
  const row = RAISE_TABLE.find(r => r.year === Math.min(yearsFromHire, 6)) || RAISE_TABLE[5]
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

function nextEvalDate(hireDate: string, evaluations: Evaluation[]): string {
  if (!hireDate) return '—'
  const hire = new Date(hireDate)
  const approvedYears = evaluations
    .filter(e => e.status === 'approved')
    .map(e => e.yearsFromHire)
  const currentYears = yearsFromDate(hireDate)
  for (let y = 1; y <= currentYears + 1; y++) {
    if (!approvedYears.includes(y)) {
      const d = new Date(hire)
      d.setFullYear(d.getFullYear() + y)
      return d.toISOString().slice(0, 10)
    }
  }
  const nextY = currentYears + 1
  const d = new Date(hire)
  d.setFullYear(d.getFullYear() + nextY)
  return d.toISOString().slice(0, 10)
}

function statusLabel(s: EvaluationStatus | undefined): { text: string; cls: string } {
  switch (s) {
    case 'draft': return { text: '下書き', cls: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200' }
    case 'submitted': return { text: '提出済み', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' }
    case 'approved': return { text: '承認済み', cls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200' }
    default: return { text: '未評価', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
  }
}

type TabId = 'list' | 'input' | 'history'

const EMPTY_SCORES: EvaluationScores = {
  japanese: { understanding: 'B' as ABCGrade, reporting: 'B' as ABCGrade, safety: 'B' as ABCGrade },
  attitude: { punctuality: 'B' as ABCGrade, safetyAwareness: 'B' as ABCGrade, teamwork: 'B' as ABCGrade },
  skill: { level: 'B' as ABCGrade, speed: 'B' as ABCGrade, planning: 'B' as ABCGrade },
}

// ── Main Component ──

export default function EvaluationPage() {
  const [tab, setTab] = useState<TabId>('list')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])

  // Input tab state
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null)
  const [scores, setScores] = useState<EvaluationScores>(JSON.parse(JSON.stringify(EMPTY_SCORES)))
  const [comment, setComment] = useState('')
  const [metrics, setMetrics] = useState<EvaluationMetrics | null>(null)
  const [existingEval, setExistingEval] = useState<Evaluation | null>(null)

  // History tab state
  const [historyWorkerId, setHistoryWorkerId] = useState<number | null>(null)

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
        // 外国人のみ（visaTypeがnone以外）
        setWorkers(all.filter(w => w.visaType && w.visaType !== 'none' && !w.retired))
      }
      if (eRes.ok) {
        const d = await eRes.json()
        setEvaluations(d.evaluations || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Foreign workers only ──
  const foreignWorkers = workers

  // ── Input tab: load worker data ──
  const selectedWorker = foreignWorkers.find(w => w.id === selectedWorkerId)
  const workerEvals = evaluations.filter(e => e.workerId === selectedWorkerId)

  const loadWorkerEval = useCallback(async (wId: number) => {
    const { password } = getAuth()
    try {
      const res = await fetch(`/api/evaluation?workerId=${wId}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const d = await res.json()
        const evals: Evaluation[] = d.evaluations || []
        const latest = evals.find(e => e.status === 'draft' || e.status === 'submitted')
        if (latest) {
          setScores(latest.scores)
          setComment(latest.comment)
          setMetrics(latest.metrics)
          setExistingEval(latest)
        } else {
          setScores(JSON.parse(JSON.stringify(EMPTY_SCORES)))
          setComment('')
          setMetrics(d.metrics || null)
          setExistingEval(null)
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (selectedWorkerId) loadWorkerEval(selectedWorkerId)
  }, [selectedWorkerId, loadWorkerEval])

  // ── Score calculation ──
  const calc = calculateManualScore(scores)
  const bonus = metrics?.attendanceBonus ?? 0
  const totalScore = calc.total + bonus
  const rank = calculateRank(totalScore)
  const years = selectedWorker?.hireDate ? yearsFromDate(selectedWorker.hireDate) : 1
  const raiseAmount = getRaiseAmount(rank, years)

  // ── Save / Submit ──
  const handleSave = async (status: EvaluationStatus) => {
    if (!selectedWorkerId || !authUser) return
    setSaving(true)
    const { password } = getAuth()
    try {
      const body = {
        workerId: selectedWorkerId,
        scores,
        comment,
        status,
        evaluatorId: authUser.workerId,
        evaluatorName: authUser.name,
      }
      const method = existingEval ? 'PUT' : 'POST'
      const url = existingEval
        ? `/api/evaluation?id=${existingEval.id}`
        : '/api/evaluation'
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        await fetchData()
        if (selectedWorkerId) await loadWorkerEval(selectedWorkerId)
      }
    } catch { /* ignore */ }
    setSaving(false)
  }

  const handleApprove = async () => {
    if (!existingEval || !authUser) return
    setSaving(true)
    const { password } = getAuth()
    try {
      const res = await fetch(`/api/evaluation?id=${existingEval.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          status: 'approved',
          approvedBy: authUser.workerId,
          raiseAmount,
        }),
      })
      if (res.ok) {
        await fetchData()
        if (selectedWorkerId) await loadWorkerEval(selectedWorkerId)
      }
    } catch { /* ignore */ }
    setSaving(false)
  }

  // ── History tab data ──
  const historyWorkerEvals = evaluations
    .filter(e => e.workerId === historyWorkerId)
    .sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))

  // ── ABC Radio Button ──
  function ABCRadio({
    value,
    onChange,
    label,
  }: {
    value: ABCGrade
    onChange: (v: ABCGrade) => void
    label: string
  }) {
    const grades: ABCGrade[] = ['A', 'B', 'C']
    const disabled = existingEval?.status === 'approved'
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
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
    )
  }

  // ── Tabs ──
  const tabs: { id: TabId; label: string }[] = [
    { id: 'list', label: '一覧' },
    { id: 'input', label: '評価入力' },
    { id: 'history', label: '履歴' },
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">評価管理</h1>

      {/* Tab Bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Tab 1: 一覧 ─── */}
      {tab === 'list' && (
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
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">時給</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">次回評価日</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {foreignWorkers
                  .map(w => {
                    const wEvals = evaluations.filter(e => e.workerId === w.id)
                    const latest = wEvals.sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0]
                    const nextDate = nextEvalDate(w.hireDate || '', wEvals)
                    const isOverdue = nextDate !== '—' && nextDate <= new Date().toISOString().slice(0, 10)
                    return { worker: w, latest, nextDate, isOverdue }
                  })
                  .sort((a, b) => {
                    // Overdue first, then by next date ascending
                    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
                    return a.nextDate.localeCompare(b.nextDate)
                  })
                  .map(({ worker: w, latest, nextDate, isOverdue }) => {
                    const st = statusLabel(latest?.status)
                    const yrs = w.hireDate ? yearsFromDate(w.hireDate) : 0
                    return (
                      <tr key={w.id} className="hover:bg-gray-50 dark:hover:bg-gray-750">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{w.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                          {VISA_LABELS[w.visaType] || w.visaType}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{w.hireDate || '—'}</td>
                        <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300">
                          {yrs > 0 ? `${yrs}年` : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>
                            {st.text}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-300">
                          {w.hourlyRate ? fmtYen(w.hourlyRate) : '—'}
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
                          <button
                            onClick={() => {
                              setSelectedWorkerId(w.id)
                              setTab('input')
                            }}
                            className="px-3 py-1 text-xs font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                          >
                            {latest?.status === 'submitted' || latest?.status === 'approved' ? '確認する' : '評価する'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                {foreignWorkers.length === 0 && (
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
      )}

      {/* ─── Tab 2: 評価入力 ─── */}
      {tab === 'input' && (
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
              {foreignWorkers.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}（{VISA_LABELS[w.visaType] || w.visaType}）
                </option>
              ))}
            </select>
          </div>

          {selectedWorker && (
            <>
              {/* Worker info card */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スタッフ情報</h3>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">名前</span>
                    <span className="font-medium text-gray-900 dark:text-white">{selectedWorker.name}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">在留資格</span>
                    <span className="text-gray-900 dark:text-white">{VISA_LABELS[selectedWorker.visaType] || selectedWorker.visaType}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">入社日</span>
                    <span className="text-gray-900 dark:text-white">{selectedWorker.hireDate || '—'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">勤続年数</span>
                    <span className="text-gray-900 dark:text-white">{years}年</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">現在の時給</span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {selectedWorker.hourlyRate ? fmtYen(selectedWorker.hourlyRate) : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Attendance metrics card */}
              {metrics && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">出勤実績（過去1年）</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率</span>
                      <span className="font-medium text-gray-900 dark:text-white">{metrics.attendanceRate.toFixed(1)}%</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                      <span className="text-gray-900 dark:text-white">{metrics.overtimeAvg.toFixed(1)}h/月</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">有給取得</span>
                      <span className="text-gray-900 dark:text-white">{metrics.plUsage}日</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率ボーナス</span>
                      <span className="font-bold text-blue-600 dark:text-blue-400">+{metrics.attendanceBonus}点</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Evaluation sections */}
              <div className="space-y-4">
                {/* 日本語能力 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
                  <div className="bg-blue-500 px-4 py-2">
                    <h3 className="text-white font-bold text-sm flex items-center gap-2">
                      <span>&#x1F5E3;</span> 日本語能力
                      <span className="text-blue-200 text-xs font-normal">（重み ×1.0）</span>
                    </h3>
                  </div>
                  <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-700">
                    <ABCRadio
                      label="指示理解"
                      value={scores.japanese.understanding}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        japanese: { ...prev.japanese, understanding: v },
                      }))}
                    />
                    <ABCRadio
                      label="報告・連絡"
                      value={scores.japanese.reporting}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        japanese: { ...prev.japanese, reporting: v },
                      }))}
                    />
                    <ABCRadio
                      label="安全用語"
                      value={scores.japanese.safety}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        japanese: { ...prev.japanese, safety: v },
                      }))}
                    />
                  </div>
                </div>

                {/* 勤務態度 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
                  <div className="bg-green-500 px-4 py-2">
                    <h3 className="text-white font-bold text-sm flex items-center gap-2">
                      <span>&#x1F4BC;</span> 勤務態度
                      <span className="text-green-200 text-xs font-normal">（重み ×1.5 ★最重要）</span>
                    </h3>
                  </div>
                  <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-700">
                    <ABCRadio
                      label="時間厳守"
                      value={scores.attitude.punctuality}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        attitude: { ...prev.attitude, punctuality: v },
                      }))}
                    />
                    <ABCRadio
                      label="安全意識"
                      value={scores.attitude.safetyAwareness}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        attitude: { ...prev.attitude, safetyAwareness: v },
                      }))}
                    />
                    <ABCRadio
                      label="協調性"
                      value={scores.attitude.teamwork}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        attitude: { ...prev.attitude, teamwork: v },
                      }))}
                    />
                  </div>
                </div>

                {/* 職業能力 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
                  <div className="bg-orange-500 px-4 py-2">
                    <h3 className="text-white font-bold text-sm flex items-center gap-2">
                      <span>&#x1F528;</span> 職業能力
                      <span className="text-orange-200 text-xs font-normal">（重み ×1.2）</span>
                    </h3>
                  </div>
                  <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-700">
                    <ABCRadio
                      label="技能レベル"
                      value={scores.skill.level}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        skill: { ...prev.skill, level: v },
                      }))}
                    />
                    <ABCRadio
                      label="作業速度・品質"
                      value={scores.skill.speed}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        skill: { ...prev.skill, speed: v },
                      }))}
                    />
                    <ABCRadio
                      label="段取り・準備"
                      value={scores.skill.planning}
                      onChange={v => setScores(prev => ({
                        ...prev,
                        skill: { ...prev.skill, planning: v },
                      }))}
                    />
                  </div>
                </div>
              </div>

              {/* Comment */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  コメント
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  disabled={existingEval?.status === 'approved'}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white disabled:opacity-60"
                  placeholder="評価に関するコメントを入力..."
                />
              </div>

              {/* Score preview */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スコアプレビュー</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>日本語: {calc.japanese}点 ×1.0</span>
                    <span className="font-medium">= {calc.japaneseW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>勤務態度: {calc.attitude}点 ×1.5</span>
                    <span className="font-medium">= {calc.attitudeW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>職業能力: {calc.skill}点 ×1.2</span>
                    <span className="font-medium">= {calc.skillW.toFixed(1)}</span>
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

              {/* Action buttons */}
              <div className="flex gap-3 justify-end">
                {existingEval?.status !== 'approved' && (
                  <>
                    <button
                      onClick={() => handleSave('draft')}
                      disabled={saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      {saving ? '保存中...' : '下書き保存'}
                    </button>
                    <button
                      onClick={() => handleSave('submitted')}
                      disabled={saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
                    >
                      {saving ? '送信中...' : '提出する'}
                    </button>
                  </>
                )}
                {existingEval?.status === 'submitted' &&
                  authUser &&
                  (authUser.role === 'admin' || authUser.role === 'approver') && (
                  <button
                    onClick={handleApprove}
                    disabled={saving}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
                  >
                    {saving ? '承認中...' : '承認する'}
                  </button>
                )}
                {existingEval?.status === 'approved' && (
                  <span className="px-4 py-2 text-sm font-medium text-green-600 dark:text-green-400">
                    承認済み
                  </span>
                )}
              </div>
            </>
          )}

          {!selectedWorkerId && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              スタッフを選択してください
            </div>
          )}
        </div>
      )}

      {/* ─── Tab 3: 履歴 ─── */}
      {tab === 'history' && (
        <div className="space-y-6">
          {/* Worker selector */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              対象スタッフ
            </label>
            <select
              value={historyWorkerId ?? ''}
              onChange={e => setHistoryWorkerId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
            >
              <option value="">選択してください</option>
              {foreignWorkers.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}（{VISA_LABELS[w.visaType] || w.visaType}）
                </option>
              ))}
            </select>
          </div>

          {historyWorkerId && historyWorkerEvals.length > 0 && (
            <>
              {/* History table */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-900">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">評価日</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">評価者</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">スコア</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ランク</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">昇給額</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ステータス</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {historyWorkerEvals.map(ev => {
                        const st = statusLabel(ev.status)
                        return (
                          <tr key={ev.id} className="hover:bg-gray-50 dark:hover:bg-gray-750">
                            <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">{ev.evaluationDate}</td>
                            <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{ev.evaluatorName}</td>
                            <td className="px-4 py-3 text-sm text-center font-medium text-gray-900 dark:text-white">
                              {ev.totalScore.toFixed(1)}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`font-bold ${rankColor(ev.rank)}`}>{ev.rank}</span>
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-white">
                              {ev.raiseAmount != null ? `+${ev.raiseAmount}円/h` : '—'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>
                                {st.text}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Hourly rate transition */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">時給推移</h3>
                {(() => {
                  const hw = foreignWorkers.find(w => w.id === historyWorkerId)
                  const approved = historyWorkerEvals
                    .filter(e => e.status === 'approved' && e.raiseAmount != null)
                    .sort((a, b) => a.evaluationDate.localeCompare(b.evaluationDate))
                  if (approved.length === 0) {
                    return (
                      <p className="text-sm text-gray-400 dark:text-gray-500">
                        承認済みの評価がまだありません
                      </p>
                    )
                  }
                  // Build rate timeline
                  const baseRate = hw?.hourlyRate ?? 0
                  let currentRate = baseRate
                  // Walk backwards to find original rate
                  const totalRaises = approved.reduce((sum, e) => sum + (e.raiseAmount || 0), 0)
                  const startRate = baseRate - totalRaises
                  currentRate = startRate

                  const timeline: { date: string; rate: number; raise: number; rank: EvaluationRank }[] = [
                    { date: hw?.hireDate || '入社時', rate: startRate, raise: 0, rank: 'B' as EvaluationRank },
                  ]
                  for (const ev of approved) {
                    currentRate += ev.raiseAmount || 0
                    timeline.push({
                      date: ev.evaluationDate,
                      rate: currentRate,
                      raise: ev.raiseAmount || 0,
                      rank: ev.rank,
                    })
                  }

                  const maxRate = Math.max(...timeline.map(t => t.rate))
                  const minRate = Math.min(...timeline.map(t => t.rate))
                  const range = maxRate - minRate || 1

                  return (
                    <div className="space-y-2">
                      {timeline.map((t, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                          <span className="w-24 text-gray-500 dark:text-gray-400 text-xs shrink-0">{t.date}</span>
                          <div className="flex-1 relative h-6">
                            <div
                              className="absolute top-0 left-0 h-6 rounded-r bg-blue-400 dark:bg-blue-600 transition-all"
                              style={{
                                width: `${Math.max(10, ((t.rate - minRate) / range) * 100)}%`,
                              }}
                            />
                            <span className="absolute left-2 top-0 h-6 flex items-center text-xs font-medium text-white z-10">
                              {fmtYen(t.rate)}
                              {t.raise > 0 && (
                                <span className="ml-1 text-green-200">+{t.raise}円</span>
                              )}
                            </span>
                          </div>
                          {i > 0 && (
                            <span className={`text-xs font-bold ${rankColor(t.rank)}`}>{t.rank}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </>
          )}

          {historyWorkerId && historyWorkerEvals.length === 0 && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              評価履歴がありません
            </div>
          )}

          {!historyWorkerId && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              スタッフを選択してください
            </div>
          )}
        </div>
      )}
    </div>
  )
}
