'use client'

import { useEffect, useState } from 'react'
import { calcGrantMonthFromHire, calcLegalPL } from '@/lib/leave-utils'
import { PLWorker } from '../types'

// 有給付与モーダル
// 常時マウントし open で表示切替（キャンセル後も入力値を保持する従来挙動を踏襲）

interface Props {
  open: boolean
  workers: PLWorker[]
  password: string
  onClose: () => void
  onSaved: () => void
}

export default function GrantModal({ open, workers, password, onClose, onSaved }: Props) {
  const [grantForm, setGrantForm] = useState({ workerId: '', grantDays: '10', grantMonth: '', grantDate: '' })
  const [legalPLInfo, setLegalPLInfo] = useState<{ days: number; years: number; months: number; label: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // Update legal PL and auto-fill grant month when worker selected in grant modal
  useEffect(() => {
    if (grantForm.workerId) {
      const w = workers.find(w => w.id === Number(grantForm.workerId))
      if (w?.hireDate) {
        const grantDate = grantForm.grantDate || new Date().toISOString().split('T')[0]
        const info = calcLegalPL(w.hireDate, grantDate)
        setLegalPLInfo(info)
        // Auto-fill grant days from legal calculation
        setGrantForm(prev => {
          const updates: Partial<typeof prev> = { grantDays: String(info.days) }
          // Auto-fill grant month from worker's grantMonth or calculated from hireDate
          if (!prev.grantMonth) {
            const autoMonth = w.grantMonth || calcGrantMonthFromHire(w.hireDate)
            if (autoMonth) updates.grantMonth = String(autoMonth)
          }
          return { ...prev, ...updates }
        })
      } else {
        setLegalPLInfo(null)
      }
    } else {
      setLegalPLInfo(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantForm.workerId, grantForm.grantDate])

  const handleGrant = async () => {
    if (!grantForm.workerId) { alert('対象者を選択してください'); return }
    // 2026-06-12 (監査 Sprint2-C): 付与日数は有給日給=支給額に直結するため確認を挟む
    {
      const target = workers.find(w => w.id === Number(grantForm.workerId))
      const ok = confirm(
        `⚠️ 有給を付与します:\n\n  対象: ${target?.name || `ID ${grantForm.workerId}`}\n  付与日数: ${grantForm.grantDays}日\n  付与日: ${grantForm.grantDate || '(未指定)'}\n\n` +
        `付与日数は有給手当（支給額）に直結します。よろしいですか？（操作は記録されます）`
      )
      if (!ok) return
    }
    setSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'grant',
          workerId: Number(grantForm.workerId),
          fy: grantForm.grantDate ? grantForm.grantDate.slice(0, 4) : String(new Date().getFullYear()),
          grantDays: grantForm.grantDays,
          grantMonth: grantForm.grantMonth,
          grantDate: grantForm.grantDate,
        }),
      })
      setGrantForm({ workerId: '', grantDays: '10', grantMonth: '', grantDate: '' })
      setLegalPLInfo(null)
      onSaved()
    } finally { setSaving(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">有給付与</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">対象者</label>
            <select value={grantForm.workerId} onChange={e => setGrantForm({ ...grantForm, workerId: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
              <option value="">選択してください</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.name}（{w.org === 'hfu' ? 'HFU' : '日比'}）</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日</label>
            <input type="date" value={grantForm.grantDate} onChange={e => setGrantForm({ ...grantForm, grantDate: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
          {/* Legal PL auto-calculation display */}
          {grantForm.workerId && (() => {
            const w = workers.find(w => w.id === Number(grantForm.workerId))
            if (!w) return null
            const autoMonth = w.grantMonth || calcGrantMonthFromHire(w.hireDate)
            return (
              <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 space-y-1">
                <div className="text-xs font-bold text-blue-800 dark:text-blue-300">自動計算プレビュー</div>
                <div className="text-xs text-blue-700 dark:text-blue-400">
                  {w.name}: 入社{w.hireDate || '不明'}
                  {autoMonth ? ` → 発生月${autoMonth}月` : ''}
                  {legalPLInfo && legalPLInfo.years !== undefined ? ` → 勤続${legalPLInfo.years}年${legalPLInfo.months}月` : ''}
                  {legalPLInfo && legalPLInfo.days > 0 ? ` → 法定${legalPLInfo.days}日` : ''}
                </div>
              </div>
            )
          })()}
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日数</label>
            <input type="number" value={grantForm.grantDays} onChange={e => setGrantForm({ ...grantForm, grantDays: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">発生月</label>
            <select value={grantForm.grantMonth} onChange={e => setGrantForm({ ...grantForm, grantMonth: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
              <option value="">未設定</option>
              {[10,11,12,1,2,3,4,5,6,7,8,9].map(m => <option key={m} value={m}>{m}月</option>)}
            </select>
          </div>
          {/* Expiry preview */}
          {grantForm.grantDate && (
            <div className="text-xs text-gray-500">
              有効期限: {(() => {
                const gd = new Date(grantForm.grantDate)
                if (isNaN(gd.getTime())) return '—'
                const exp = new Date(gd)
                exp.setFullYear(exp.getFullYear() + 2)
                exp.setDate(exp.getDate() - 1)
                return `${exp.getFullYear()}/${String(exp.getMonth() + 1).padStart(2, '0')}/${String(exp.getDate()).padStart(2, '0')}`
              })()}
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-6">
          <button onClick={handleGrant} disabled={saving}
            className="flex-1 bg-green-600 text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
            {saving ? '処理中...' : '付与'}
          </button>
          <button onClick={() => { setLegalPLInfo(null); onClose() }}
            className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm">キャンセル</button>
        </div>
      </div>
    </div>
  )
}
