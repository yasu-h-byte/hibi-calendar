'use client'

import { useEffect, useState, useCallback } from 'react'

interface LeaveRequest {
  id: string
  workerId: number
  workerName: string
  date: string
  ym: string
  day: number
  siteId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  requestedAt: string
  reviewedAt?: string
  reviewedBy?: number
  rejectedReason?: string
}

interface SiteInfo {
  id: string
  name: string
}

export default function LeaveRequestsPage() {
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [sites, setSites] = useState<SiteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all')

  const getAuthHeader = () => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { password } = JSON.parse(stored)
        return password
      }
    } catch { /* ignore */ }
    return ''
  }

  const getAuthUser = () => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { user } = JSON.parse(stored)
        return user
      }
    } catch { /* ignore */ }
    return null
  }

  const fetchData = useCallback(async () => {
    const pw = getAuthHeader()
    try {
      const [reqRes, siteRes] = await Promise.all([
        fetch('/api/leave-request', { headers: { 'x-admin-password': pw } }),
        fetch('/api/sites', { headers: { 'x-admin-password': pw } }),
      ])
      if (reqRes.ok) {
        const d = await reqRes.json()
        setRequests(d.requests || [])
      }
      if (siteRes.ok) {
        const d = await siteRes.json()
        setSites(d.sites || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const getSiteName = (siteId: string) => {
    return sites.find(s => s.id === siteId)?.name || siteId
  }

  const formatDate = (dateStr: string) => {
    const [, m, d] = dateStr.split('-')
    return `${parseInt(m)}/${parseInt(d)}`
  }

  const formatTimestamp = (ts: string) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const handleApprove = async (requestId: string) => {
    setProcessing(requestId)
    const pw = getAuthHeader()
    const user = getAuthUser()
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({
          action: 'approve',
          requestId,
          approvedBy: user?.workerId || 0,
        }),
      })
      if (res.ok) {
        fetchData()
      }
    } catch { /* ignore */ }
    setProcessing(null)
  }

  const handleReject = async (requestId: string) => {
    setProcessing(requestId)
    const pw = getAuthHeader()
    const user = getAuthUser()
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({
          action: 'reject',
          requestId,
          rejectedBy: user?.workerId || 0,
          reason: rejectReason,
        }),
      })
      if (res.ok) {
        setRejectingId(null)
        setRejectReason('')
        fetchData()
      }
    } catch { /* ignore */ }
    setProcessing(null)
  }

  const pendingRequests = requests.filter(r => r.status === 'pending')
  const processedRequests = requests.filter(r => r.status !== 'pending')

  const filteredRequests = filter === 'all' ? requests
    : filter === 'pending' ? pendingRequests
    : requests.filter(r => r.status === filter)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-3 border-hibi-navy border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-hibi-navy dark:text-white">
          有給申請管理
        </h1>
        {pendingRequests.length > 0 && (
          <span className="bg-red-500 text-white text-sm font-bold px-3 py-1 rounded-full">
            {pendingRequests.length}件 承認待ち
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {([
          { key: 'all', label: 'すべて' },
          { key: 'pending', label: '承認待ち' },
          { key: 'approved', label: '承認済み' },
          { key: 'rejected', label: '却下' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              filter === tab.key
                ? 'bg-hibi-navy text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {tab.label}
            {tab.key === 'pending' && pendingRequests.length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs rounded-full px-1.5">
                {pendingRequests.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Requests list */}
      {filteredRequests.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center text-gray-400">
          申請はありません
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRequests.map(req => (
            <div
              key={req.id}
              className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border p-4 ${
                req.status === 'pending'
                  ? 'border-yellow-300 dark:border-yellow-600'
                  : 'border-gray-200 dark:border-gray-700'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="font-bold text-hibi-navy dark:text-white text-lg">
                      {req.workerName}
                    </span>
                    <span className="text-base text-gray-600 dark:text-gray-300 font-medium">
                      {formatDate(req.date)}
                    </span>
                    <span className="text-sm text-gray-400">
                      {getSiteName(req.siteId)}
                    </span>
                  </div>
                  {req.reason && (
                    <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                      理由: {req.reason}
                    </div>
                  )}
                  <div className="text-xs text-gray-400">
                    申請: {formatTimestamp(req.requestedAt)}
                    {req.reviewedAt && ` / 処理: ${formatTimestamp(req.reviewedAt)}`}
                  </div>
                  {req.status === 'rejected' && req.rejectedReason && (
                    <div className="text-xs text-red-500 mt-1">
                      却下理由: {req.rejectedReason}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-4">
                  {req.status === 'pending' && (
                    <>
                      <button
                        onClick={() => handleApprove(req.id)}
                        disabled={processing === req.id}
                        className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-bold transition disabled:opacity-50"
                      >
                        承認
                      </button>
                      <button
                        onClick={() => {
                          if (rejectingId === req.id) {
                            handleReject(req.id)
                          } else {
                            setRejectingId(req.id)
                            setRejectReason('')
                          }
                        }}
                        disabled={processing === req.id}
                        className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-bold transition disabled:opacity-50"
                      >
                        却下
                      </button>
                    </>
                  )}
                  {req.status === 'approved' && (
                    <span className="px-3 py-1.5 bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 rounded-full text-sm font-bold">
                      承認済み
                    </span>
                  )}
                  {req.status === 'rejected' && (
                    <span className="px-3 py-1.5 bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300 rounded-full text-sm font-bold">
                      却下
                    </span>
                  )}
                </div>
              </div>

              {/* Reject reason input */}
              {rejectingId === req.id && (
                <div className="mt-3 flex items-center gap-2 border-t pt-3">
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="却下理由（任意）"
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    onClick={() => handleReject(req.id)}
                    disabled={processing === req.id}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg text-sm font-bold disabled:opacity-50"
                  >
                    却下する
                  </button>
                  <button
                    onClick={() => setRejectingId(null)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded-lg text-sm"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
