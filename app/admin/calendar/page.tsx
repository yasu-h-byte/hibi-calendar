'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { CALENDAR_PATTERNS, getNextMonth } from '@/lib/calendar'
import { Worker } from '@/types'

export default function AdminCalendarPage() {
  const { ym: defaultYm } = getNextMonth()
  const [password, setPassword] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [assignments, setAssignments] = useState<Record<number, string>>({})
  const [signatures, setSignatures] = useState<Record<number, string>>({})
  const [ym, setYm] = useState(defaultYm)
  const [loading, setLoading] = useState(false)
  const [qrWorker, setQrWorker] = useState<Worker | null>(null)
  const [showBulkQR, setShowBulkQR] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)

  const headers = useCallback(() => ({
    'x-admin-password': password,
    'Content-Type': 'application/json',
  }), [password])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [workersRes, statusRes] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch(`/api/calendar/status?ym=${ym}`, { headers: { 'x-admin-password': password } }),
      ])

      if (workersRes.status === 401) {
        setAuthenticated(false)
        setAuthError(true)
        return
      }

      const workersData = await workersRes.json()
      const statusData = await statusRes.json()

      setWorkers(workersData.workers || [])
      setAssignments(statusData.assignments || {})
      setSignatures(statusData.signatures || {})
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => {
    if (authenticated) {
      fetchData()
    }
  }, [authenticated, ym, fetchData])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(false)
    const res = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
    if (res.ok) {
      setAuthenticated(true)
    } else {
      setAuthError(true)
    }
  }

  const assignPattern = async (workerId: number, patternId: string) => {
    await fetch('/api/calendar/assign', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ workerId, ym, patternId }),
    })
    setAssignments(prev => ({ ...prev, [workerId]: patternId }))
  }

  const assignAll = async (patternId: string) => {
    if (!confirm(`全員にパターン${patternId}を適用しますか？`)) return
    await fetch('/api/calendar/assign-all', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ym, patternId }),
    })
    fetchData()
  }

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const unsignedWorkers = workers.filter(w => assignments[w.id] && !signatures[w.id])
  const signedCount = workers.filter(w => signatures[w.id]).length
  const assignedCount = workers.filter(w => assignments[w.id]).length

  // Year/month options
  const ymOptions: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    ymOptions.push(`${y}-${m}`)
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <form onSubmit={handleLogin} className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
          <h1 className="text-xl font-bold text-hibi-navy mb-6 text-center">
            HIBI CONSTRUCTION
            <br />
            <span className="text-sm font-normal text-gray-500">管理者ログイン</span>
          </h1>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="パスワード"
            className="w-full border border-gray-300 rounded-lg px-4 py-3 mb-4 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
          />
          {authError && <p className="text-red-500 text-sm mb-4">パスワードが正しくありません</p>}
          <button
            type="submit"
            className="w-full bg-hibi-navy text-white rounded-lg py-3 font-bold hover:bg-hibi-light transition"
          >
            ログイン
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-hibi-navy text-white px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">HIBI CONSTRUCTION</h1>
            <p className="text-sm opacity-80">就業カレンダー管理</p>
          </div>
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="bg-white/20 text-white border border-white/30 rounded-lg px-3 py-2 text-sm"
          >
            {ymOptions.map(o => (
              <option key={o} value={o} className="text-black">
                {o.replace('-', '年')}月
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-3xl font-bold text-hibi-navy">{workers.length}</div>
            <div className="text-sm text-gray-500">社員数</div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-3xl font-bold text-blue-600">{assignedCount}</div>
            <div className="text-sm text-gray-500">割当済み</div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-3xl font-bold text-green-600">{signedCount}</div>
            <div className="text-sm text-gray-500">署名済み</div>
          </div>
        </div>

        {/* Bulk actions */}
        <div className="bg-white rounded-xl shadow p-4 flex flex-wrap gap-3 items-center">
          <span className="text-sm font-bold text-gray-600">一括操作:</span>
          {CALENDAR_PATTERNS.map(p => (
            <button
              key={p.id}
              onClick={() => assignAll(p.id)}
              className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition"
            >
              全員{p.id}適用
            </button>
          ))}
          <button
            onClick={() => setShowBulkQR(true)}
            disabled={unsignedWorkers.length === 0}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-600 transition disabled:opacity-50"
          >
            未署名者QR一括出力 ({unsignedWorkers.length}名)
          </button>
        </div>

        {/* Workers table */}
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 text-left text-sm text-gray-600">
                <th className="px-4 py-3">名前</th>
                <th className="px-4 py-3">所属</th>
                <th className="px-4 py-3">在留資格</th>
                <th className="px-4 py-3">パターン</th>
                <th className="px-4 py-3">署名状況</th>
                <th className="px-4 py-3">QR</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    読み込み中...
                  </td>
                </tr>
              ) : workers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    社員データがありません
                  </td>
                </tr>
              ) : (
                workers.map(w => (
                  <tr key={w.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{w.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{w.company}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{w.visaType}</td>
                    <td className="px-4 py-3">
                      <select
                        value={assignments[w.id] || ''}
                        onChange={e => assignPattern(w.id, e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      >
                        <option value="">未選択</option>
                        {CALENDAR_PATTERNS.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.id}: {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {signatures[w.id] ? (
                        <span className="inline-block bg-green-100 text-green-700 text-xs font-bold px-2 py-1 rounded-full">
                          署名済み
                        </span>
                      ) : assignments[w.id] ? (
                        <span className="inline-block bg-yellow-100 text-yellow-700 text-xs font-bold px-2 py-1 rounded-full">
                          未署名
                        </span>
                      ) : (
                        <span className="inline-block bg-gray-100 text-gray-400 text-xs px-2 py-1 rounded-full">
                          未割当
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {w.token && (
                        <button
                          onClick={() => setQrWorker(w)}
                          className="text-hibi-navy hover:text-hibi-light text-sm underline"
                        >
                          QR表示
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* QR Modal (single) */}
      {qrWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setQrWorker(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-2">{qrWorker.name}</h3>
            <p className="text-sm text-gray-500 mb-4">
              {baseUrl}/calendar/{qrWorker.token}
            </p>
            <div className="flex justify-center mb-4">
              <QRCodeSVG
                value={`${baseUrl}/calendar/${qrWorker.token}`}
                size={200}
                level="M"
              />
            </div>
            <button
              onClick={() => setQrWorker(null)}
              className="w-full bg-gray-200 text-gray-700 rounded-lg py-2 hover:bg-gray-300 transition"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Bulk QR Modal */}
      {showBulkQR && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-hibi-navy">
                未署名者QRコード ({unsignedWorkers.length}名)
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (printRef.current) {
                      const w = window.open('', '_blank')
                      if (w) {
                        w.document.write(`
                          <html><head><title>QR Codes</title>
                          <style>
                            body { font-family: sans-serif; }
                            .qr-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 20px; }
                            .qr-item { text-align: center; page-break-inside: avoid; border: 1px solid #ddd; padding: 15px; border-radius: 8px; }
                            .qr-item h4 { margin: 0 0 10px; font-size: 14px; }
                            @media print { .qr-grid { grid-template-columns: repeat(3, 1fr); } }
                          </style></head><body>
                          ${printRef.current.innerHTML}
                          <script>window.print();</script>
                          </body></html>
                        `)
                        w.document.close()
                      }
                    }
                  }}
                  className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition"
                >
                  印刷
                </button>
                <button
                  onClick={() => setShowBulkQR(false)}
                  className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-300 transition"
                >
                  閉じる
                </button>
              </div>
            </div>
            <div ref={printRef} className="qr-grid grid grid-cols-3 gap-4">
              {unsignedWorkers.map(w => (
                <div key={w.id} className="qr-item text-center border border-gray-200 rounded-lg p-4">
                  <h4 className="font-bold text-sm mb-2">{w.name}</h4>
                  <QRCodeSVG
                    value={`${baseUrl}/calendar/${w.token}`}
                    size={120}
                    level="M"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
