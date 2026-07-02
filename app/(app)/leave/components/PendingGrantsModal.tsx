'use client'

import { useState } from 'react'
import { PendingGrant, PendingGrantForm } from '../types'

// 半自動付与モーダル: 未付与検知されたスタッフへの一括付与
// フォーム状態はデータ取得時に初期化されるため親（page）が保持する

interface Props {
  open: boolean
  pendingGrants: PendingGrant[]
  pendingForm: PendingGrantForm
  setPendingForm: React.Dispatch<React.SetStateAction<PendingGrantForm>>
  password: string
  onClose: () => void
  onSaved: () => void
}

export default function PendingGrantsModal({ open, pendingGrants, pendingForm, setPendingForm, password, onClose, onSaved }: Props) {
  const [pendingExecuting, setPendingExecuting] = useState(false)

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !pendingExecuting && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col animate-modalIn" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-start gap-2">
            <div className="text-2xl">🌴</div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-hibi-navy dark:text-white">有給付与対象 ({pendingGrants.length}名)</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                付与日・日数は各スタッフごとに調整できます。「付与する」のチェックを外すと今回はスキップされます。
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {pendingGrants.map(p => {
            const f = pendingForm[p.workerId] || { grantDate: p.nextGrantDate, grantDays: String(p.legalDays || 10), include: true }
            const isJp = !p.visa || p.visa === 'none'
            const visaLabel = isJp ? '日本人' : (p.visa === 'jisshu1' ? '実習1号' : p.visa === 'jisshu2' ? '実習2号' : p.visa === 'tokutei1' ? '特定1号' : p.visa === 'tokutei2' ? '特定2号' : p.visa)
            return (
              <div key={p.workerId} className={`border rounded-lg p-3 ${
                f.include
                  ? (p.needsAttention ? 'border-red-300 bg-red-50/50 dark:bg-red-900/10' : 'border-amber-300 bg-amber-50/50 dark:bg-amber-900/10')
                  : 'border-gray-200 bg-gray-50 dark:bg-gray-900/50 opacity-60'
              }`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="font-bold text-sm text-hibi-navy dark:text-white flex items-center gap-1.5">
                      {p.name}
                      {p.needsAttention && <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-md font-normal">⚠️ 要確認</span>}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                      {visaLabel} | {p.tenureText} | {p.reason}
                    </div>
                    {p.attentionNote && (
                      <div className="text-[10px] text-red-600 dark:text-red-400 mt-1">
                        ⚠️ {p.attentionNote}
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                    <input type="checkbox" checked={f.include}
                      onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, include: e.target.checked } }))}
                      className="w-4 h-4" />
                    <span>付与する</span>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-0.5">付与日</label>
                    <input type="date" value={f.grantDate} disabled={!f.include}
                      onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDate: e.target.value } }))}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-0.5">付与日数（法定 {p.legalDays}日）</label>
                    <input type="number" value={f.grantDays} disabled={!f.include}
                      onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDays: e.target.value } }))}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
          <button
            disabled={pendingExecuting || Object.values(pendingForm).every(f => !f.include)}
            onClick={async () => {
              setPendingExecuting(true)
              try {
                const grants = pendingGrants
                  .filter(p => pendingForm[p.workerId]?.include)
                  .map(p => {
                    const f = pendingForm[p.workerId]
                    const gd = new Date(f.grantDate)
                    const fyYear = gd.getFullYear()
                    return {
                      workerId: p.workerId,
                      fy: String(fyYear),
                      grantDate: f.grantDate,
                      grantDays: Number(f.grantDays) || 0,
                    }
                  })
                  .filter(g => g.grantDays > 0)
                if (grants.length === 0) return
                const res = await fetch('/api/leave', {
                  method: 'POST',
                  headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'executePendingGrants', grants }),
                })
                if (res.ok) {
                  onSaved()
                } else {
                  alert('付与に失敗しました')
                }
              } finally {
                setPendingExecuting(false)
              }
            }}
            className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
            {pendingExecuting ? '付与中...' : `一括付与する（${Object.values(pendingForm).filter(f => f.include).length}名）`}
          </button>
          <button disabled={pendingExecuting} onClick={onClose}
            className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm disabled:opacity-50">
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
