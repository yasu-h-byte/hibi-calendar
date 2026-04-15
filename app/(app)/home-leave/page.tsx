'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { daysBetween, todayIso } from '@/lib/date-utils'
import { LoadingState } from '@/components/ui'

interface HomeLeave {
  id: string
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  note?: string
  createdAt: string
}

interface Worker {
  id: number
  name: string
  visa: string
  retired?: string
}

const REASONS = ['一時帰国', 'ビザ更新帰国', 'その他'] as const

function formatDateFull(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export default function HomeLeavePage() {
  const [homeLeaves, setHomeLeaves] = useState<HomeLeave[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [showPast, setShowPast] = useState(false)

  // Form state
  const [formWorkerId, setFormWorkerId] = useState<number | ''>('')
  const [formStartDate, setFormStartDate] = useState('')
  const [formEndDate, setFormEndDate] = useState('')
  const [formReason, setFormReason] = useState<string>('一時帰国')
  const [formNote, setFormNote] = useState('')

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editStartDate, setEditStartDate] = useState('')
  const [editEndDate, setEditEndDate] = useState('')
  const [editReason, setEditReason] = useState('')
  const [editNote, setEditNote] = useState('')

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const { ready } = useAuthPassword()

  const fetchData = useCallback(async () => {
    if (!ready) return
    try {
      const [hlRes, wRes] = await Promise.all([
        fetchWithAuth('/api/home-leave'),
        fetchWithAuth('/api/workers'),
      ])
      if (hlRes.ok) {
        const d = await hlRes.json()
        setHomeLeaves(d.homeLeaves || [])
      }
      if (wRes.ok) {
        const d = await wRes.json()
        // APIは visaType フィールドで返すため、visa にマッピング
        const foreignWorkers = (d.workers || [])
          .map((w: Record<string, unknown>) => ({
            id: w.id as number,
            name: w.name as string,
            visa: (w.visaType || w.visa || '') as string,
            retired: (w.retired || '') as string,
          }))
          .filter((w: Worker) => w.visa && w.visa !== 'none' && !w.retired)
        setWorkers(foreignWorkers)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [ready])

  useEffect(() => { fetchData() }, [fetchData])

  const today = todayIso()

  const currentLeaves = homeLeaves
    .filter(h => h.startDate <= today && today <= h.endDate)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))

  const upcomingLeaves = homeLeaves
    .filter(h => h.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))

  const pastLeaves = homeLeaves
    .filter(h => h.endDate < today)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))

  const resetForm = () => {
    setFormWorkerId('')
    setFormStartDate('')
    setFormEndDate('')
    setFormReason('一時帰国')
    setFormNote('')
  }

  const handleAdd = async () => {
    if (!formWorkerId || !formStartDate || !formEndDate || !formReason) return
    const worker = workers.find(w => w.id === formWorkerId)
    if (!worker) return

    setSaving(true)
    const res = await postJson('/api/home-leave', {
      action: 'add',
      workerId: worker.id,
      workerName: worker.name,
      startDate: formStartDate,
      endDate: formEndDate,
      reason: formReason,
      note: formNote || undefined,
    })
    if (res.ok) {
      resetForm()
      setFormOpen(false)
      await fetchData()
    } else {
      alert(res.error || 'エラーが発生しました')
    }
    setSaving(false)
  }

  const startEdit = (h: HomeLeave) => {
    setEditingId(h.id)
    setEditStartDate(h.startDate)
    setEditEndDate(h.endDate)
    setEditReason(h.reason)
    setEditNote(h.note || '')
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const handleUpdate = async (id: string) => {
    setSaving(true)
    const res = await postJson('/api/home-leave', {
      action: 'update',
      id,
      startDate: editStartDate,
      endDate: editEndDate,
      reason: editReason,
      note: editNote || undefined,
    })
    if (res.ok) {
      setEditingId(null)
      await fetchData()
    } else {
      alert(res.error || 'エラーが発生しました')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    setSaving(true)
    const res = await postJson('/api/home-leave', { action: 'delete', id })
    if (res.ok) {
      setDeleteConfirm(null)
      await fetchData()
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <LoadingState />
      </div>
    )
  }

  const renderCard = (h: HomeLeave, section: 'current' | 'upcoming' | 'past') => {
    const isEditing = editingId === h.id
    const daysRemaining = section === 'current' ? daysBetween(today, h.endDate) : 0
    const daysUntilDeparture = section === 'upcoming' ? daysBetween(today, h.startDate) : 0
    const totalDays = daysBetween(h.startDate, h.endDate)

    if (isEditing) {
      return (
        <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="font-semibold text-gray-900 dark:text-white mb-3">{h.workerName}</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">出発日</label>
              <input
                type="date"
                value={editStartDate}
                onChange={e => setEditStartDate(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">帰国日</label>
              <input
                type="date"
                value={editEndDate}
                onChange={e => setEditEndDate(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">理由</label>
            <select
              value={editReason}
              onChange={e => setEditReason(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="mb-3">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">備考</label>
            <textarea
              value={editNote}
              onChange={e => setEditNote(e.target.value)}
              rows={2}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleUpdate(h.id)}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-500"
            >
              キャンセル
            </button>
          </div>
        </div>
      )
    }

    return (
      <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-gray-900 dark:text-white">{h.workerName}</div>
          {section === 'current' && (
            <span className="text-xs px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full">
              帰国まで {daysRemaining}日
            </span>
          )}
          {section === 'upcoming' && (
            <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">
              出発まで {daysUntilDeparture}日
            </span>
          )}
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
          <div>
            {formatDateFull(h.startDate)} ~ {formatDateFull(h.endDate)}
            <span className="text-gray-400 dark:text-gray-500 ml-2">({totalDays}日間)</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {h.reason}
            {h.note && <span className="ml-2">- {h.note}</span>}
          </div>
        </div>
        {section !== 'past' && (
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => startEdit(h)}
              className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              編集
            </button>
            {deleteConfirm === h.id ? (
              <div className="flex gap-1">
                <button
                  onClick={() => handleDelete(h.id)}
                  disabled={saving}
                  className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                >
                  削除する
                </button>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-3 py-1 text-xs bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded"
                >
                  やめる
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDeleteConfirm(h.id)}
                className="px-3 py-1 text-xs bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
              >
                削除
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6">
      {/* Header */}
      <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
        <span>✈️</span> 帰国・休暇管理
      </h1>

      {/* Add Form */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow">
        <button
          onClick={() => setFormOpen(!formOpen)}
          className="w-full px-4 py-3 flex items-center justify-between text-left"
        >
          <span className="font-medium text-gray-900 dark:text-white">新規登録</span>
          <span className="text-gray-400 text-lg">{formOpen ? '−' : '＋'}</span>
        </button>
        {formOpen && (
          <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700 pt-3">
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">スタッフ</label>
              <select
                value={formWorkerId}
                onChange={e => setFormWorkerId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              >
                <option value="">選択してください</option>
                {workers.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">出発日</label>
                <input
                  type="date"
                  value={formStartDate}
                  onChange={e => setFormStartDate(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">帰国日</label>
                <input
                  type="date"
                  value={formEndDate}
                  onChange={e => setFormEndDate(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">理由</label>
              <select
                value={formReason}
                onChange={e => setFormReason(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              >
                {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">備考</label>
              <textarea
                value={formNote}
                onChange={e => setFormNote(e.target.value)}
                rows={2}
                placeholder="任意"
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white placeholder-gray-400"
              />
            </div>
            <button
              onClick={handleAdd}
              disabled={saving || !formWorkerId || !formStartDate || !formEndDate}
              className="w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '登録中...' : '登録する'}
            </button>
          </div>
        )}
      </div>

      {/* Current Section */}
      <div>
        <div className="border-l-4 border-red-500 pl-3 mb-3">
          <h2 className="font-bold text-gray-900 dark:text-white">
            現在帰国中
            {currentLeaves.length > 0 && (
              <span className="ml-2 text-sm font-normal text-red-600 dark:text-red-400">
                ({currentLeaves.length}名)
              </span>
            )}
          </h2>
        </div>
        {currentLeaves.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-gray-500 pl-7">現在帰国中のスタッフはいません</div>
        ) : (
          <div className="space-y-3">
            {currentLeaves.map(h => renderCard(h, 'current'))}
          </div>
        )}
      </div>

      {/* Upcoming Section */}
      <div>
        <div className="border-l-4 border-blue-500 pl-3 mb-3">
          <h2 className="font-bold text-gray-900 dark:text-white">
            帰国予定
            {upcomingLeaves.length > 0 && (
              <span className="ml-2 text-sm font-normal text-blue-600 dark:text-blue-400">
                ({upcomingLeaves.length}件)
              </span>
            )}
          </h2>
        </div>
        {upcomingLeaves.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-gray-500 pl-7">帰国予定はありません</div>
        ) : (
          <div className="space-y-3">
            {upcomingLeaves.map(h => renderCard(h, 'upcoming'))}
          </div>
        )}
      </div>

      {/* Past Section */}
      <div>
        <div className="border-l-4 border-gray-300 dark:border-gray-600 pl-3 mb-3">
          <button
            onClick={() => setShowPast(!showPast)}
            className="font-bold text-gray-600 dark:text-gray-400 flex items-center gap-2"
          >
            過去の帰国履歴
            {pastLeaves.length > 0 && (
              <span className="text-sm font-normal">({pastLeaves.length}件)</span>
            )}
            <span className="text-sm">{showPast ? '▲' : '▼'}</span>
          </button>
        </div>
        {showPast && (
          pastLeaves.length === 0 ? (
            <div className="text-sm text-gray-400 dark:text-gray-500 pl-7">過去の帰国履歴はありません</div>
          ) : (
            <div className="space-y-2">
              {pastLeaves.map(h => (
                <div key={h.id} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{h.workerName}</span>
                    <span className="text-xs text-gray-400">{h.reason}</span>
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {formatDateFull(h.startDate)} ~ {formatDateFull(h.endDate)}
                    <span className="ml-2">({daysBetween(h.startDate, h.endDate)}日間)</span>
                  </div>
                  {h.note && (
                    <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{h.note}</div>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
