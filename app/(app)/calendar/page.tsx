'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import CalendarEditor from '@/components/CalendarEditor'
import { AuthUser, DayType, CalendarStatus } from '@/types'
import { getNextMonth, generateDefaultDays, getHoliday } from '@/lib/calendar'

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

function DaySummary({ days, year, month }: { days: Record<string, DayType>; year: number; month: number }) {
  // 実データの 'off'/'holiday' 状態に依存せず、暦と祝日カレンダーから真の分類を導出
  // （データ不整合があっても表示が正しくなる：祝日に登録された日は必ず祝日カウント）
  const breakdown = useMemo(() => {
    const daysInMonth = new Date(year, month, 0).getDate()
    let work = 0
    let restSunday = 0   // 日曜（祝日でない）
    let restHoliday = 0  // 祝日（曜日問わず）
    let restOther = 0    // その他（土曜任意休み等）
    for (let d = 1; d <= daysInMonth; d++) {
      const dayType = days[String(d)] || 'work'
      if (dayType === 'work') {
        work++
        continue
      }
      // 休み: jpn祝日カレンダー → 日曜 → その他 の優先順
      const isJpnHoliday = !!getHoliday(year, month, d)
      const dow = new Date(year, month - 1, d).getDay()
      if (isJpnHoliday) restHoliday++
      else if (dow === 0) restSunday++
      else restOther++
    }
    const restTotal = restSunday + restHoliday + restOther
    return { work, restTotal, restSunday, restHoliday, restOther }
  }, [days, year, month])

  const legalLimit = useMemo(() => {
    const daysInMonth = new Date(year, month, 0).getDate()
    const limitHours = daysInMonth * 40 / 7
    const maxDays = Math.floor(limitHours / 7)
    const prescribedHours = breakdown.work * 7
    const exceeds = prescribedHours > limitHours
    return { daysInMonth, limitHours, maxDays, prescribedHours, exceeds }
  }, [year, month, breakdown.work])

  return (
    <div className="space-y-1">
      {/* メイン: 出勤 / 休み の合計 */}
      <div className="flex items-center gap-4 text-sm bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2 flex-wrap">
        <span className="text-blue-600 dark:text-blue-400 font-medium">出勤 {breakdown.work}日</span>
        <span className="text-gray-500 dark:text-gray-400">休み {breakdown.restTotal}日</span>
        {breakdown.restTotal > 0 && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            （内訳：
            {breakdown.restSunday > 0 && <span>日曜 {breakdown.restSunday}日</span>}
            {breakdown.restSunday > 0 && (breakdown.restHoliday > 0 || breakdown.restOther > 0) && ' / '}
            {breakdown.restHoliday > 0 && <span className="text-red-500 dark:text-red-400">祝日 {breakdown.restHoliday}日</span>}
            {breakdown.restHoliday > 0 && breakdown.restOther > 0 && ' / '}
            {breakdown.restOther > 0 && <span>その他 {breakdown.restOther}日</span>}
            ）
          </span>
        )}
      </div>
      <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
        legalLimit.exceeds
          ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-bold'
          : 'bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400'
      }`}>
        {legalLimit.exceeds && (
          <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        )}
        <span>
          出勤{breakdown.work}日 ({legalLimit.prescribedHours}h) / 上限{legalLimit.maxDays}日 ({(Math.round(legalLimit.limitHours * 10) / 10).toFixed(1)}h)
        </span>
        {legalLimit.exceeds && <span>- 法定上限超過！</span>}
      </div>
    </div>
  )
}

export default function CalendarManagePage() {
  const { year, month, ym: defaultYm } = getNextMonth()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [password, setPassword] = useState('')
  const [sites, setSites] = useState<SiteCalendarData[]>([])
  const [ym, setYm] = useState(defaultYm)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingDays, setEditingDays] = useState<Record<string, Record<string, DayType>>>({})
  const [saving, setSaving] = useState(false)
  const [copiedMsg, setCopiedMsg] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)

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
    setError('')
    try {
      const res = await fetch(`/api/calendar/status?ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setSites(data.sites || [])
      } else {
        setError('データの取得に失敗しました')
      }
    } catch (err) {
      console.error('Failed to fetch:', err)
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Reset editingDays when ym changes
  useEffect(() => {
    setEditingDays({})
  }, [ym])

  const getEditDays = (siteId: string, currentDays: Record<string, DayType> | null) => {
    if (editingDays[siteId]) return editingDays[siteId]
    return currentDays || generateDefaultDays(y, m)
  }

  const handleDaysChange = (siteId: string, days: Record<string, DayType>) => {
    setEditingDays(prev => ({ ...prev, [siteId]: days }))
  }

  const handleBulkConfirm = async () => {
    if (!user) return
    setSaving(true)
    setShowConfirmDialog(false)
    try {
      // Build the payload with current days for each site
      const payload = visibleSites.map(site => ({
        siteId: site.siteId,
        days: getEditDays(site.siteId, site.days),
      }))

      const res = await fetch('/api/calendar/bulk-confirm', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ym, sites: payload, approvedBy: user.workerId }),
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.error || '確定に失敗しました')
        return
      }

      setEditingDays({})
      fetchData()
    } catch (error) {
      console.error('Failed to bulk confirm:', error)
      alert('確定に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const copyMessage = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    const calUrl = `${baseUrl}/calendar/public?ym=${ym}`
    const msg = `HIBI CONSTRUCTION
Lich lam viec thang ${m}/${y}
就業カレンダー ${y}年${m}月

${calUrl}

Chon ten -> Xem lich -> Ky
名前を選んで → カレンダー確認 → 署名`
    navigator.clipboard.writeText(msg).then(() => {
      setCopiedMsg(true)
      setTimeout(() => setCopiedMsg(false), 2000)
    })
  }

  // 全ロールで全現場を表示（職長も全現場のカレンダーを見れる）
  const visibleSites = user?.role === 'foreman'
    ? sites
    : sites

  // Status badge (simplified: only 未作成 or 確定済み)
  const statusBadge = (site: SiteCalendarData) => {
    if (site.status === 'approved') {
      return <span className="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 text-xs font-bold px-2 py-0.5 rounded-full">承認済み</span>
    }
    if (site.status === 'submitted') {
      return <span className="bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300 text-xs font-bold px-2 py-0.5 rounded-full">提出済み（承認待ち）</span>
    }
    return <span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">未作成</span>
  }

  // Ym options
  const ymOptions: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    ymOptions.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // Signature summary
  const totalWorkers = visibleSites.reduce((sum, s) => sum + s.workers.length, 0)
  const signedWorkers = visibleSites.reduce((sum, s) => sum + s.workers.filter(w => w.signed).length, 0)
  const unsignedWorkers = visibleSites.flatMap(s =>
    s.workers.filter(w => !w.signed).map(w => ({ name: w.name, siteName: s.siteName }))
  )

  // Check if any site has legal limit exceeded
  const hasLegalExceed = visibleSites.some(site => {
    const days = getEditDays(site.siteId, site.days)
    const workCount = Object.values(days).filter(d => d === 'work').length
    const daysInMonth = new Date(y, m, 0).getDate()
    const limitHours = daysInMonth * 40 / 7
    return workCount * 7 > limitHours
  })

  const allApproved = visibleSites.length > 0 && visibleSites.every(s => s.status === 'approved')

  if (!user) return null

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">就業カレンダー</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {user.role === 'foreman' ? '担当現場のカレンダー管理' : '全現場のカレンダー管理'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white"
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

      {/* Site calendars - all expanded */}
      {loading ? (
        <div className="text-center py-8 text-gray-400 dark:text-gray-500">読み込み中...</div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center text-red-700">{error}</div>
      ) : visibleSites.length === 0 ? (
        <div className="text-center py-8 text-gray-400 dark:text-gray-500">現場データがありません</div>
      ) : (
        <div className="space-y-6">
          {visibleSites.map(site => {
            const days = getEditDays(site.siteId, site.days)
            const isApproved = site.status === 'approved'
            const isSubmitted = site.status === 'submitted'
            const isReadOnly = isApproved || (isSubmitted && user.role === 'foreman')

            return (
              <div key={site.siteId} className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
                {/* Site header */}
                <div className="p-4 border-b dark:border-gray-700 flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-hibi-navy dark:text-white">{site.siteName}</h3>
                    {statusBadge(site)}
                  </div>
                </div>

                {/* Calendar editor */}
                <div className="px-4 pt-4">
                  <CalendarEditor
                    year={y}
                    month={m}
                    days={days}
                    onChange={d => handleDaysChange(site.siteId, d)}
                    readOnly={isReadOnly}
                  />
                </div>

                {/* Day-type summary + legal limit */}
                <div className="px-4 pb-4 pt-2 space-y-2">
                  <DaySummary days={days} year={y} month={m} />
                  <div className="bg-blue-50 dark:bg-blue-900/20 dark:text-blue-200 rounded-lg p-3 text-sm">
                    就業時間: 8:00〜17:00（休憩2時間）
                  </div>

                  {/* Per-site action buttons — role-based */}
                  {(() => {
                    const isSubmitted = site.status === 'submitted'
                    const canSubmit = !isApproved && !isSubmitted  // 職長: まだ提出していない
                    const canApprove = isSubmitted && (user.role === 'admin' || user.role === 'approver')  // 上長: 提出済みを承認
                    const canForceApprove = !isApproved && !isSubmitted && (user.role === 'admin')  // 管理者: 直接承認

                    const exceedsLimit = (() => {
                      const workCount = Object.values(days).filter(d => d === 'work').length
                      const daysInMonth = new Date(y, m, 0).getDate()
                      return workCount * 7 > daysInMonth * 40 / 7
                    })()

                    return (
                      <>
                        {/* 職長: 提出ボタン */}
                        {canSubmit && (
                          <button
                            onClick={async () => {
                              if (!confirm(`${site.siteName} のカレンダーを提出しますか？`)) return
                              setSaving(true)
                              try {
                                // まず日付を保存
                                await fetch('/api/calendar/save-days', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                  body: JSON.stringify({ siteId: site.siteId, ym, days, updatedBy: user?.workerId || 0 }),
                                })
                                // 提出
                                const res = await fetch('/api/calendar/submit', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                  body: JSON.stringify({ siteId: site.siteId, ym, submittedBy: user?.workerId || 0 }),
                                })
                                if (!res.ok) {
                                  const data = await res.json()
                                  alert(data.error || '提出に失敗しました')
                                } else {
                                  setEditingDays(prev => { const next = { ...prev }; delete next[site.siteId]; return next })
                                  fetchData()
                                }
                              } catch { alert('提出に失敗しました') }
                              finally { setSaving(false) }
                            }}
                            disabled={saving || exceedsLimit}
                            className="w-full bg-blue-600 text-white py-4 rounded-lg text-base font-bold hover:bg-blue-700 transition disabled:opacity-50 min-h-[48px]"
                          >
                            {saving ? '提出中...' : `📋 ${site.siteName} を提出する`}
                          </button>
                        )}

                        {/* 提出済み表示（職長向け） */}
                        {isSubmitted && user.role === 'foreman' && (
                          <div className="text-center text-yellow-600 dark:text-yellow-400 text-sm font-bold py-2">
                            📋 提出済み — 承認待ち
                          </div>
                        )}

                        {/* approver/admin: 提出取消しボタン */}
                        {isSubmitted && user.role !== 'foreman' && (
                          <button
                            onClick={async () => {
                              if (!confirm(`${site.siteName} の提出を取消しますか？\n職長が再編集できるようになります。`)) return
                              setSaving(true)
                              try {
                                const res = await fetch('/api/calendar/revert', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                  body: JSON.stringify({ siteId: site.siteId, ym, action: 'unsubmit', revertedBy: user?.workerId || 0 }),
                                })
                                if (res.ok) { fetchData() }
                                else { const d = await res.json(); alert(d.error || '取消しに失敗しました') }
                              } catch { alert('取消しに失敗しました') }
                              finally { setSaving(false) }
                            }}
                            disabled={saving}
                            className="w-full text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 py-2 rounded-lg text-xs hover:bg-yellow-100 transition disabled:opacity-50"
                          >
                            ↩ 提出を取消す（職長に差戻し）
                          </button>
                        )}

                        {/* approver/admin: 承認ボタン */}
                        {canApprove && (
                          <button
                            onClick={async () => {
                              if (!confirm(`${site.siteName} のカレンダーを承認しますか？`)) return
                              setSaving(true)
                              try {
                                const res = await fetch('/api/calendar/approve', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                  body: JSON.stringify({ siteId: site.siteId, ym, approvedBy: user?.workerId || 0 }),
                                })
                                if (!res.ok) {
                                  const data = await res.json()
                                  alert(data.error || '承認に失敗しました')
                                } else {
                                  fetchData()
                                }
                              } catch { alert('承認に失敗しました') }
                              finally { setSaving(false) }
                            }}
                            disabled={saving}
                            className="w-full bg-green-600 text-white py-4 rounded-lg text-base font-bold hover:bg-green-700 transition disabled:opacity-50 min-h-[48px]"
                          >
                            {saving ? '承認中...' : `✅ ${site.siteName} を承認する`}
                          </button>
                        )}

                        {/* admin: 直接確定ボタン（提出を飛ばして承認） */}
                        {canForceApprove && (
                          <button
                            onClick={async () => {
                              if (!confirm(`${site.siteName} のカレンダーを直接承認しますか？（提出を省略）`)) return
                              setSaving(true)
                              try {
                                const res = await fetch('/api/calendar/bulk-confirm', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                  body: JSON.stringify({
                                    ym,
                                    sites: [{ siteId: site.siteId, days }],
                                    approvedBy: user?.workerId || 0,
                                  }),
                                })
                                if (!res.ok) {
                                  const data = await res.json()
                                  alert(data.error || '確定に失敗しました')
                                } else {
                                  setEditingDays(prev => { const next = { ...prev }; delete next[site.siteId]; return next })
                                  fetchData()
                                }
                              } catch { alert('確定に失敗しました') }
                              finally { setSaving(false) }
                            }}
                            disabled={saving || exceedsLimit}
                            className="w-full bg-gray-500 text-white py-3 rounded-lg text-sm hover:bg-gray-600 transition disabled:opacity-50 min-h-[44px]"
                          >
                            {saving ? '確定中...' : '管理者: 直接承認'}
                          </button>
                        )}

                        {/* 承認済み */}
                        {isApproved && (
                          <div className="space-y-2">
                            <div className="text-center text-green-600 dark:text-green-400 text-sm font-bold py-2">
                              ✅ 承認済み
                            </div>
                            {/* approver/admin: 承認取消しボタン */}
                            {user.role !== 'foreman' && (
                              <button
                                onClick={async () => {
                                  if (!confirm(`${site.siteName} の承認を取消しますか？\n署名データも削除され、再承認後に再署名が必要になります。`)) return
                                  setSaving(true)
                                  try {
                                    const res = await fetch('/api/calendar/revert', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                      body: JSON.stringify({ siteId: site.siteId, ym, action: 'unapprove', revertedBy: user?.workerId || 0 }),
                                    })
                                    if (res.ok) { fetchData() }
                                    else { const d = await res.json(); alert(d.error || '取消しに失敗しました') }
                                  } catch { alert('取消しに失敗しました') }
                                  finally { setSaving(false) }
                                }}
                                disabled={saving}
                                className="w-full text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 py-2 rounded-lg text-xs hover:bg-red-100 transition disabled:opacity-50"
                              >
                                ↩ 承認を取消す
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Bulk confirm button (admin only, when multiple unconfirmed sites exist) */}
      {!loading && visibleSites.length > 1 && !allApproved && user.role !== 'foreman' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
          <button
            onClick={() => setShowConfirmDialog(true)}
            disabled={saving || hasLegalExceed}
            className="w-full bg-green-600 text-white py-3 rounded-lg text-base font-bold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? '確定中...' : '未確定の全現場をまとめて確定する'}
          </button>
          {hasLegalExceed && (
            <p className="text-red-500 text-xs mt-2 text-center">法定上限を超過している現場があります。出勤日数を修正してください。</p>
          )}
        </div>
      )}

      {/* Signature status summary */}
      {!loading && visibleSites.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 space-y-3">
          <h3 className="font-bold text-hibi-navy dark:text-white">署名状況</h3>
          <div className="text-sm text-gray-700 dark:text-gray-300">
            署名状況: <span className="font-bold">{signedWorkers}/{totalWorkers}名</span> 署名済み
          </div>
          {unsignedWorkers.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">未署名者:</p>
              <div className="flex flex-wrap gap-1">
                {unsignedWorkers.map((w, i) => (
                  <span key={i} className="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 text-xs px-2 py-0.5 rounded-full">
                    {w.name}（{w.siteName}）
                  </span>
                ))}
              </div>
            </div>
          )}
          <a
            href="/calendar/public"
            target="_blank"
            className="inline-block text-sm text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300"
          >
            署名ページを開く
          </a>
        </div>
      )}

      {/* Confirmation dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowConfirmDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-3">確認</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              {visibleSites.length}現場のカレンダーを保存・確定します。確定後は署名受付が開始されます。
            </p>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-4 space-y-1">
              {visibleSites.map(site => {
                const days = getEditDays(site.siteId, site.days)
                const workCount = Object.values(days).filter(d => d === 'work').length
                return (
                  <div key={site.siteId} className="flex justify-between">
                    <span>{site.siteName}</span>
                    <span>出勤{workCount}日</span>
                  </div>
                )
              })}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleBulkConfirm}
                className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-bold hover:bg-green-700 transition"
              >
                確定する
              </button>
              <button
                onClick={() => setShowConfirmDialog(false)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm hover:bg-gray-300 dark:hover:bg-gray-500 transition"
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
