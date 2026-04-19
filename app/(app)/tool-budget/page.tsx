'use client'

import { useEffect, useState, useCallback } from 'react'

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
  registeredAt: string
}

interface WorkerBudget {
  workerId: number
  workerName: string
  visa: string
  budget: number
  used: number
  remaining: number
  purchases: Purchase[]
}

function visaLabel(visa: string): string {
  if (visa.startsWith('jisshu')) {
    const n = visa.replace('jisshu', '')
    return n ? `実習${n}号` : '実習'
  }
  if (visa.startsWith('tokutei')) {
    const n = visa.replace('tokutei', '')
    return n ? `特定${n}号` : '特定'
  }
  return visa
}

function fyLabel(fy: string): string {
  return `${fy}年度（${fy}年10月〜${Number(fy) + 1}年9月）`
}

function getFyOptions(): { fy: string; label: string }[] {
  const now = new Date()
  const m = now.getMonth() + 1
  const y = now.getFullYear()
  const currentFy = m >= 10 ? y : y - 1
  const options = []
  for (let i = -2; i <= 1; i++) {
    const fy = String(currentFy + i)
    options.push({ fy, label: fyLabel(fy) })
  }
  return options
}

export default function ToolBudgetPage() {
  const [password, setPassword] = useState('')
  const [fy, setFy] = useState('')
  const [workers, setWorkers] = useState<WorkerBudget[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedWorker, setExpandedWorker] = useState<number | null>(null)

  // 登録フォーム
  const [addingFor, setAddingFor] = useState<number | null>(null)
  const [newDate, setNewDate] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newItem, setNewItem] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (auth) {
        const { password: pw } = JSON.parse(auth)
        setPassword(pw || '')
      }
    } catch { /* ignore */ }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const params = fy ? `?fy=${fy}` : ''
      const res = await fetch(`/api/tool-budget${params}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
        if (!fy) setFy(data.currentFy || '')
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [password, fy])

  useEffect(() => { fetchData() }, [fetchData])

  const handleAddPurchase = async (workerId: number) => {
    if (!newDate || !newAmount || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'addPurchase',
          workerId,
          fy,
          date: newDate,
          amount: Number(newAmount),
          item: newItem,
        }),
      })
      if (res.ok) {
        setNewDate('')
        setNewAmount('')
        setNewItem('')
        setAddingFor(null)
        fetchData()
      }
    } catch { /* ignore */ }
    setSaving(false)
  }

  const handleDeletePurchase = async (workerId: number, purchaseId: string) => {
    if (!confirm('この購入記録を削除しますか？')) return
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'deletePurchase', workerId, fy, purchaseId }),
      })
      fetchData()
    } catch { /* ignore */ }
  }

  const handleResetFy = async () => {
    if (!confirm(`${fyLabel(fy)} の予算を全スタッフ分作成します。よろしいですか？`)) return
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'resetFy', fy }),
      })
      fetchData()
    } catch { /* ignore */ }
  }

  const fyOptions = getFyOptions()
  const totalBudget = workers.reduce((s, w) => s + w.budget, 0)
  const totalUsed = workers.reduce((s, w) => s + w.used, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-bold text-hibi-navy flex items-center gap-2">
          🔧 道具代管理
        </h1>
        <select
          value={fy}
          onChange={e => setFy(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
        >
          {fyOptions.map(o => (
            <option key={o.fy} value={o.fy}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={handleResetFy}
          className="text-xs bg-hibi-navy text-white px-3 py-1.5 rounded-lg hover:bg-hibi-light transition"
        >
          年度初期化
        </button>
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">対象人数</div>
          <div className="text-2xl font-bold text-hibi-navy">{workers.length}名</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">使用済み合計</div>
          <div className="text-2xl font-bold text-orange-600">¥{totalUsed.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">残額合計</div>
          <div className="text-2xl font-bold text-green-600">¥{(totalBudget - totalUsed).toLocaleString()}</div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">読み込み中...</div>
      ) : workers.length === 0 ? (
        <div className="bg-white rounded-xl shadow p-8 text-center text-gray-400">
          <p>この年度のデータがありません。</p>
          <p className="text-sm mt-2">「年度初期化」ボタンで全スタッフの予算を作成してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-hibi-navy text-white">
                <th className="text-left px-4 py-2">スタッフ</th>
                <th className="text-center px-2 py-2 w-20">在留資格</th>
                <th className="text-right px-3 py-2 w-24">予算</th>
                <th className="text-right px-3 py-2 w-24">使用済</th>
                <th className="text-right px-3 py-2 w-24">残額</th>
                <th className="text-center px-2 py-2 w-20">操作</th>
              </tr>
            </thead>
            <tbody>
              {workers.map(w => {
                const isExpanded = expandedWorker === w.workerId
                const pct = w.budget > 0 ? Math.min(100, (w.used / w.budget) * 100) : 0
                return (
                  <tr key={w.workerId} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedWorker(isExpanded ? null : w.workerId)}>
                    <td className="px-4 py-3 font-medium">{w.workerName}</td>
                    <td className="text-center px-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">{visaLabel(w.visa)}</span>
                    </td>
                    <td className="text-right px-3 tabular-nums">¥{w.budget.toLocaleString()}</td>
                    <td className="text-right px-3 tabular-nums text-orange-600">¥{w.used.toLocaleString()}</td>
                    <td className="text-right px-3 tabular-nums font-bold text-green-600">¥{w.remaining.toLocaleString()}</td>
                    <td className="text-center px-2">
                      <button
                        onClick={e => { e.stopPropagation(); setAddingFor(addingFor === w.workerId ? null : w.workerId); setExpandedWorker(w.workerId) }}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 transition"
                      >
                        登録
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* 展開エリア: 購入履歴 + 登録フォーム */}
          {expandedWorker && (() => {
            const w = workers.find(w => w.workerId === expandedWorker)
            if (!w) return null
            return (
              <div className="border-t-2 border-hibi-navy bg-gray-50 p-4">
                <h3 className="font-bold text-sm text-hibi-navy mb-3">{w.workerName} の購入履歴</h3>

                {w.purchases.length === 0 ? (
                  <p className="text-sm text-gray-400 mb-3">購入記録なし</p>
                ) : (
                  <table className="w-full text-sm mb-3">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 px-2">日付</th>
                        <th className="text-left py-1 px-2">品名</th>
                        <th className="text-right py-1 px-2">金額</th>
                        <th className="text-center py-1 px-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.purchases.map(p => (
                        <tr key={p.id} className="border-b border-gray-100">
                          <td className="py-1.5 px-2 tabular-nums">{p.date}</td>
                          <td className="py-1.5 px-2">{p.item || '—'}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums">¥{p.amount.toLocaleString()}</td>
                          <td className="py-1.5 px-2 text-center">
                            <button
                              onClick={() => handleDeletePurchase(w.workerId, p.id)}
                              className="text-[10px] text-red-500 hover:text-red-700"
                            >
                              削除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 登録フォーム */}
                {addingFor === w.workerId && (
                  <div className="bg-white rounded-lg p-3 border border-gray-200">
                    <div className="text-xs font-bold text-gray-600 mb-2">新しい購入を登録</div>
                    <div className="flex gap-2 items-end flex-wrap">
                      <div>
                        <label className="text-[10px] text-gray-400 block">日付</label>
                        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block">品名</label>
                        <input type="text" value={newItem} onChange={e => setNewItem(e.target.value)}
                          placeholder="安全帯など"
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block">金額（円）</label>
                        <input type="number" value={newAmount} onChange={e => setNewAmount(e.target.value)}
                          placeholder="3500"
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-28" />
                      </div>
                      <button
                        onClick={() => handleAddPurchase(w.workerId)}
                        disabled={saving || !newDate || !newAmount}
                        className="bg-hibi-navy text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
