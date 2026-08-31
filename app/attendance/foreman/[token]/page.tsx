'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { AttendanceEntry, AttendanceStatus } from '@/types'

interface MisplacedEntry {
  siteId: string
  siteName: string
  entry: AttendanceEntry
}

interface OverviewDay {
  day: number
  dateISO: string
  isWorkDay: boolean
  approved: boolean
  entered: number
  missingNames: string[]
}

interface BreakSetting { enabled: boolean; minutes: number; mandatory: boolean }

interface ForemanData {
  foreman: { id: number; name: string }
  site: { id: string; name: string }
  date: { year: number; month: number; day: number; ym: string; dateLabel: string; dateISO: string }
  workers: {
    id: number
    name: string
    entry: AttendanceEntry | null
    status: AttendanceStatus
    misplacedEntries?: MisplacedEntry[]
  }[]
  summary: { workCount: number; noneCount: number; totalCount: number }
  approved: boolean
  pastDays: { date: string; dateISO: string; approved: boolean }[]
  monthOverview: OverviewDay[]
  schedule: {
    startTime: string
    endTime: string
    morningBreak: BreakSetting
    lunchBreak: BreakSetting
    afternoonBreak: BreakSetting
  }
}

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  work: '出勤', overtime: '残業あり', rest: '休み',
  leave: '有給', site_off: '現場休み', home_leave: '帰国中', exam: '試験',
  comp: '現場都合休み(0.6)', none: '未入力',
}
const STATUS_EMOJI: Record<AttendanceStatus, string> = {
  work: '🔨', overtime: '⏰', rest: '🏠', leave: '🌴', site_off: '🚧',
  home_leave: '✈️', exam: '📝', comp: '🚧', none: '❓',
}
const STATUS_COLORS: Record<AttendanceStatus, string> = {
  work: 'bg-blue-100 text-blue-700', overtime: 'bg-orange-100 text-orange-700',
  rest: 'bg-gray-200 text-gray-600', leave: 'bg-green-100 text-green-700',
  site_off: 'bg-yellow-100 text-yellow-700',
  home_leave: 'bg-cyan-100 text-cyan-700', exam: 'bg-purple-100 text-purple-700',
  comp: 'bg-yellow-100 text-yellow-700',
  none: 'bg-red-50 text-red-400',
}

export default function ForemanAttendancePage() {
  const params = useParams()
  const token = params.token as string

  const [data, setData] = useState<ForemanData | null>(null)
  const [dateISO, setDateISO] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingWorker, setEditingWorker] = useState<{ id: number; name: string; hasEntry: boolean } | null>(null)
  const [editOT, setEditOT] = useState(0)
  // 時刻つき代理入力（2026-08-28 追加）。開くたびに entry または現場の勤務時間で初期化
  const [editStart, setEditStart] = useState('08:00')
  const [editEnd, setEditEnd] = useState('17:00')
  const [editB1, setEditB1] = useState(true)
  const [editB2, setEditB2] = useState(true)
  const [editB3, setEditB3] = useState(true)
  const [bulkApproving, setBulkApproving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fixingSite, setFixingSite] = useState<{
    workerId: number
    workerName: string
    misplaced: MisplacedEntry[]
  } | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const url = dateISO
        ? `/api/attendance/foreman?token=${token}&date=${dateISO}`
        : `/api/attendance/foreman?token=${token}`
      const res = await fetch(url)
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'エラー')
        return
      }
      const d: ForemanData = await res.json()
      setData(d)
      if (!dateISO) setDateISO(d.date.dateISO)
    } catch {
      setError('通信エラー')
    } finally {
      setLoading(false)
    }
  }, [token, dateISO])

  useEffect(() => { fetchData() }, [fetchData])

  const navDay = (delta: number) => {
    if (!data) return
    const current = new Date(data.date.dateISO + 'T00:00:00')
    current.setDate(current.getDate() + delta)
    const today = new Date()
    if (current > today) return
    const iso = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`
    setDateISO(iso)
  }

  const isToday = data ? data.date.dateISO === (() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })() : false

  const handleApprove = async () => {
    if (!data || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'approve',
          year: data.date.year,
          month: data.date.month,
          day: data.date.day,
        }),
      })
      // 失敗（ロック済み等）を必ず表示（2026-08-27 休暇届総点検）
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || `確認に失敗しました (${res.status})`)
      }
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = async (choice: string) => {
    if (!data || !editingWorker || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'edit',
          workerId: editingWorker.id,
          year: data.date.year,
          month: data.date.month,
          day: data.date.day,
          choice,
          overtimeHours: choice === 'work' ? editOT : 0,
          ...(choice === 'work' ? {
            startTime: editStart, endTime: editEnd,
            break1: editB1, break2: editB2, break3: editB3,
          } : {}),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || `変更に失敗しました (${res.status})`)
        return
      }
      setEditingWorker(null)
      setEditOT(0)
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  // 代理入力モーダルを開く。時刻は 既存入力 > 現場の勤務時間 の順で初期化
  const openEditor = (w: { id: number; name: string; entry: AttendanceEntry | null }) => {
    const sch = data?.schedule
    setEditingWorker({ id: w.id, name: w.name, hasEntry: !!w.entry })
    setEditOT(w.entry?.o || 0)
    setEditStart(w.entry?.st || sch?.startTime || '08:00')
    setEditEnd(w.entry?.et || sch?.endTime || '17:00')
    setEditB1(w.entry ? !!w.entry.b1 : (sch?.morningBreak.enabled ?? true))
    setEditB2(w.entry ? !!w.entry.b2 : (sch?.lunchBreak.enabled ?? true))
    setEditB3(w.entry ? !!w.entry.b3 : (sch?.afternoonBreak.enabled ?? true))
  }

  // ── まとめ承認（全員入力済み・未承認の稼働日だけ）──
  const bulkTargets = (data?.monthOverview || []).filter(
    o => o.isWorkDay && !o.approved && o.entered > 0 && o.missingNames.length === 0
  )
  const handleBulkApprove = async () => {
    if (!data || bulkApproving || bulkTargets.length === 0) return
    if (!confirm(
      `${bulkTargets.map(o => `${o.day}日`).join('・')} の ${bulkTargets.length}日分をまとめて確認します。\n`
      + `（全員の入力がそろっている日だけが対象です）\n\nよろしいですか？`
    )) return
    setBulkApproving(true)
    try {
      const res = await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token, action: 'approve_bulk',
          year: data.date.year, month: data.date.month,
          days: bulkTargets.map(o => o.day),
        }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        alert(d?.error || `まとめ確認に失敗しました (${res.status})`)
      } else if (d?.skipped?.length) {
        alert(`✅ ${d.approvedDays.length}日分を確認しました\n\n以下は確認できませんでした:\n`
          + d.skipped.map((x: { day: number; reason: string }) => `・${x.day}日: ${x.reason}`).join('\n'))
      }
      fetchData()
    } finally {
      setBulkApproving(false)
    }
  }

  // ── 別現場入力を自現場に移動 ──
  const handleFixSite = async (fromSiteId: string) => {
    if (!data || !fixingSite || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'fix_site',
          workerId: fixingSite.workerId,
          year: data.date.year,
          month: data.date.month,
          day: data.date.day,
          fromSiteId,
        }),
      })
      if (res.ok) {
        setFixingSite(null)
        await fetchData()
        alert(`✅ ${fixingSite.workerName} さんの入力を ${data.site.name} に移動しました`)
      } else {
        const err = await res.json().catch(() => ({}))
        alert(`❌ 移動に失敗しました\n\n${err.error || res.statusText}`)
      }
    } catch (e) {
      alert(`❌ 通信エラー: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F1F2F5]">
        <div className="text-hibi-charcoal text-lg font-bold">読み込み中...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F1F2F5] p-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 text-center max-w-sm w-full">
          <div className="text-red-500 text-lg font-bold mb-2">エラー</div>
          <div className="text-gray-700">{error}</div>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="min-h-screen bg-[#F1F2F5]">
      {/* Header */}
      <div className="bg-hibi-charcoal text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-sm opacity-70">職長</div>
          <div className="text-lg sm:text-xl font-bold truncate">{data.foreman.name}</div>
          <div className="text-sm opacity-80 mt-1 truncate">{data.site.name}</div>
        </div>
      </div>

      {/* Date nav */}
      <div className="bg-white border-b px-3 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <button
            onClick={() => navDay(-1)}
            className="px-3 py-2 bg-white border-2 border-gray-300 text-hibi-charcoal rounded-lg text-sm font-bold active:bg-gray-100 shrink-0"
          >
            ◀ 前日
          </button>
          <div className="text-center min-w-0">
            <div className="text-sm sm:text-base font-bold text-hibi-charcoal tabular-nums truncate">{data.date.dateLabel}</div>
          </div>
          <button
            onClick={() => navDay(1)}
            disabled={isToday}
            className="px-3 py-2 bg-white border-2 border-gray-300 text-hibi-charcoal rounded-lg text-sm font-bold active:bg-gray-100 disabled:opacity-30 shrink-0"
          >
            翌日 ▶
          </button>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* 未入力の警告（2026-08-28 追加: 未入力＝欠勤扱いを明記） */}
        {data.summary.noneCount > 0 && (
          <div className="bg-red-50 border-2 border-red-200 rounded-xl p-3">
            <div className="text-sm font-bold text-red-700">
              ⚠️ この日は {data.summary.noneCount}名 が未入力です
            </div>
            <div className="text-xs text-red-600 mt-1">
              未入力のままだと<b>欠勤扱い</b>になります。本人にスマホ入力を促してください。
            </div>
          </div>
        )}

        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 text-center">
            <div className="text-2xl font-extrabold text-blue-700 tabular-nums">{data.summary.workCount}</div>
            <div className="text-xs text-gray-600 font-bold">出勤</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 text-center">
            <div className="text-2xl font-extrabold text-red-600 tabular-nums">{data.summary.noneCount}</div>
            <div className="text-xs text-gray-600 font-bold">未入力</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 text-center">
            <div className="text-2xl font-extrabold text-hibi-charcoal tabular-nums">{data.summary.totalCount}</div>
            <div className="text-xs text-gray-600 font-bold">全員</div>
          </div>
        </div>

        {/* Approve button */}
        <button
          onClick={handleApprove}
          disabled={data.approved || saving}
          className={`w-full rounded-xl py-4 text-base transition ${
            data.approved
              ? 'bg-[#1E9E52] text-white font-bold'
              : 'bg-hibi-amber text-hibi-charcoal font-extrabold shadow-[0_4px_12px_rgba(245,166,35,0.4)] active:bg-hibi-amberDark'
          } disabled:opacity-70`}
        >
          {data.approved ? '✅ 確認済み' : '✅ この日を確認する'}
        </button>

        {/* まとめ承認（2026-08-28 追加）: 全員入力済み・未確認の稼働日だけ */}
        {bulkTargets.length > 0 && (
          <button
            onClick={handleBulkApprove}
            disabled={bulkApproving}
            className="w-full rounded-xl py-3 text-sm font-bold bg-white border-2 border-hibi-amber text-hibi-charcoal active:bg-amber-50 disabled:opacity-50"
          >
            {bulkApproving
              ? '確認中...'
              : `⚡ 入力がそろった ${bulkTargets.length}日分をまとめて確認する`}
          </button>
        )}

        {/* Worker list */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {data.workers.length === 0 ? (
            <div className="p-4 text-center text-gray-400">スタッフがいません</div>
          ) : (
            data.workers.map(w => {
              // ベトナム人スタッフのスマホ入力待ち（2026-05-08 ルール）:
              //   スタッフ本人が入力するまで、職長は手入力できない。
              //   既存エントリがある場合のみクリックして修正可能。
              const awaitingStaff = !w.entry
              const misplaced = w.misplacedEntries || []
              const hasMisplaced = misplaced.length > 0

              // 自現場にエントリなし + 別現場で入力済み → 現場違い警告
              if (awaitingStaff && hasMisplaced) {
                return (
                  <div
                    key={w.id}
                    className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 last:border-0 bg-orange-50 cursor-pointer active:bg-orange-100"
                    onClick={() => setFixingSite({ workerId: w.id, workerName: w.name, misplaced })}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 truncate">{w.name}</div>
                      <div className="text-[11px] text-orange-700 mt-0.5 truncate">
                        ⚠️ {misplaced.map(m => m.siteName).join('・')} で入力されています
                      </div>
                    </div>
                    <span className="text-xs px-2 py-1 rounded-full font-bold whitespace-nowrap shrink-0 bg-orange-200 text-orange-800">
                      🔄 修正
                    </span>
                  </div>
                )
              }

              return awaitingStaff ? (
                <div
                  key={w.id}
                  className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 last:border-0 active:bg-gray-50 cursor-pointer"
                  title="現場都合休み・有給などは職長が代理入力できます"
                  onClick={() => openEditor(w)}
                >
                  <span className="text-sm font-medium text-gray-700 truncate min-w-0">{w.name}</span>
                  <span className="text-xs px-2 py-1 rounded-full font-bold whitespace-nowrap shrink-0 bg-gray-100 text-gray-500">
                    📱 スマホ入力待ち
                  </span>
                </div>
              ) : (
                <div
                  key={w.id}
                  className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 last:border-0 active:bg-gray-50 cursor-pointer"
                  onClick={() => openEditor(w)}
                >
                  <span className="text-sm font-medium text-gray-800 truncate min-w-0">{w.name}</span>
                  <span className={`text-xs px-2 py-1 rounded-full font-bold whitespace-nowrap shrink-0 ${STATUS_COLORS[w.status]}`}>
                    {STATUS_EMOJI[w.status]} {STATUS_LABELS[w.status]}
                    {w.status === 'overtime' && w.entry?.o ? ` +${w.entry.o}h` : ''}
                  </span>
                </div>
              )
            })
          )}
        </div>

        {/* 職長自身の有給・道具代はマイページへ（2026-08-28 追加） */}
        <a href={`/mypage/${token}`}
          className="block bg-white rounded-xl border border-gray-200 shadow-sm p-4 active:bg-gray-50">
          <div className="flex items-center gap-3">
            <span className="text-xl">🌴</span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-bold text-hibi-charcoal">自分の有給・道具代</span>
              <span className="block text-xs text-gray-500">有給の申請と残数、道具代の残額</span>
            </span>
            <span className="text-gray-300">›</span>
          </div>
        </a>

        {/* 月の俯瞰（2026-08-28 追加: 過去2日制限を撤廃し、月内のどの日でも開ける） */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1 font-bold">
            {data.date.month}月の確認状況
          </div>
          <div className="text-[11px] text-gray-400 mb-3">
            日付をタップするとその日を開けます
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {data.monthOverview.map(o => {
              const isCurrent = o.dateISO === data.date.dateISO
              const missing = o.missingNames.length
              let cls: string
              let mark: string
              if (!o.isWorkDay) { cls = 'bg-gray-100 text-gray-300'; mark = '休' }
              else if (o.approved) { cls = 'bg-[#1E9E52] text-white'; mark = '✓' }
              else if (missing > 0) { cls = 'bg-red-50 text-red-600 border border-red-200'; mark = `残${missing}` }
              else if (o.entered > 0) { cls = 'bg-amber-100 text-amber-800 border border-amber-300'; mark = '未確認' }
              else { cls = 'bg-gray-100 text-gray-400'; mark = '—' }
              return (
                <button
                  key={o.day}
                  onClick={() => setDateISO(o.dateISO)}
                  className={`rounded-lg py-1.5 text-center active:scale-95 ${cls} ${
                    isCurrent ? 'ring-2 ring-hibi-charcoal' : ''
                  }`}
                >
                  <div className="text-sm font-bold tabular-nums leading-tight">{o.day}</div>
                  <div className="text-[9px] font-bold leading-tight whitespace-nowrap overflow-hidden">{mark}</div>
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[10px] text-gray-500">
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#1E9E52] align-middle mr-1" />確認済み</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 align-middle mr-1" />入力そろい・未確認</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-100 align-middle mr-1" />未入力あり（欠勤扱いに）</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200 align-middle mr-1" />非稼働日</span>
          </div>
        </div>
      </div>

      {/* Edit worker modal */}
      {editingWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setEditingWorker(null)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg px-4 sm:px-6 pt-5 pb-[env(safe-area-inset-bottom,8px)]" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
            <h3 className="text-lg font-bold text-hibi-charcoal mb-1 text-center truncate">{editingWorker.name}</h3>
            <p className="text-sm text-gray-500 mb-4 text-center">{data.date.dateLabel}</p>

            {/* スタッフ未入力時のヒント（待機中行から開いた場合） */}
            {!editingWorker.hasEntry && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-xs text-yellow-800 font-medium mb-1">
                  💡 スタッフ未入力の状態です
                </p>
                <p className="text-xs text-yellow-700">
                  「現場都合休み」「有給」のみ職長が代理入力できます。出勤・休みは
                  スタッフ本人のスマホ入力をお待ちください。
                </p>
              </div>
            )}

            {/* 2026-06-XX: 現場都合休み (補償日 0.6) を追加 → 4ボタンの 2x2 グリッド */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-4">
              {([
                { choice: 'work', emoji: '🔨', label: '出勤', color: 'bg-blue-500', requiresEntry: true },
                { choice: 'rest', emoji: '🏠', label: '休み', color: 'bg-gray-400', requiresEntry: true },
                { choice: 'leave', emoji: '🌴', label: '有給', color: 'bg-green-500', requiresEntry: false },
                { choice: 'comp', emoji: '🚧', label: '現場都合休み', color: 'bg-yellow-500', requiresEntry: false },
              ] as const).map(btn => {
                const disabled = saving || (btn.requiresEntry && !editingWorker.hasEntry)
                return (
                  <button
                    key={btn.choice}
                    onClick={() => handleEdit(btn.choice)}
                    disabled={disabled}
                    title={disabled && !saving ? 'スタッフ本人のスマホ入力後に変更できます' : undefined}
                    className={`${btn.color} text-white rounded-xl py-3 sm:py-4 text-center active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed`}
                  >
                    <div className="text-xl sm:text-2xl mb-1">{btn.emoji}</div>
                    <div className="text-xs sm:text-sm font-bold">{btn.label}</div>
                  </button>
                )
              })}
            </div>

            {/* 出勤時刻＋休憩（2026-08-28: 時刻なし残業ステッパーから置き換え。
                スタッフのスマホ入力と同じ形式で保存され、残業は時刻から自動計算される） */}
            <div className="bg-gray-50 rounded-xl p-3 mb-4">
              <div className="text-xs text-gray-500 text-center mb-2">
                勤務時刻（「出勤」で保存する内容・残業は自動計算）
              </div>
              <div className="flex items-center justify-center gap-2 mb-3">
                <input
                  type="time"
                  value={editStart}
                  onChange={e => setEditStart(e.target.value)}
                  className="border-2 border-gray-300 rounded-lg px-2 py-2 text-base font-bold tabular-nums bg-white"
                />
                <span className="text-gray-400 font-bold">〜</span>
                <input
                  type="time"
                  value={editEnd}
                  onChange={e => setEditEnd(e.target.value)}
                  className="border-2 border-gray-300 rounded-lg px-2 py-2 text-base font-bold tabular-nums bg-white"
                />
              </div>
              <div className="flex items-center justify-center gap-3">
                {([
                  { label: '午前休憩', v: editB1, set: setEditB1, s: data.schedule?.morningBreak },
                  { label: '昼休憩', v: editB2, set: setEditB2, s: data.schedule?.lunchBreak },
                  { label: '午後休憩', v: editB3, set: setEditB3, s: data.schedule?.afternoonBreak },
                ] as const).map(b => (
                  (b.s?.enabled ?? true) && (
                    <label key={b.label} className="flex items-center gap-1 text-xs text-gray-600 font-medium">
                      <input
                        type="checkbox"
                        checked={b.v}
                        disabled={!!b.s?.mandatory}
                        onChange={e => b.set(e.target.checked)}
                        className="w-4 h-4"
                      />
                      {b.label}{b.s ? `(${b.s.minutes}分)` : ''}
                    </label>
                  )
                ))}
              </div>
            </div>

            <button
              onClick={() => setEditingWorker(null)}
              className="w-full bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl py-3 text-sm font-bold active:bg-gray-100"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 現場違い修正モーダル */}
      {fixingSite && data && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setFixingSite(null)}>
          <div
            className="bg-white rounded-t-2xl w-full max-w-lg px-4 sm:px-6 pt-5 pb-[env(safe-area-inset-bottom,8px)]"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}
          >
            <h3 className="text-lg font-bold text-hibi-charcoal mb-1 text-center truncate">
              {fixingSite.workerName} さん
            </h3>
            <p className="text-sm text-gray-500 mb-4 text-center">{data.date.dateLabel} の現場違い修正</p>

            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-orange-800 font-medium mb-1">
                ⚠️ 別現場で入力されています
              </p>
              <p className="text-xs text-orange-700">
                スタッフがスマホで違う現場を選んだ可能性があります。<br />
                正しい現場（こちら：<strong>{data.site.name}</strong>）に移動できます。
              </p>
            </div>

            <div className="space-y-2 mb-4">
              {fixingSite.misplaced.map(m => {
                const statusText = m.entry.p ? '🌴 有給'
                  : m.entry.r ? '🏠 休み'
                  : m.entry.h ? '🚧 現場休み'
                  : m.entry.hk ? '✈️ 帰国中'
                  : m.entry.exam ? '📝 試験'
                  : m.entry.w ? (m.entry.o && m.entry.o > 0 ? `⏰ 出勤 +${m.entry.o}h` : '🔨 出勤')
                  : '❓ 不明'
                return (
                  <div key={m.siteId} className="border-2 border-orange-300 rounded-xl p-3 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="text-xs text-gray-500">入力された現場</div>
                        <div className="text-base font-bold text-gray-900">{m.siteName}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-gray-500">状態</div>
                        <div className="text-sm font-medium">{statusText}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleFixSite(m.siteId)}
                      disabled={saving}
                      className="w-full bg-orange-500 text-white rounded-lg py-3 font-bold text-sm active:scale-95 disabled:opacity-50"
                    >
                      🔄 {data.site.name} に移動する
                    </button>
                  </div>
                )
              })}
            </div>

            <button
              onClick={() => setFixingSite(null)}
              disabled={saving}
              className="w-full bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl py-3 font-bold text-sm active:bg-gray-100 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
