'use client'

/**
 * 出面の変更履歴と復元（2026-08-28 追加）
 *
 * 既存の記録を消した/上書きした操作だけが並ぶ。「元に戻す」で変更前の内容を書き戻す。
 * 8/27 IHI の誤削除では、操作ログに中身が残らず日次バックアップも当日分を救えなかった。
 */
import { useEffect, useState, useCallback } from 'react'

interface HistoryItem {
  id: string
  siteId: string
  workerId: number
  ym: string
  day: number
  before: Record<string, unknown>
  after: Record<string, unknown> | null
  beforeSource: string
  actor: string
  kind: 'delete' | 'overwrite'
  at: string
}

/** 出面エントリを人が読める1行に */
function describe(e: Record<string, unknown> | null): string {
  if (!e) return '（なし）'
  if (e.p) return '有給'
  if (e.r) return '欠勤'
  if (e.h) return '現場休'
  if (e.hk) return '帰国中'
  if (e.exam) return '試験'
  if (e.w === 0.6) return '0.6補償'
  const t = e.st && e.et ? ` ${e.st}〜${e.et}` : ''
  const ot = e.o ? ` 残業${e.o}h` : ''
  const ns = e.ns ? '（夜勤あり）' : ''
  return `出勤${t}${ot}${ns}`
}

export default function HistoryModal({
  open, onClose, ym, password, workerNames, onRestored,
}: {
  open: boolean
  onClose: () => void
  ym: string
  password: string
  workerNames: Record<number, string>
  onRestored: () => void
}) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/attendance/history?ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        const e = await res.json().catch(() => null)
        alert(e?.error || `履歴の取得に失敗しました (${res.status})`)
        return
      }
      setItems((await res.json()).items || [])
    } catch { alert('通信エラーが発生しました') } finally { setLoading(false) }
  }, [ym, password])

  useEffect(() => { if (open) load() }, [open, load])

  const restore = async (h: HistoryItem) => {
    const name = workerNames[h.workerId] || `ID ${h.workerId}`
    if (!confirm(
      `${name} さんの ${h.day}日 を、変更前の内容に戻します。\n\n`
      + `　戻す内容: ${describe(h.before)}\n`
      + `　現在の内容: ${describe(h.after)}\n\n`
      + `よろしいですか？（この操作も履歴に残るので、やり直せます）`
    )) return
    setBusy(h.id)
    try {
      const res = await fetch('/api/attendance/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ id: h.id }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => null)
        alert(e?.error || `復元に失敗しました (${res.status})`)
        return
      }
      await load()
      onRestored()
    } catch { alert('通信エラーが発生しました') } finally { setBusy(null) }
  }

  if (!open) return null
  const jst = (iso: string) => {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-5 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-1">出面の変更履歴</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          記録を<b>消した・上書きした</b>操作だけが並びます（新しい順・90日保持）。
          「元に戻す」で変更前の内容に戻せます。締め済みの月は戻せません。
        </p>

        {loading ? (
          <div className="py-10 text-center text-gray-400">読み込み中...</div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-gray-400">この月の変更履歴はありません</div>
        ) : (
          <div className="space-y-1.5">
            {items.map(h => (
              <div key={h.id}
                   className={`flex items-center gap-3 p-2.5 rounded-lg border text-sm
                     ${h.beforeSource === 'staff'
                       ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/20'
                       : 'border-gray-200 dark:border-gray-700'}`}>
                <div className="text-[11px] text-gray-400 whitespace-nowrap tabular-nums w-16">{jst(h.at)}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">
                    {workerNames[h.workerId] || `ID ${h.workerId}`}
                    <span className="text-gray-400 font-normal"> / {h.day}日</span>
                    {h.beforeSource === 'staff' && (
                      <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-bold">
                        スマホ入力
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-300 truncate">
                    {describe(h.before)}
                    <span className="text-gray-400 mx-1">→</span>
                    <span className={h.kind === 'delete' ? 'text-red-600 font-bold' : ''}>
                      {h.kind === 'delete' ? '削除' : describe(h.after)}
                    </span>
                    <span className="text-gray-400 ml-2">({h.actor})</span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy === h.id}
                  onClick={() => restore(h)}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg bg-hibi-navy text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
                >
                  {busy === h.id ? '復元中...' : '元に戻す'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button onClick={onClose}
                  className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
