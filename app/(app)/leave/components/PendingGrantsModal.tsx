'use client'

import { useState } from 'react'
import { PendingGrant, PendingGrantForm } from '../types'
import { FieldError } from '@/components/ui/PageParts'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

// 2026-10-03: ブラウザ標準の alert を共通部品（notify・FieldError）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
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
  // 付与日・日数の不備がある行（workerId → 文言）。入力が変わったらその行の分を消す
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  // 行の付与日・日数・チェックを何か変えたら「保存していない変更」とみなす（初期値は親が持つので比較しない）
  const [touched, setTouched] = useState(false)
  const clearRowError = (workerId: number) => setRowErrors(prev => {
    if (!(workerId in prev)) return prev
    const next = { ...prev }
    delete next[workerId]
    return next
  })
  const includeCount = Object.values(pendingForm).filter(f => f.include).length

  const execute = async () => {
    setPendingExecuting(true)
    try {
      const included = pendingGrants.filter(p => pendingForm[p.workerId]?.include)
      // 2026-08-27 追加: 入力検証。付与日が空/不正・日数0以下の行は
      //   無言でスキップせず、対象者名を挙げて実行前に止める
      //   （旧: fy が "NaN" の壊れたレコードを送信 or 件数表示と実行数の食い違い）
      const invalid = included.filter(p => {
        const f = pendingForm[p.workerId]
        return !/^\d{4}-\d{2}-\d{2}$/.test(f.grantDate || '') || !(Number(f.grantDays) > 0)
      })
      if (invalid.length > 0) {
        setRowErrors(Object.fromEntries(invalid.map(p => [p.workerId, '付与日または日数が未入力・不正です'])))
        return null
      }
      const grants = included.map(p => {
        const f = pendingForm[p.workerId]
        return {
          workerId: p.workerId,
          fy: f.grantDate.slice(0, 4),
          grantDate: f.grantDate,
          grantDays: Number(f.grantDays),
        }
      })
      if (grants.length === 0) return null
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'executePendingGrants', grants }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        return { ok: false, error: err?.error }
      }
      setTouched(false)
      onSaved()
    } finally {
      setPendingExecuting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!pendingExecuting) onClose() }}
      title={`有給付与対象（${pendingGrants.length}名）`}
      sub="付与日・日数は各スタッフごとに調整できます。「付与する」のチェックを外すと今回はスキップされます。"
      size="lg"
      dirty={touched}
      footer={<>
        <CancelButton onClick={onClose} disabled={pendingExecuting} />
        <SaveButton action="付与" label={`一括付与する（${includeCount}名）`} onSave={execute}
          disabled={Object.values(pendingForm).every(f => !f.include)} />
      </>}
    >
      <div className="space-y-3">
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
                    {p.needsAttention && <span className="text-3xs bg-red-500 text-white px-1.5 py-0.5 rounded-md font-normal">要確認</span>}
                  </div>
                  <div className="text-2xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {visaLabel} | {p.tenureText} | {p.reason}
                  </div>
                  {p.attentionNote && (
                    <div className="text-3xs text-red-600 dark:text-red-400 mt-1">
                      {p.attentionNote}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1 text-xs cursor-pointer">
                  <input type="checkbox" checked={f.include}
                    onChange={e => { setTouched(true); setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, include: e.target.checked } })) }}
                    className="w-4 h-4" />
                  <span>付与する</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">付与日</label>
                  <input type="date" value={f.grantDate} disabled={!f.include} aria-invalid={!!rowErrors[p.workerId]}
                    onChange={e => { setTouched(true); clearRowError(p.workerId); setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDate: e.target.value } })) }}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                </div>
                <div>
                  <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">付与日数（法定 {p.legalDays}日）</label>
                  <input type="number" value={f.grantDays} disabled={!f.include} aria-invalid={!!rowErrors[p.workerId]}
                    onChange={e => { setTouched(true); clearRowError(p.workerId); setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDays: e.target.value } })) }}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                </div>
              </div>
              <FieldError>{rowErrors[p.workerId]}</FieldError>
            </div>
          )
        })}
      </div>

      {Object.keys(rowErrors).length > 0 && (
        <FieldError className="pt-3">
          付与日または日数が未入力・不正の行があります: {pendingGrants.filter(p => rowErrors[p.workerId]).map(p => p.name).join('、')}
        </FieldError>
      )}
    </Modal>
  )
}
