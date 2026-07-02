'use client'

import { PLWorker, PendingGrant } from '../types'

// 画面上部のアラートバナー群（繰越時効間近・未付与検知）
// ※ 年5日未達バナーは運用上不要のため非表示（2026-07-02 靖仁さん指示）

interface Props {
  workers: PLWorker[]
  pendingGrants: PendingGrant[]
  onOpenPendingModal: () => void
}

export default function AlertBanners({ workers, pendingGrants, onOpenPendingModal }: Props) {
  const expiringCarryOver = workers.filter(w =>
    (w.carryOverRemaining ?? 0) > 0 && w.carryOverExpiryStatus === 'warning'
  )

  return (
    <>
      {/* 繰越時効間近アラート (Phase 8) */}
      {expiringCarryOver.length > 0 && (
        <div className="w-full bg-gradient-to-r from-orange-50 to-yellow-50 dark:from-orange-900/30 dark:to-yellow-900/30 border border-orange-300 dark:border-orange-700 rounded-xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="text-2xl">⏰</div>
            <div>
              <div className="text-sm font-bold text-orange-900 dark:text-orange-200">
                繰越分の時効が近づいています: {expiringCarryOver.length}名
              </div>
              <div className="text-xs text-orange-700 dark:text-orange-300 mt-0.5">
                繰越分は先に消費される設計です。時効までに取得させることを推奨。
              </div>
            </div>
          </div>
          <div className="space-y-1 mt-3">
            {expiringCarryOver.map(w => (
              <div key={w.id} className="flex items-center justify-between gap-2 text-xs bg-white/80 dark:bg-gray-800/80 rounded px-2 py-1.5">
                <div>
                  <span className="font-medium">{w.name}</span>
                  <span className="text-gray-500 ml-2">繰越残 {w.carryOverRemaining}日 / 時効 {w.carryOverExpiryDate}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 未付与検知バナー */}
      {pendingGrants.length > 0 && (
        <button onClick={onOpenPendingModal}
          className="w-full bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/30 border border-amber-300 dark:border-amber-700 rounded-xl p-4 flex items-center justify-between hover:from-amber-100 hover:to-orange-100 dark:hover:from-amber-900/50 dark:hover:to-orange-900/50 transition text-left">
          <div className="flex items-center gap-3">
            <div className="text-2xl">🌴</div>
            <div>
              <div className="text-sm font-bold text-amber-900 dark:text-amber-200">
                {pendingGrants.length}名 に有給付与の時期が来ています
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                {pendingGrants.slice(0, 3).map(p => p.name).join('、')}
                {pendingGrants.length > 3 ? ` ほか${pendingGrants.length - 3}名` : ''}
              </div>
            </div>
          </div>
          <div className="text-xs font-bold bg-amber-600 text-white px-3 py-1.5 rounded-md">
            内容を確認する →
          </div>
        </button>
      )}
    </>
  )
}
