/**
 * 給与計算根拠の透明化モーダル
 *
 * 2026-06-XX リファクタ: 表示本体は PayrollAuditContent に分離
 *   このファイルはモーダルの枠（ヘッダー・閉じるボタン・スクロール領域）
 *   のみを担当。表示内容はすべて PayrollAuditContent に集約され、
 *   印刷ページ (/monthly/audit-print) とも共有される。
 */
'use client'

import { jobShortLabel } from '@/lib/jobs'
import PayrollAuditContent, { type PayrollAuditWorker } from './PayrollAuditContent'

interface Props {
  worker: PayrollAuditWorker
  ym: string
  prescribedDays: number
  baseDays: number
  onClose: () => void
}

export default function PayrollAuditModal({ worker: w, ym, prescribedDays, baseDays, onClose }: Props) {
  const orgName = w.org === 'hfu' ? 'HFU' : '日比建設'
  const yearStr = `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月`

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-2 flex items-start sm:items-center justify-center overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl my-4 flex flex-col max-h-[95vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="bg-hibi-navy text-white px-5 py-4 rounded-t-xl flex items-center justify-between">
          <div>
            <div className="font-bold text-lg leading-tight flex items-center gap-2">
              🔍 給与計算の根拠
              <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-normal">{yearStr}</span>
            </div>
            <div className="text-sm opacity-80 mt-0.5">
              {w.name} ({orgName} / {jobShortLabel(w.job)}) — ID:{w.id}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* 本文（PayrollAuditContent に委譲） */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <PayrollAuditContent
            worker={w}
            ym={ym}
            prescribedDays={prescribedDays}
            baseDays={baseDays}
          />
        </div>

        {/* フッター */}
        <div className="border-t border-gray-200 px-5 py-3 bg-gray-50 rounded-b-xl flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:bg-[#243656]"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
