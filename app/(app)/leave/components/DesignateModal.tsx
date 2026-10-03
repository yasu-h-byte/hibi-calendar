'use client'

import { useState } from 'react'
import { PLWorker, SiteOption } from '../types'
import { confirmDialog } from '@/lib/confirm-dialog'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
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
  // 日付を1つでも入れたら「保存していない変更」とみなす
  const dirty = designateDates.some(d => !!d)
  const actionLabel = kind === 'designation' ? '時季指定' : '有給の記録'

  const submit = async () => {
    // 同じ日の重複入力は1件に（2026-08-27）
    const validDates = [...new Set(designateDates.filter(d => !!d))]
    const label = kind === 'designation' ? '時季指定' : '有給として記録'
    if (!(await confirmDialog({
      title: `${worker.name}さんの ${validDates.length}日を${label}しますか？`,
      description: `${validDates.join('\n')}\n\n出面に P が自動で入り、履歴が記録されます。${designateOverwriteHomeLeave ? '\n既存の帰国の印は消えます。' : ''}`,
      confirmLabel: kind === 'designation' ? '時季指定する' : '記録する',
    }))) return null
    setDesignateSubmitting(true)
    try {
      const payload = {
        action: 'designateLeaves',
        workerId: worker.id,
        dates: validDates,
        siteId: designateSiteId,
        note: designateNote,
        kind,
        overwriteHomeLeave: designateOverwriteHomeLeave,
      }
      const post = (extra: Record<string, unknown> = {}) => fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...extra }),
      })
      let res = await post()
      // 残数超過（2026-08-04 追加）: 内容を明示したうえで、承知の場合のみ上書き実行。
      // 上書きはサーバ側で activityLog に記録される
      if (res.status === 409) {
        const err = await res.clone().json().catch(() => null)
        if (err?.code === 'LEAVE_OVERDRAFT') {
          const b = err.balance
          const over = await confirmDialog({
            title: '残数を超えて登録しますか？',
            description: `${worker.name}さんの有給残は ${b?.remaining ?? 0}日です（枠 ${b?.total}日 / 消化 ${b?.used}日）。\n`
              + `${validDates.length}日を登録すると枠を超えます。超えて登録した記録は残ります。`,
            confirmLabel: '超えて登録する',
          })
          if (!over) return null
          res = await post({ allowOverdraft: true })
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        return { ok: false, error: err?.error }
      }
      onSuccess()
    } finally { setDesignateSubmitting(false) }
  }

  return (
    <Modal
      open
      onClose={() => { if (!designateSubmitting) onClose() }}
      title={kind === 'designation' ? '時季指定' : '有給日を直接入力'}
      sub={<>
        {worker.name}さん
        {kind === 'designation'
          ? ` / 消化 ${worker.periodUsed}日 → あと ${worker.fiveDayShortfall}日義務`
          : ` / 残 ${worker.remaining}日`}
      </>}
      dirty={dirty}
      footer={<>
        <CancelButton onClick={onClose} disabled={designateSubmitting} />
        <SaveButton action={actionLabel}
          label={kind === 'designation' ? '時季指定する' : '有給を記録する'}
          onSave={submit}
          disabled={designateDates.filter(d => !!d).length === 0 || !designateSiteId} />
      </>}
    >
      {kind === 'manual-entry' && (
        <p className="text-3xs text-indigo-600 dark:text-indigo-400 mb-3">
          出面に P を直接書き込みます。管理者の手動計上として記録に残ります。
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">指定日（複数可）</label>
          <div className="space-y-1">
            {designateDates.map((d, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input type="date" value={d}
                  onChange={e => setDesignateDates(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                  className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm" />
                <button type="button" onClick={() => setDesignateDates(prev => prev.filter((_, j) => j !== i))}
                  className="text-red-500 text-sm" aria-label="この日を外す">×</button>
              </div>
            ))}
            <button type="button" onClick={() => setDesignateDates(prev => [...prev, ''])}
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
          <p className="text-3xs text-gray-400 mt-1">出面にPを記録する現場（当日の所属現場）</p>
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
          <label htmlFor="overwrite-hk" className="text-2xs text-indigo-800 dark:text-indigo-200 cursor-pointer">
            <span className="font-bold">帰国期間を上書きする</span>
            <div className="text-3xs text-indigo-600 dark:text-indigo-400 mt-0.5">
              既存の帰国の印を消して P を書き込みます。帰国中でも事前に有給申請があった日を計上する場合に使います。
            </div>
          </label>
        </div>
      </div>
    </Modal>
  )
}
