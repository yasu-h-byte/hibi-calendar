'use client'

import { useEffect, useState, useCallback } from 'react'
import CalendarEditor from '@/components/CalendarEditor'
import { AuthUser, DayType, CalendarStatus } from '@/types'
import { getNextMonth, generateDefaultDays } from '@/lib/calendar'

interface SiteCalendarData {
  siteId: string
  siteName: string
  days: Record<string, DayType> | null
  status: CalendarStatus | null
  submittedBy: number | null
  approvedBy: number | null
  rejectedReason: string | null
  workers: { id: number; name: string; signed: boolean; signedAt: string | null }[]
}

export default function CalendarManagePage() {
  const { year, month, ym: defaultYm } = getNextMonth()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [password, setPassword] = useState('')
  const [sites, setSites] = useState<SiteCalendarData[]>([])
  const [ym, setYm] = useState(defaultYm)
  const [loading, setLoading] = useState(true)
  const [expandedSite, setExpandedSite] = useState<string | null>(null)
  const [editingDays, setEditingDays] = useState<Record<string, Record<string, DayType>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [rejectSiteId, setRejectSiteId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [copiedMsg, setCopiedMsg] = useState(false)

  const [y, m] = ym.split('-').map(Number)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw, user: u } = JSON.parse(stored)
      setUser(u)
      setPassword(pw)
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch(`/api/calendar/status?ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setSites(data.sites || [])
      }
    } catch (error) {
      console.error('Failed to fetch:', error)
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const getEditDays = (siteId: string, currentDays: Record<string, DayType> | null) => {
    if (editingDays[siteId]) return editingDays[siteId]
    return currentDays || generateDefaultDays(y, m)
  }

  const handleDaysChange = (siteId: string, days: Record<string, DayType>) => {
    setEditingDays(prev => ({ ...prev, [siteId]: days }))
  }

  const handleSave = async (siteId: string) => {
    const days = editingDays[siteId]
    if (!days || !user) return
    setSaving(siteId)
    try {
      await fetch('/api/calendar/save-days', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, ym, days, updatedBy: user.workerId }),
      })
      setEditingDays(prev => { const n = { ...prev }; delete n[siteId]; return n })
      fetchData()
    } finally {
      setSaving(null)
    }
  }

  const handleSubmit = async (siteId: string) => {
    if (!user || !confirm('このカレンダーを提出しますか？')) return
    // Save first if there are unsaved changes
    if (editingDays[siteId]) await handleSave(siteId)
    await fetch('/api/calendar/submit', {
      method: 'POST',
      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, ym, submittedBy: user.workerId }),
    })
    fetchData()
  }

  const handleApprove = async (siteId: string) => {
    if (!user || !confirm('このカレンダーを承認しますか？')) return
    await fetch('/api/calendar/approve', {
      method: 'POST',
      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, ym, approvedBy: user.workerId }),
    })
    fetchData()
  }

  const handleReject = async () => {
    if (!user || !rejectSiteId) return
    await fetch('/api/calendar/reject', {
      method: 'POST',
      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: rejectSiteId, ym, rejectedBy: user.workerId, reason: rejectReason }),
    })
    setRejectSiteId(null)
    setRejectReason('')
    fetchData()
  }

  const copyMessage = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    const msg = `📅 Lịch làm việc tháng ${m}/${y}
HIBI CONSTRUCTION

Vui lòng xác nhận và ký:
${baseUrl}/calendar/public

👆 Chọn công trường → Chọn tên → Xem lịch → Ký

就業カレンダー ${y}年${m}月
上のリンクから現場を選んで署名してください`
    navigator.clipboard.writeText(msg).then(() => {
      setCopiedMsg(true)
      setTimeout(() => setCopiedMsg(false), 2000)
    })
  }

  // Filter sites based on role
  const visibleSites = user?.role === 'foreman'
    ? sites.filter(s => user.foremanSites.includes(s.siteId))
    : sites

  // Status badge
  const statusBadge = (status: CalendarStatus | null) => {
    if (!status || status === 'draft') return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">下書き</span>
    if (status === 'submitted') return <span className="bg-yellow-100 text-yellow-700 text-xs font-bold px-2 py-0.5 rounded-full">承認待ち</span>
    if (status === 'approved') return <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">承認済み</span>
    if (status === 'rejected') return <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">差し戻し</span>
    return null
  }

  const canEdit = (site: SiteCalendarData) => {
    if (!user) return false
    if (site.status === 'approved') return false
    if (site.status === 'submitted' && user.role === 'foreman') return false
    if (user.role === 'foreman' && !user.foremanSites.includes(site.siteId)) return false
    return true
  }

  const canSubmit = (site: SiteCalendarData) => {
    if (!user) return false
    if (site.status === 'submitted' || site.status === 'approved') return false
    if (user.role === 'foreman') return user.foremanSites.includes(site.siteId)
    return user.role === 'admin'
  }

  const canApprove = (site: SiteCalendarData) => {
    if (!user) return false
    if (site.status !== 'submitted') return false
    return user.role === 'approver' || user.role === 'admin'
  }

  // Ym options
  const ymOptions: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    ymOptions.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // Summary
  const approvedCount = visibleSites.filter(s => s.status === 'approved').length
  const submittedCount = visibleSites.filter(s => s.status === 'submitted').length
  const totalWorkers = visibleSites.reduce((sum, s) => sum + s.workers.length, 0)
  const signedWorkers = visibleSites.reduce((sum, s) => sum + s.workers.filter(w => w.signed).length, 0)

  if (!user) return null

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">就業カレンダー</h1>
          <p className="text-sm text-gray-500 mt-1">
            {user.role === 'foreman' ? '担当現場のカレンダー管理' : '全現場のカレンダー管理'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            {ymOptions.map(o => (
              <option key={o} value={o}>{o.replace('-', '年')}月</option>
            ))}
          </select>
          {user.role !== 'foreman' && (
            <button
              onClick={copyMessage}
              className={`px-4 py-2 rounded-lg text-sm transition ${
                copiedMsg ? 'bg-green-500 text-white' : 'bg-purple-600 text-white hover:bg-purple-700'
              }`}
            >
              {copiedMsg ? '✓ コピー済み' : '📋 送信文コピー'}
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-hibi-navy">{visibleSites.length}</div>
          <div className="text-xs text-gray-500">現場</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-yellow-600">{submittedCount}</div>
          <div className="text-xs text-gray-500">承認待ち</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{approvedCount}</div>
          <div className="text-xs text-gray-500">承認済み</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{signedWorkers}/{totalWorkers}</div>
          <div className="text-xs text-gray-500">署名</div>
        </div>
      </div>

      {/* Site cards */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">読み込み中...</div>
      ) : visibleSites.length === 0 ? (
        <div className="text-center py-8 text-gray-400">現場データがありません</div>
      ) : (
        <div className="space-y-4">
          {/* Show submitted sites first for approvers */}
          {[...visibleSites].sort((a, b) => {
            if (a.status === 'submitted' && b.status !== 'submitted') return -1
            if (b.status === 'submitted' && a.status !== 'submitted') return 1
            return 0
          }).map(site => {
            const isExpanded = expandedSite === site.siteId
            const signedCount = site.workers.filter(w => w.signed).length
            const days = getEditDays(site.siteId, site.days)
            const hasUnsaved = !!editingDays[site.siteId]

            return (
              <div key={site.siteId} className="bg-white rounded-xl shadow overflow-hidden">
                {/* Site header */}
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                  onClick={() => setExpandedSite(isExpanded ? null : site.siteId)}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-hibi-navy">{site.siteName}</h3>
                      {statusBadge(site.status)}
                      {hasUnsaved && <span className="text-orange-500 text-xs">● 未保存</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {signedCount}/{site.workers.length}名 署名済み
                    </div>
                    {site.rejectedReason && site.status === 'rejected' && (
                      <div className="text-xs text-red-500 mt-1">差し戻し理由: {site.rejectedReason}</div>
                    )}
                  </div>
                  <svg
                    className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="border-t px-4 pb-4 space-y-4">
                    {/* Calendar editor */}
                    <div className="pt-4">
                      <CalendarEditor
                        year={y}
                        month={m}
                        days={days}
                        onChange={d => handleDaysChange(site.siteId, d)}
                        readOnly={!canEdit(site)}
                      />
                    </div>

                    {/* Working hours note */}
                    <div className="bg-blue-50 rounded-lg p-3 text-sm">
                      就業時間: 8:00〜16:30（休憩2時間）
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap gap-2">
                      {canEdit(site) && (
                        <>
                          <button
                            onClick={() => handleSave(site.siteId)}
                            disabled={!hasUnsaved || saving === site.siteId}
                            className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition disabled:opacity-50"
                          >
                            {saving === site.siteId ? '保存中...' : '保存'}
                          </button>
                          {canSubmit(site) && (
                            <button
                              onClick={() => handleSubmit(site.siteId)}
                              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition"
                            >
                              提出する
                            </button>
                          )}
                        </>
                      )}
                      {canApprove(site) && (
                        <>
                          <button
                            onClick={() => handleApprove(site.siteId)}
                            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 transition"
                          >
                            承認
                          </button>
                          <button
                            onClick={() => setRejectSiteId(site.siteId)}
                            className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-red-600 transition"
                          >
                            差し戻し
                          </button>
                        </>
                      )}
                    </div>

                    {/* Worker signature list */}
                    {site.workers.length > 0 && (
                      <div>
                        <h4 className="text-sm font-bold text-gray-600 mb-2">署名状況</h4>
                        <div className="space-y-1">
                          {site.workers.map(w => (
                            <div key={w.id} className="flex items-center justify-between text-sm py-1 border-b border-gray-100">
                              <span>{w.name}</span>
                              {w.signed ? (
                                <span className="text-green-600 text-xs">✓ {w.signedAt && new Date(w.signedAt).toLocaleDateString('ja-JP')}</span>
                              ) : site.status === 'approved' ? (
                                <span className="text-yellow-600 text-xs">未署名</span>
                              ) : (
                                <span className="text-gray-400 text-xs">—</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Reject modal */}
      {rejectSiteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRejectSiteId(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">差し戻し理由</h3>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="理由を入力してください（任意）"
              className="w-full border border-gray-300 rounded-lg p-3 mb-4 text-sm"
              rows={3}
            />
            <div className="flex gap-2">
              <button
                onClick={handleReject}
                className="flex-1 bg-red-500 text-white rounded-lg py-2 text-sm hover:bg-red-600 transition"
              >
                差し戻す
              </button>
              <button
                onClick={() => { setRejectSiteId(null); setRejectReason('') }}
                className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2 text-sm hover:bg-gray-300 transition"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
