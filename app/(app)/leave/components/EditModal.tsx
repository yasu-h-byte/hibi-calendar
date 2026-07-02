'use client'

import { useState } from 'react'
import { PLWorker } from '../types'

// 有給編集モーダル（付与日・付与日数・繰越・調整 + 監査情報・各種履歴の表示）
// worker が選択されたときだけマウントされ、開くたびにフォームを対象者の値で初期化する

interface Props {
  worker: PLWorker
  password: string
  onClose: () => void
  onSaved: () => void
  onOpenDesignate: (worker: PLWorker) => void
  onOpenBuyout: (worker: PLWorker) => void
}

export default function EditModal({ worker, password, onClose, onSaved, onOpenDesignate, onOpenBuyout }: Props) {
  const [editForm, setEditForm] = useState({
    grantDays: String(worker.grantDays),
    carryOver: String(worker.carryOver),
    adjustment: String(worker.adjustment),
    grantDate: worker.grantDate || '',
  })
  const [saving, setSaving] = useState(false)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">{worker.name} - 有給編集</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
              付与日（有給サイクルの開始日）
            </label>
            <input type="date" value={editForm.grantDate}
              onChange={e => setEditForm({ ...editForm, grantDate: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
            {worker.inferredFromDefault && (
              <p className="text-[10px] text-blue-600 mt-1">
                💡 日本人社員のデフォルト「10/1〜9/30」を自動適用中。明示的に保存すると確定します。
              </p>
            )}
            <p className="text-[10px] text-gray-400 mt-1">
              日本人社員は決算期に合わせて毎年10/1付与（10/1〜9/30）がデフォルトです。<br/>
              個別に変更したい場合のみ日付を選び直してください。
            </p>
            {editForm.grantDate && (() => {
              const gd = new Date(editForm.grantDate)
              const end = new Date(gd); end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1)
              const expiry = new Date(gd); expiry.setFullYear(expiry.getFullYear() + 2); expiry.setDate(expiry.getDate() - 1)
              const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
              return (
                <div className="text-[10px] text-gray-500 mt-1">
                  期間: {fmt(gd)} 〜 {fmt(end)} / 当期付与の有効期限: {fmt(expiry)}
                </div>
              )
            })()}

            {/* Phase 8: FIFO内訳表示 */}
            {((worker.carryOverRemaining ?? 0) > 0 || (worker.grantRemaining ?? 0) > 0) && (
              <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
                <div className="text-[11px] font-bold text-blue-800 dark:text-blue-200 mb-1">
                  📊 残日数の内訳（FIFO：繰越分から先に消費）
                </div>
                <div className="space-y-1">
                  {(worker.carryOverRemaining ?? 0) > 0 && (
                    <div className={`text-[11px] ${worker.carryOverExpiryStatus === 'warning' ? 'text-orange-700 dark:text-orange-300 font-bold' : worker.carryOverExpiryStatus === 'expired' ? 'text-red-700 dark:text-red-300 font-bold' : 'text-blue-700 dark:text-blue-300'}`}>
                      {worker.carryOverExpiryStatus === 'warning' && '⏰ '}
                      {worker.carryOverExpiryStatus === 'expired' && '❌ '}
                      繰越分: <strong>{worker.carryOverRemaining}日</strong>
                      {worker.carryOverExpiryDate && <span className="ml-1 text-[10px]">（時効: {worker.carryOverExpiryDate}）</span>}
                      {worker.carryOverExpiryStatus === 'warning' && <span className="ml-1 text-[10px]">← 時効間近・優先消化推奨</span>}
                    </div>
                  )}
                  {(worker.grantRemaining ?? 0) > 0 && (
                    <div className="text-[11px] text-blue-700 dark:text-blue-300">
                      当期付与: <strong>{worker.grantRemaining}日</strong>
                      {worker.grantExpiryDate && <span className="ml-1 text-[10px]">（時効: {worker.grantExpiryDate}）</span>}
                    </div>
                  )}
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 pt-1 border-t border-blue-200 dark:border-blue-700/30">
                    合計残: {(worker.carryOverRemaining ?? 0) + (worker.grantRemaining ?? 0)}日
                  </div>
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日数</label>
            <input type="number" value={editForm.grantDays} onChange={e => setEditForm({ ...editForm, grantDays: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
          {(() => {
            const isJp = !worker.visa || worker.visa === 'none'
            if (isJp) {
              return (
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">繰越日数</label>
                  <input type="number" value="0" disabled
                    className="w-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-400 rounded-lg px-3 py-2 text-sm cursor-not-allowed" />
                  <p className="text-[10px] text-gray-500 mt-1">
                    💼 日本人社員は期末買取制のため繰越なし（強制0）
                  </p>
                </div>
              )
            }
            return (
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">繰越日数</label>
                <input type="number" value={editForm.carryOver} onChange={e => setEditForm({ ...editForm, carryOver: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
              </div>
            )
          })()}
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
              調整（過去の消化分など、カレンダー外で計上したい日数）
            </label>
            <input type="number" value={editForm.adjustment} onChange={e => setEditForm({ ...editForm, adjustment: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>

          {/* 操作ボタン (Phase 5/6/B) */}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => onOpenDesignate(worker)}
              className="flex-1 bg-indigo-500 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-indigo-600"
              title="帰国期間中などにPを後から入力する場合">
              🗓 有給日を直接入力
            </button>
            <button type="button" onClick={() => onOpenBuyout(worker)}
              className="flex-1 bg-amber-500 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-amber-600">
              💰 買取を記録
            </button>
          </div>

          {/* 時季指定 / 手動有給入力履歴 */}
          {worker.designatedLeaves && worker.designatedLeaves.length > 0 && (
            <div className="mt-2 p-2 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-700/50">
              <div className="text-[10px] font-bold text-indigo-800 dark:text-indigo-200 mb-1">
                🗓 有給日 直接入力 / 時季指定 履歴（累計 {worker.designatedLeaves.length}日）
              </div>
              <div className="space-y-0.5 max-h-32 overflow-auto">
                {worker.designatedLeaves.slice().reverse().map((h, i) => (
                  <div key={i} className="text-[10px] text-indigo-700 dark:text-indigo-300 flex flex-wrap gap-1">
                    <span className="font-medium tabular-nums">{h.date}</span>
                    <span className="text-indigo-500">
                      ({h.kind === 'manual-entry' ? '手動入力' : '時季指定'})
                    </span>
                    {h.overwroteHomeLeave && (
                      <span className="text-[9px] bg-cyan-100 text-cyan-700 px-1 rounded">✈帰国期間上書き</span>
                    )}
                    {h.note && <span className="text-indigo-400">- {h.note}</span>}
                    <span className="text-indigo-400 ml-auto">
                      {new Date(h.designatedAt).toLocaleDateString('ja-JP')}{' '}
                      {h.designatedBy === 'super-admin' ? '日比靖仁' : h.designatedBy === 'admin' ? '管理者' : `ID ${h.designatedBy}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 買取履歴 */}
          {worker.buyoutHistory && worker.buyoutHistory.length > 0 && (
            <div className="mt-2 p-2 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
              <div className="text-[10px] font-bold text-amber-800 dark:text-amber-200 mb-1">
                💰 買取記録（累計 {worker.buyoutDays || 0}日）
              </div>
              <div className="space-y-0.5 max-h-20 overflow-auto">
                {worker.buyoutHistory.slice().reverse().map((h, i) => (
                  <div key={i} className="text-[10px] text-amber-700 dark:text-amber-300">
                    {new Date(h.at).toLocaleDateString('ja-JP')}: {h.days}日
                    {h.amount ? ` (¥${h.amount.toLocaleString()})` : ''}
                    {h.reason === 'year-end' ? ' 期末買取' : h.reason === 'retirement' ? ' 退職清算' : ''}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 監査情報セクション */}
          {(worker.grantedAt || worker.method || (worker.adjustmentHistory && worker.adjustmentHistory.length > 0)) && (
            <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
              <div className="text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-2">📋 監査情報</div>
              {worker.method && (
                <div className="text-[10px] text-gray-500 dark:text-gray-400">
                  付与方法: <span className="font-medium">{
                    worker.method === 'manual' ? '手動付与' :
                    worker.method === 'auto-pending' ? '半自動付与' :
                    worker.method === 'migration' ? 'データ正規化' :
                    worker.method === 'legacy' ? '旧データ' :
                    worker.method
                  }</span>
                </div>
              )}
              {worker.grantedAt && (
                <div className="text-[10px] text-gray-500 dark:text-gray-400">
                  付与日時: {new Date(worker.grantedAt).toLocaleString('ja-JP')}
                  {worker.grantedBy !== undefined && ` / 操作者: ${worker.grantedBy === 'super-admin' ? '日比靖仁' : worker.grantedBy === 'admin' ? '管理者' : `ID ${worker.grantedBy}`}`}
                </div>
              )}
              {worker.lastEditedAt && worker.lastEditedAt !== worker.grantedAt && (
                <div className="text-[10px] text-gray-500 dark:text-gray-400">
                  最終編集: {new Date(worker.lastEditedAt).toLocaleString('ja-JP')}
                  {worker.lastEditedBy !== undefined && ` / ${worker.lastEditedBy === 'super-admin' ? '日比靖仁' : worker.lastEditedBy === 'admin' ? '管理者' : `ID ${worker.lastEditedBy}`}`}
                </div>
              )}
              {worker.adjustmentHistory && worker.adjustmentHistory.length > 0 && (
                <details className="mt-2">
                  <summary className="text-[10px] text-gray-600 dark:text-gray-400 cursor-pointer font-medium">変更履歴 ({worker.adjustmentHistory.length}件)</summary>
                  <div className="mt-1 space-y-1 max-h-32 overflow-auto">
                    {worker.adjustmentHistory.slice().reverse().map((h, i) => (
                      <div key={i} className="text-[10px] text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 rounded px-2 py-1">
                        <span className="text-gray-400">{new Date(h.at).toLocaleString('ja-JP')}</span>
                        {' '}
                        <span className="font-medium">{h.field}</span>: {h.before} → {h.after}
                        {' '}
                        <span className="text-gray-400">({h.by === 'super-admin' ? '日比靖仁' : h.by === 'admin' ? '管理者' : `ID ${h.by}`})</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-6">
          <button disabled={saving} onClick={async () => {
            setSaving(true)
            try {
              // 日本人社員は繰越強制0
              const isJp = !worker.visa || worker.visa === 'none'
              const payload = { ...editForm, ...(isJp ? { carryOver: '0' } : {}) }
              await fetch('/api/leave', {
                method: 'POST',
                headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                body: JSON.stringify({ workerId: worker.id, fy: worker.grantDate ? worker.grantDate.slice(0, 4) : String(new Date().getFullYear()), ...payload }),
              })
              onSaved()
            } finally { setSaving(false) }
          }} className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
          <button onClick={onClose} className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm">キャンセル</button>
        </div>
      </div>
    </div>
  )
}
