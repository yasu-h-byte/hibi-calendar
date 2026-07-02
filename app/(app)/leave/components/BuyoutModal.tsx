'use client'

import { useState } from 'react'
import { PLWorker } from '../types'

// 買取記録モーダル (Phase 6)

interface Props {
  worker: PLWorker
  password: string
  onClose: () => void
  onSuccess: () => void  // 買取記録後: 編集モーダルも閉じて再取得
}

export default function BuyoutModal({ worker, password, onClose, onSuccess }: Props) {
  const isJp = !worker.visa || worker.visa === 'none'
  const [buyoutForm, setBuyoutForm] = useState({
    days: '', amount: '',
    reason: (isJp ? 'year-end' : 'retirement') as 'year-end' | 'retirement' | 'other',
  })
  const [buyoutSubmitting, setBuyoutSubmitting] = useState(false)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !buyoutSubmitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-5 animate-modalIn" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2 mb-4">
          <div className="text-2xl">💰</div>
          <div>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white">有給買取記録</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {worker.name}さん / 現在残 {worker.remaining}日
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取理由</label>
            <select value={buyoutForm.reason} onChange={e => setBuyoutForm(prev => ({ ...prev, reason: e.target.value as 'year-end' | 'retirement' | 'other' }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm">
              <option value="year-end">期末買取（9/30時点）</option>
              <option value="retirement">退職時清算</option>
              <option value="other">その他</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取日数</label>
            <input type="number" value={buyoutForm.days} onChange={e => setBuyoutForm(prev => ({ ...prev, days: e.target.value }))}
              placeholder="例: 5"
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
            <p className="text-[10px] text-gray-400 mt-1">※残日数の範囲内で指定</p>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取金額（任意、¥）</label>
            <input type="number" value={buyoutForm.amount} onChange={e => setBuyoutForm(prev => ({ ...prev, amount: e.target.value }))}
              placeholder="例: 50000"
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
          </div>
        </div>

        <div className="mt-4 p-2 bg-amber-50 dark:bg-amber-900/20 rounded text-[10px] text-amber-700 dark:text-amber-300">
          ℹ️ 買取記録はこのレコードの buyoutHistory に追記されます。残日数の表示には影響しないため、別途「調整」欄で消化計上する運用です。
        </div>

        <div className="flex gap-2 mt-4">
          <button
            disabled={buyoutSubmitting || !buyoutForm.days || Number(buyoutForm.days) <= 0}
            onClick={async () => {
              const days = Number(buyoutForm.days)
              if (!confirm(`${worker.name}さんの有給 ${days}日を買取記録しますか？\n理由: ${buyoutForm.reason === 'year-end' ? '期末買取' : buyoutForm.reason === 'retirement' ? '退職時清算' : 'その他'}${buyoutForm.amount ? `\n金額: ¥${Number(buyoutForm.amount).toLocaleString()}` : ''}`)) return
              setBuyoutSubmitting(true)
              try {
                const currentFy = worker.grantDate ? worker.grantDate.slice(0, 4) : String(new Date().getFullYear())
                const res = await fetch('/api/leave', {
                  method: 'POST',
                  headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'recordBuyout',
                    workerId: worker.id,
                    fy: currentFy,
                    days,
                    amount: buyoutForm.amount ? Number(buyoutForm.amount) : undefined,
                    reason: buyoutForm.reason,
                  }),
                })
                if (res.ok) {
                  onSuccess()
                } else {
                  alert('買取記録に失敗しました')
                }
              } finally { setBuyoutSubmitting(false) }
            }}
            className="flex-1 bg-amber-600 text-white rounded-lg py-2 font-bold text-sm disabled:opacity-50">
            {buyoutSubmitting ? '処理中...' : '買取を記録する'}
          </button>
          <button disabled={buyoutSubmitting} onClick={onClose}
            className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm disabled:opacity-50">
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
