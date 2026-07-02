'use client'

import { useState } from 'react'
import { PLWorker, SiteOption } from '../types'

// 時季指定モーダル / 管理者手動P入力 (Phase 5 / 案B)
// kind により初期値が変わる:
//   designation  … 年5日未達バナーから。日付リスト空・上書きOFF・備考「年5日取得義務対応」
//   manual-entry … 編集モーダルから。日付1行・上書きON・備考「帰国期間中の有給申請を後から計上」

interface Props {
  worker: PLWorker
  kind: 'designation' | 'manual-entry'
  sites: SiteOption[]
  password: string
  onClose: () => void
  onSuccess: () => void  // 記録後: 編集モーダルも閉じて再取得
}

export default function DesignateModal({ worker, kind, sites, password, onClose, onSuccess }: Props) {
  const [designateDates, setDesignateDates] = useState<string[]>(kind === 'manual-entry' ? [''] : [])
  const [designateSiteId, setDesignateSiteId] = useState<string>(sites[0]?.id || '')
  const [designateNote, setDesignateNote] = useState<string>(
    kind === 'designation' ? '年5日取得義務対応' : '帰国期間中の有給申請を後から計上'
  )
  const [designateOverwriteHomeLeave, setDesignateOverwriteHomeLeave] = useState(kind === 'manual-entry')
  const [designateSubmitting, setDesignateSubmitting] = useState(false)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !designateSubmitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-5 animate-modalIn" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2 mb-4">
          <div className="text-2xl">🗓</div>
          <div>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white">
              {kind === 'designation' ? '時季指定' : '有給日を直接入力'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {worker.name}さん
              {kind === 'designation'
                ? ` / 消化 ${worker.periodUsed}日 → あと ${worker.fiveDayShortfall}日義務`
                : ` / 残 ${worker.remaining}日`}
            </p>
            {kind === 'manual-entry' && (
              <p className="text-[10px] text-indigo-600 dark:text-indigo-400 mt-1">
                ※ 出面に P を直接書き込みます。管理者の手動計上として監査ログに記録されます。
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">指定日（複数可）</label>
            <div className="space-y-1">
              {designateDates.map((d, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="date" value={d}
                    onChange={e => setDesignateDates(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm" />
                  <button onClick={() => setDesignateDates(prev => prev.filter((_, j) => j !== i))}
                    className="text-red-500 text-sm">×</button>
                </div>
              ))}
              <button onClick={() => setDesignateDates(prev => [...prev, ''])}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                + 日付を追加
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">対象現場</label>
            <select value={designateSiteId} onChange={e => setDesignateSiteId(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm">
              <option value="">-- 選択してください --</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-1">出面にPを記録する現場（当日の所属現場）</p>
          </div>

          <div>
            <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">備考（任意）</label>
            <input type="text" value={designateNote} onChange={e => setDesignateNote(e.target.value)}
              placeholder={kind === 'designation' ? '例: 年5日取得義務対応' : '例: 帰国期間中の有給申請を後から計上'}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
          </div>

          {/* 帰国期間上書きチェック */}
          <div className="flex items-start gap-2 p-2 bg-indigo-50 dark:bg-indigo-900/20 rounded border border-indigo-200 dark:border-indigo-700/50">
            <input type="checkbox" id="overwrite-hk" checked={designateOverwriteHomeLeave}
              onChange={e => setDesignateOverwriteHomeLeave(e.target.checked)}
              className="mt-0.5 w-4 h-4 cursor-pointer" />
            <label htmlFor="overwrite-hk" className="text-[11px] text-indigo-800 dark:text-indigo-200 cursor-pointer">
              <span className="font-bold">帰国期間(✈️)を上書きする</span>
              <div className="text-[10px] text-indigo-600 dark:text-indigo-400 mt-0.5">
                既存の帰国マーカーを削除して Pを書き込みます。帰国中でも事前に有給申請があった日を計上する場合に使用。
              </div>
            </label>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            disabled={designateSubmitting || designateDates.filter(d => !!d).length === 0 || !designateSiteId}
            onClick={async () => {
              const validDates = designateDates.filter(d => !!d)
              const label = kind === 'designation' ? '時季指定' : '有給として記録'
              const msg = `${worker.name}さんに以下の日を${label}しますか？\n${validDates.join('\n')}\n\n出面にPが自動入力され、履歴が記録されます。${designateOverwriteHomeLeave ? '\n\n⚠️ 既存の帰国マーカーは削除されます。' : ''}`
              if (!confirm(msg)) return
              setDesignateSubmitting(true)
              try {
                const res = await fetch('/api/leave', {
                  method: 'POST',
                  headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'designateLeaves',
                    workerId: worker.id,
                    dates: validDates,
                    siteId: designateSiteId,
                    note: designateNote,
                    kind,
                    overwriteHomeLeave: designateOverwriteHomeLeave,
                  }),
                })
                if (res.ok) {
                  onSuccess()
                } else {
                  alert('処理に失敗しました')
                }
              } finally { setDesignateSubmitting(false) }
            }}
            className={`flex-1 text-white rounded-lg py-2 font-bold text-sm disabled:opacity-50 ${kind === 'designation' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
            {designateSubmitting ? '処理中...' : (kind === 'designation' ? '時季指定する' : '有給を記録する')}
          </button>
          <button disabled={designateSubmitting} onClick={onClose}
            className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm disabled:opacity-50">
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
