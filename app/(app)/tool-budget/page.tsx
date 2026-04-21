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
  periodAnchor?: string | null
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
  const [modalWorkerId, setModalWorkerId] = useState<number | null>(null)

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

  const totalBudget = workers.reduce((s, w) => s + w.budget, 0)
  const totalUsed = workers.reduce((s, w) => s + w.used, 0)
  const setupCount = workers.filter(w => w.period).length

  const companyGroups = [
    { key: 'hibi', label: '日比建設', bg: 'bg-blue-50', text: 'text-blue-800' },
    { key: 'hfu', label: 'HFU', bg: 'bg-purple-50', text: 'text-purple-800' },
  ]

  const currentWorker = modalWorkerId ? workers.find(w => w.workerId === modalWorkerId) || null : null

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
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">対象人数</div>
          <div className="text-2xl font-bold text-hibi-navy">{workers.length}名</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">期間設定済</div>
          <div className="text-2xl font-bold text-hibi-navy">{setupCount} / {workers.length}</div>
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
                <th className="text-center px-2 py-2 w-24">操作</th>
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
                    <tr key={w.workerId}
                      className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setModalWorkerId(w.workerId)}>
                      <td className="px-4 py-3 font-medium text-hibi-navy">{w.workerName}</td>
                      <td className="text-center px-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                          {visaLabel(w.visa)}
                        </span>
                      </td>
                      <td className="text-center px-2 tabular-nums">
                        {w.period ? (
                          <span className="text-xs">{formatPeriod(w.period)}</span>
                        ) : (
                          <span className="text-xs text-gray-400 italic">未設定</span>
                        )}
                      </td>
                      <td className="text-right px-3 tabular-nums">¥{w.budget.toLocaleString()}</td>
                      <td className="text-right px-3 tabular-nums text-orange-600">¥{w.used.toLocaleString()}</td>
                      <td className="text-right px-3 tabular-nums font-bold text-green-600">¥{w.remaining.toLocaleString()}</td>
                      <td className="text-center px-2">
                        <button
                          onClick={e => { e.stopPropagation(); setModalWorkerId(w.workerId) }}
                          className="text-xs bg-blue-50 text-blue-700 px-3 py-1 rounded hover:bg-blue-100 transition"
                        >
                          {w.period ? '管理' : '設定'}
                        </button>
                      </td>
                    </tr>
                  )),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* モーダル */}
      {currentWorker && (
        <WorkerModal
          worker={currentWorker}
          password={password}
          onClose={() => setModalWorkerId(null)}
          onRefresh={fetchData}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────
//  Worker Detail Modal
// ────────────────────────────────────────

function WorkerModal({
  worker,
  password,
  onClose,
  onRefresh,
}: {
  worker: WorkerBudget
  password: string
  onClose: () => void
  onRefresh: () => void
}) {
  const [anchor, setAnchor] = useState(worker.periodAnchor || '')
  const [anchorSaving, setAnchorSaving] = useState(false)
  const [anchorSaved, setAnchorSaved] = useState(false)

  const [budget, setBudget] = useState(String(worker.budget))
  const [budgetSaving, setBudgetSaving] = useState(false)
  const [budgetSaved, setBudgetSaved] = useState(false)

  const [bulkAmount, setBulkAmount] = useState('')
  const [bulkDate, setBulkDate] = useState(worker.period?.start || '')
  const [bulkMemo, setBulkMemo] = useState('既存使用分')
  const [bulkSaving, setBulkSaving] = useState(false)

  const [newDate, setNewDate] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newItem, setNewItem] = useState('')
  const [newSaving, setNewSaving] = useState(false)

  // worker props が更新されたら state を同期
  useEffect(() => {
    setAnchor(worker.periodAnchor || '')
    setBudget(String(worker.budget))
    if (worker.period) setBulkDate(worker.period.start)
  }, [worker])

  const saveAnchor = async () => {
    if (anchorSaving) return
    setAnchorSaving(true)
    setAnchorSaved(false)
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'setPeriodAnchor', workerId: worker.workerId, anchor: anchor || null }),
      })
      setAnchorSaved(true)
      setTimeout(() => setAnchorSaved(false), 1500)
      onRefresh()
    } catch { /* ignore */ }
    setAnchorSaving(false)
  }

  const saveBudget = async () => {
    if (budgetSaving || !worker.period) return
    setBudgetSaving(true)
    setBudgetSaved(false)
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'setBudget',
          workerId: worker.workerId,
          periodStart: worker.period.start,
          budget: Number(budget),
        }),
      })
      setBudgetSaved(true)
      setTimeout(() => setBudgetSaved(false), 1500)
      onRefresh()
    } catch { /* ignore */ }
    setBudgetSaving(false)
  }

  const addPurchase = async (date: string, amount: number, item: string) => {
    if (!worker.period) return false
    try {
      const res = await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'addPurchase',
          workerId: worker.workerId,
          periodStart: worker.period.start,
          date,
          amount,
          item,
        }),
      })
      return res.ok
    } catch { return false }
  }

  const handleBulkRegister = async () => {
    if (!bulkAmount || !bulkDate || bulkSaving) return
    setBulkSaving(true)
    const ok = await addPurchase(bulkDate, Number(bulkAmount), bulkMemo || '既存使用分')
    if (ok) {
      setBulkAmount('')
      onRefresh()
    }
    setBulkSaving(false)
  }

  const handleAddNew = async () => {
    if (!newDate || !newAmount || newSaving) return
    setNewSaving(true)
    const ok = await addPurchase(newDate, Number(newAmount), newItem)
    if (ok) {
      setNewDate('')
      setNewAmount('')
      setNewItem('')
      onRefresh()
    }
    setNewSaving(false)
  }

  const handleDelete = async (purchaseId: string) => {
    if (!worker.period) return
    if (!confirm('この購入記録を削除しますか？')) return
    try {
      await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'deletePurchase',
          workerId: worker.workerId,
          periodStart: worker.period.start,
          purchaseId,
        }),
      })
      onRefresh()
    } catch { /* ignore */ }
  }

  const sortedPurchases = [...worker.purchases].sort((a, b) => b.date.localeCompare(a.date))
  const pct = worker.budget > 0 ? Math.min(100, (worker.used / worker.budget) * 100) : 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-bold text-hibi-navy flex items-center gap-2">
              🔧 {worker.workerName}
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                {visaLabel(worker.visa)}
              </span>
            </h2>
            {worker.period && (
              <p className="text-xs text-gray-500 mt-0.5">
                期間: {formatPeriodFull(worker.period)}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-5">
          {/* ══ Section 1: 期間設定 ══ */}
          <section>
            <h3 className="text-sm font-bold text-hibi-navy mb-2 flex items-center gap-2">
              <span className="bg-hibi-navy text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">1</span>
              期間の起点日
            </h3>
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 block mb-0.5">起点日（1年サイクルの始まり）</label>
                  <input
                    type="date"
                    value={anchor}
                    onChange={e => setAnchor(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
                </div>
                <button
                  onClick={saveAnchor}
                  disabled={anchorSaving || anchor === (worker.periodAnchor || '')}
                  className="bg-hibi-navy text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
                >
                  {anchorSaving ? '保存中...' : '保存'}
                </button>
                {anchorSaved && <span className="text-xs text-green-600 font-bold">✓ 保存しました</span>}
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                起点日を設定すると、その日から1年ごとに自動でサイクルが切り替わります（例: 5/14 → 翌5/13まで）。<br />
                {worker.period && <span>現在の期間: <strong>{formatPeriodFull(worker.period)}</strong></span>}
              </p>
            </div>
          </section>

          {/* ══ 期間未設定の場合はここまで ══ */}
          {!worker.period ? (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 text-center text-yellow-800 text-sm">
              まず期間の起点日を設定してください。<br />
              設定後、購入の登録ができるようになります。
            </div>
          ) : (
            <>
              {/* ══ Section 2: 予算と使用状況 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">2</span>
                  予算と使用状況
                </h3>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-3">
                  {/* 進捗バー */}
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-600">使用済 ¥{worker.used.toLocaleString()}</span>
                      <span className="text-gray-600">残額 <strong className="text-green-600">¥{worker.remaining.toLocaleString()}</strong></span>
                    </div>
                    <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-400' : 'bg-blue-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1 text-right">
                      {pct.toFixed(0)}% 使用中 / 予算 ¥{worker.budget.toLocaleString()}
                    </div>
                  </div>

                  {/* 予算変更 */}
                  <div className="flex items-end gap-2 pt-2 border-t border-gray-200">
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">予算額（個別変更）</label>
                      <input
                        type="number"
                        value={budget}
                        onChange={e => setBudget(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm w-32 tabular-nums" />
                    </div>
                    <button
                      onClick={saveBudget}
                      disabled={budgetSaving || Number(budget) === worker.budget}
                      className="bg-gray-600 text-white px-3 py-1.5 rounded text-xs font-bold hover:bg-gray-700 transition disabled:opacity-50"
                    >
                      {budgetSaving ? '保存中...' : '予算変更'}
                    </button>
                    {budgetSaved && <span className="text-xs text-green-600 font-bold">✓ 保存しました</span>}
                    <span className="text-[11px] text-gray-400 ml-auto">デフォルト: ¥30,000</span>
                  </div>
                </div>
              </section>

              {/* ══ Section 3: 既存使用分のまとめ登録（既存0件の時のみ強調） ══ */}
              {worker.purchases.length === 0 && (
                <section>
                  <h3 className="text-sm font-bold text-hibi-navy mb-2 flex items-center gap-2">
                    <span className="bg-hibi-navy text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">3</span>
                    既存使用分のまとめ登録（初回のみ）
                  </h3>
                  <div className="bg-amber-50 rounded-lg p-3 border border-amber-300">
                    <p className="text-xs text-amber-800 mb-2">
                      この期間ですでに使った道具代がある場合は、合計金額をまとめて登録できます。
                    </p>
                    <div className="flex items-end gap-2 flex-wrap">
                      <div>
                        <label className="text-[10px] text-gray-500 block mb-0.5">日付（通常は期間起点）</label>
                        <input
                          type="date"
                          value={bulkDate}
                          onChange={e => setBulkDate(e.target.value)}
                          min={worker.period.start} max={worker.period.end}
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 block mb-0.5">摘要</label>
                        <input
                          type="text"
                          value={bulkMemo}
                          onChange={e => setBulkMemo(e.target.value)}
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 block mb-0.5">合計金額</label>
                        <input
                          type="number"
                          value={bulkAmount}
                          onChange={e => setBulkAmount(e.target.value)}
                          placeholder="8500"
                          className="border border-gray-300 rounded px-2 py-1.5 text-sm w-28 tabular-nums" />
                      </div>
                      <button
                        onClick={handleBulkRegister}
                        disabled={bulkSaving || !bulkAmount || !bulkDate}
                        className="bg-amber-600 text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-amber-700 transition disabled:opacity-50"
                      >
                        {bulkSaving ? '登録中...' : 'まとめて計上'}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* ══ Section 4: 購入履歴 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">
                    {worker.purchases.length === 0 ? '4' : '3'}
                  </span>
                  購入履歴（{worker.purchases.length}件）
                </h3>
                <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
                  {sortedPurchases.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">購入記録なし</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-500 border-b border-gray-200">
                          <th className="text-left py-2 px-3">日付</th>
                          <th className="text-left py-2 px-3">品名</th>
                          <th className="text-right py-2 px-3">金額</th>
                          <th className="text-center py-2 px-3 w-12"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedPurchases.map(p => (
                          <tr key={p.id} className="border-b border-gray-100 last:border-b-0">
                            <td className="py-1.5 px-3 tabular-nums text-xs">{p.date}</td>
                            <td className="py-1.5 px-3">{p.item || '—'}</td>
                            <td className="py-1.5 px-3 text-right tabular-nums">¥{p.amount.toLocaleString()}</td>
                            <td className="py-1.5 px-3 text-center">
                              <button
                                onClick={() => handleDelete(p.id)}
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
                </div>
              </section>

              {/* ══ Section 5: 新規登録 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">
                    {worker.purchases.length === 0 ? '5' : '4'}
                  </span>
                  新しい購入を登録
                </h3>
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                  <div className="flex items-end gap-2 flex-wrap">
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">購入日</label>
                      <input
                        type="date"
                        value={newDate}
                        onChange={e => setNewDate(e.target.value)}
                        min={worker.period.start} max={worker.period.end}
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">品名</label>
                      <input
                        type="text"
                        value={newItem}
                        onChange={e => setNewItem(e.target.value)}
                        placeholder="安全帯など"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">金額（円）</label>
                      <input
                        type="number"
                        value={newAmount}
                        onChange={e => setNewAmount(e.target.value)}
                        placeholder="3500"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm w-28 tabular-nums" />
                    </div>
                    <button
                      onClick={handleAddNew}
                      disabled={newSaving || !newDate || !newAmount}
                      className="bg-hibi-navy text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
                    >
                      {newSaving ? '追加中...' : '+ 追加'}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300 transition"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
