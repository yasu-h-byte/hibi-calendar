'use client'

import { useState } from 'react'
import { PLWorker } from '../types'
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { FieldError } from '@/components/ui/PageParts'

// 買取記録モーダル (Phase 6)
// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え

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
  const [fieldError, setFieldError] = useState<{ days?: string; amount?: string }>({})

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !buyoutSubmitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-5 animate-modalIn" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2 mb-4">
          <div className="text-2xl">💰</div>
          <div>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white">有給買取記録</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {worker.name}さん / 今の期の残 {worker.remaining}日
              {worker.prevPeriod && ` / 前の期（〜${worker.prevPeriod.endDate.replace(/-/g, '/')}）の残 ${worker.prevPeriod.remaining}日`}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取理由</label>
            <select value={buyoutForm.reason} onChange={e => setBuyoutForm(prev => ({ ...prev, reason: e.target.value as 'year-end' | 'retirement' | 'other' }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm">
              <option value="year-end">期末買取（付与の期の最後の日の時点）</option>
              <option value="retirement">退職時清算</option>
              <option value="other">その他</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取日数</label>
            <input type="number" value={buyoutForm.days} onChange={e => { setFieldError({}); setBuyoutForm(prev => ({ ...prev, days: e.target.value })) }}
              placeholder="例: 5" aria-invalid={!!fieldError.days}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
            <FieldError>{fieldError.days}</FieldError>
            <p className="text-3xs text-gray-400 mt-1">※残日数の範囲内で指定</p>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取金額（任意、¥）</label>
            <input type="number" value={buyoutForm.amount} onChange={e => { setFieldError({}); setBuyoutForm(prev => ({ ...prev, amount: e.target.value })) }}
              placeholder="例: 50000" aria-invalid={!!fieldError.amount}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
            <FieldError>{fieldError.amount}</FieldError>
          </div>
        </div>

        <div className="mt-4 p-2 bg-amber-50 dark:bg-amber-900/20 rounded text-3xs text-amber-700 dark:text-amber-300">
          ℹ️ 買取記録はこのレコードの buyoutHistory に追記され、買取日数ぶん残日数が減ります。「調整」欄での二重計上は不要です。
        </div>

        <div className="flex gap-2 mt-4">
          <button
            disabled={buyoutSubmitting || !buyoutForm.days || Number(buyoutForm.days) <= 0}
            onClick={async () => {
              const days = Number(buyoutForm.days)
              // 期末買取は「終わった前の期」に記録する（2026-10-02 総合点検。賞与の精勤賞与・休暇管理の
              //   「賞与で買取予定」と同じ期）。旧: 今の期（付与直後でほぼ満額）のレコードに記録していた。
              //   退職時清算・その他は今の期
              const targetPrev = buyoutForm.reason === 'year-end'
              if (targetPrev && !worker.prevPeriod) {
                notify.error('終わった期がありません', '期末買取は期が終わってから記録します。退職時清算・その他なら今の期に記録できます。')
                return
              }
              if (targetPrev && worker.prevPeriod?.yearEndBuyoutRecorded) {
                notify.error('前の期の期末買取は記録済みです', 'やり直す場合は、先に既存の買取記録を取り消してください。')
                return
              }
              const limit = targetPrev ? (worker.prevPeriod?.remaining ?? 0) : worker.remaining
              // 2026-08-27 追加: 注記どおり残日数の範囲内に制限（旧: >0 のみで超過買取が送れた）
              if (days > limit) {
                setFieldError({ days: `買取日数（${days}日）が${targetPrev ? '前の期の' : ''}残日数（${limit}日）を超えています` })
                return
              }
              if (buyoutForm.amount && Number(buyoutForm.amount) < 0) {
                setFieldError({ amount: '金額に負の値は入力できません' })
                return
              }
              const reasonLabel = buyoutForm.reason === 'year-end' ? '期末買取' : buyoutForm.reason === 'retirement' ? '退職時清算' : 'その他'
              if (!(await confirmDialog({
                title: `${worker.name}さんの有給 ${days}日を買取として記録しますか？`,
                description: `理由: ${reasonLabel}${buyoutForm.amount ? `\n金額: ¥${Number(buyoutForm.amount).toLocaleString()}` : ''}\n買取日数のぶん残日数が減ります。`,
                confirmLabel: '記録する',
              }))) return
              setBuyoutSubmitting(true)
              try {
                const currentFy = targetPrev && worker.prevPeriod
                  ? worker.prevPeriod.fy
                  : (worker.grantDate ? worker.grantDate.slice(0, 4) : String(new Date().getFullYear()))
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
                  const err = await res.json().catch(() => null)
                  notify.failed('買取の記録', err?.error)
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
