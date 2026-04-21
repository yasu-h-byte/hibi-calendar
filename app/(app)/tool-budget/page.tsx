'use client'

import { useEffect, useState, useCallback } from 'react'

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
  registeredAt: string
}

interface Period {
  start: string
  end: string
  index: number
}

interface WorkerBudget {
  workerId: number
  workerName: string
  visa: string
  org: string
  hireDate?: string
  period: Period | null
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

function formatPeriod(p: Period | null): string {
  if (!p) return '期間未設定'
  return `${p.start.slice(5).replace('-', '/')} 〜 ${p.end.slice(5).replace('-', '/')}`
}

function formatPeriodFull(p: Period | null): string {
  if (!p) return ''
  return `${p.start} 〜 ${p.end}`
}

export default function ToolBudgetPage() {
  const [password, setPassword] = useState('')
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
      const res = await fetch('/api/tool-budget', {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  const handleAddPurchase = async (workerId: number, periodStart: string) => {
    if (!newDate || !newAmount || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'addPurchase',
          workerId,
          periodStart,
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

  const handleDeletePurchase = async (workerId: number, periodStart: string, purchaseId: string) => {
    if (!confirm('この購入記録を削除しますか？')) return
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'deletePurchase', workerId, periodStart, purchaseId }),
      })
      fetchData()
    } catch { /* ignore */ }
  }

  const totalBudget = workers.reduce((s, w) => s + w.budget, 0)
  const totalUsed = workers.reduce((s, w) => s + w.used, 0)

  // 会社ごとにグループ化
  const companyGroups = [
    { key: 'hibi', label: '日比建設', bg: 'bg-blue-50', text: 'text-blue-800' },
    { key: 'hfu', label: 'HFU', bg: 'bg-purple-50', text: 'text-purple-800' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-bold text-hibi-navy flex items-center gap-2">
          🔧 道具代管理
        </h1>
        <span className="text-xs text-gray-500">
          技能実習生・特定技能が対象（入社日から1年サイクル）
        </span>
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
          <p>対象スタッフがいません。</p>
          <p className="text-sm mt-2">技能実習生・特定技能のスタッフが登録されているか、人員マスタをご確認ください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-hibi-navy text-white">
                <th className="text-left px-4 py-2">スタッフ</th>
                <th className="text-center px-2 py-2 w-20">在留資格</th>
                <th className="text-center px-2 py-2 w-44">現在の期間</th>
                <th className="text-right px-3 py-2 w-24">予算</th>
                <th className="text-right px-3 py-2 w-24">使用済</th>
                <th className="text-right px-3 py-2 w-24">残額</th>
                <th className="text-center px-2 py-2 w-20">操作</th>
              </tr>
            </thead>
            <tbody>
              {companyGroups.map(company => {
                const companyWorkers = workers.filter(w => w.org === company.key)
                if (companyWorkers.length === 0) return null
                return [
                  <tr key={`sec-${company.key}`}>
                    <td colSpan={7} className={`${company.bg} px-4 py-1.5 text-xs font-bold ${company.text} border-b`}>
                      {company.label}（{companyWorkers.length}名）
                    </td>
                  </tr>,
                  ...companyWorkers.map(w => (
                    <tr key={w.workerId} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setExpandedWorker(expandedWorker === w.workerId ? null : w.workerId)}>
                      <td className="px-4 py-3 font-medium">{w.workerName}</td>
                      <td className="text-center px-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                          {visaLabel(w.visa)}
                        </span>
                      </td>
                      <td className="text-center px-2 tabular-nums">
                        <div className="text-xs">{formatPeriod(w.period)}</div>
                        {w.period && <div className="text-[10px] text-gray-400">{w.period.index}年目</div>}
                      </td>
                      <td className="text-right px-3 tabular-nums">¥{w.budget.toLocaleString()}</td>
                      <td className="text-right px-3 tabular-nums text-orange-600">¥{w.used.toLocaleString()}</td>
                      <td className="text-right px-3 tabular-nums font-bold text-green-600">¥{w.remaining.toLocaleString()}</td>
                      <td className="text-center px-2">
                        <button
                          onClick={e => { e.stopPropagation(); setAddingFor(addingFor === w.workerId ? null : w.workerId); setExpandedWorker(w.workerId) }}
                          className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 transition"
                          disabled={!w.period}
                        >
                          登録
                        </button>
                      </td>
                    </tr>
                  )),
                ]
              })}
            </tbody>
          </table>

          {/* 展開エリア: 購入履歴 + 登録フォーム */}
          {expandedWorker && (() => {
            const w = workers.find(w => w.workerId === expandedWorker)
            if (!w) return null
            return (
              <div className="border-t-2 border-hibi-navy bg-gray-50 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-sm text-hibi-navy">{w.workerName} の購入履歴</h3>
                  {w.period && (
                    <span className="text-xs text-gray-500">
                      期間: {formatPeriodFull(w.period)}（{w.period.index}年目）
                      {w.hireDate && <span className="ml-2 text-gray-400">入社: {w.hireDate}</span>}
                    </span>
                  )}
                </div>

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
                              onClick={() => w.period && handleDeletePurchase(w.workerId, w.period.start, p.id)}
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
                {addingFor === w.workerId && w.period && (
                  <div className="bg-white rounded-lg p-3 border border-gray-200">
                    <div className="text-xs font-bold text-gray-600 mb-2">新しい購入を登録</div>
                    <div className="flex gap-2 items-end flex-wrap">
                      <div>
                        <label className="text-[10px] text-gray-400 block">日付</label>
                        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                          min={w.period.start} max={w.period.end}
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
                        onClick={() => w.period && handleAddPurchase(w.workerId, w.period.start)}
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
