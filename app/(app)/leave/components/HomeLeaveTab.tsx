'use client'

import { useState } from 'react'
import { HomeLeave, PLWorker } from '../types'
import { todayJstIso } from '@/lib/date-utils'

// 帰国情報タブ（旧 home-leave ページから統合）
// フォーム・開閉状態はデータ再取得で画面全体が読み込み表示に切り替わっても
// 消えないよう、親（page）が保持する

export interface HomeLeaveUiState {
  formOpen: boolean
  showPast: boolean
  formWorkerId: number | ''
  formStart: string
  formEnd: string
  formReason: string
  formNote: string
  formUndecided: boolean       // 2026-07-18: 復帰日 未定（急な帰国）
  editingId: string | null
  editStart: string
  editEnd: string
  editReason: string
  editNote: string
  editUndecided: boolean       // 2026-07-18: 編集時の復帰未定トグル
  deleteConfirm: string | null
}

export const initialHomeLeaveUi: HomeLeaveUiState = {
  formOpen: false,
  showPast: false,
  formWorkerId: '',
  formStart: '',
  formEnd: '',
  formReason: '一時帰国',
  formNote: '',
  formUndecided: false,
  editingId: null,
  editStart: '',
  editEnd: '',
  editReason: '',
  editNote: '',
  editUndecided: false,
  deleteConfirm: null,
}

interface Props {
  visible: boolean
  homeLeaves: HomeLeave[]
  workers: PLWorker[]
  password: string
  ui: HomeLeaveUiState
  patchUi: (patch: Partial<HomeLeaveUiState>) => void
  onRefresh: () => void
}

export default function HomeLeaveTab({ visible, homeLeaves, workers, password, ui, patchUi, onRefresh }: Props) {
  const [hlSaving, setHlSaving] = useState(false)

  if (!visible) return null

  // 計算ヘルパー（今日は日本時間で判定 — UTCだとJST朝に1日ズレる）
  const today = todayJstIso()
  const fmt = (s: string) => {
    const d = new Date(s + 'T00:00:00')
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }
  const daysBetween = (s: string, e: string) => {
    const sd = new Date(s + 'T00:00:00')
    const ed = new Date(e + 'T00:00:00')
    return Math.ceil((ed.getTime() - sd.getTime()) / (24 * 60 * 60 * 1000)) + 1
  }
  // 復帰未定（番兵終了日）判定。API GET が returnUndecided を正規化して返す
  const isUndecided = (h: HomeLeave) => !!h.returnUndecided
  const currentLeaves = homeLeaves.filter(h => h.startDate <= today && h.endDate >= today)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
  const upcomingLeaves = homeLeaves.filter(h => h.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
  const pastLeaves = homeLeaves.filter(h => h.endDate < today)
    .sort((a, b) => b.endDate.localeCompare(a.endDate))

  // 操作ハンドラ
  const handleHlAdd = async () => {
    // 復帰未定なら帰国日は不要
    if (!ui.formWorkerId || !ui.formStart || (!ui.formUndecided && !ui.formEnd)) return
    setHlSaving(true)
    try {
      const w = workers.find(w => w.id === Number(ui.formWorkerId))
      const res = await fetch('/api/home-leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          workerId: Number(ui.formWorkerId),
          workerName: w?.name || '',
          startDate: ui.formStart,
          ...(ui.formUndecided ? { returnUndecided: true } : { endDate: ui.formEnd }),
          reason: ui.formReason,
          note: ui.formNote,
        }),
      })
      if (res.ok) {
        patchUi({ formOpen: false, formWorkerId: '', formStart: '', formEnd: '', formReason: '一時帰国', formNote: '', formUndecided: false })
        onRefresh()
      }
    } finally { setHlSaving(false) }
  }
  const startHlEdit = (h: HomeLeave) => {
    patchUi({ editingId: h.id, editStart: h.startDate, editEnd: isUndecided(h) ? '' : h.endDate, editReason: h.reason, editNote: h.note || '', editUndecided: isUndecided(h) })
  }
  const cancelHlEdit = () => {
    patchUi({ editingId: null })
  }
  const handleHlUpdate = async (id: string) => {
    if (!ui.editUndecided && !ui.editEnd) return
    setHlSaving(true)
    try {
      const res = await fetch('/api/home-leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id,
          startDate: ui.editStart,
          // editUndecided の状態を明示送信（true→未定へ / false→復帰日確定）
          returnUndecided: ui.editUndecided,
          ...(ui.editUndecided ? {} : { endDate: ui.editEnd }),
          reason: ui.editReason,
          note: ui.editNote,
        }),
      })
      if (res.ok) {
        cancelHlEdit()
        onRefresh()
      }
    } finally { setHlSaving(false) }
  }
  const handleHlDelete = async (id: string) => {
    setHlSaving(true)
    try {
      const res = await fetch('/api/home-leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      })
      if (res.ok) {
        patchUi({ deleteConfirm: null })
        onRefresh()
      }
    } finally { setHlSaving(false) }
  }

  const renderHlCard = (h: HomeLeave, section: 'current' | 'upcoming') => {
    const undecided = isUndecided(h)
    const totalDays = daysBetween(h.startDate, h.endDate)
    const dayMs = 24 * 60 * 60 * 1000
    const todayD = new Date(today + 'T00:00:00')
    const startD = new Date(h.startDate + 'T00:00:00')
    const endD = new Date(h.endDate + 'T00:00:00')
    const daysRemaining = Math.ceil((endD.getTime() - todayD.getTime()) / dayMs)
    const daysUntilDeparture = Math.ceil((startD.getTime() - todayD.getTime()) / dayMs)
    // 帰国からの経過日数（復帰未定カードで「◯日経過」を出す）
    const daysSinceDeparture = Math.max(0, Math.ceil((todayD.getTime() - startD.getTime()) / dayMs))

    if (ui.editingId === h.id) {
      return (
        <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-blue-300 dark:border-blue-600">
          <div className="font-semibold mb-3 text-gray-900 dark:text-white">{h.workerName}</div>
          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">出発日</label>
              <input type="date" value={ui.editStart} onChange={e => patchUi({ editStart: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">帰国日（復帰日）</label>
              <input type="date" value={ui.editEnd} disabled={ui.editUndecided} onChange={e => patchUi({ editEnd: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-40 disabled:bg-gray-100 dark:disabled:bg-gray-900" />
            </div>
          </div>
          <label className="flex items-center gap-2 mb-3 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={ui.editUndecided}
              onChange={e => patchUi({ editUndecided: e.target.checked })} className="w-4 h-4" />
            復帰日は未定（急な帰国・戻る時期が決まっていない）
          </label>
          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1">理由</label>
            <select value={ui.editReason} onChange={e => patchUi({ editReason: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white">
              {['一時帰国', 'ビザ更新帰国', 'その他'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1">備考</label>
            <textarea value={ui.editNote} onChange={e => patchUi({ editNote: e.target.value })} rows={2}
              className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => handleHlUpdate(h.id)} disabled={hlSaving}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">保存</button>
            <button onClick={cancelHlEdit}
              className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded">キャンセル</button>
          </div>
        </div>
      )
    }

    return (
      <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-gray-900 dark:text-white">{h.workerName}</div>
          {section === 'current' && (undecided ? (
            <span className="text-xs px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full font-medium">
              帰国中・復帰未定（{daysSinceDeparture}日経過）
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full">
              帰国まで {daysRemaining}日
            </span>
          ))}
          {section === 'upcoming' && (
            <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">
              出発まで {daysUntilDeparture}日
            </span>
          )}
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
          {undecided ? (
            <div>{fmt(h.startDate)} 〜 <span className="text-amber-600 dark:text-amber-400 font-medium">復帰未定</span></div>
          ) : (
            <div>{fmt(h.startDate)} 〜 {fmt(h.endDate)} <span className="text-gray-400 ml-2">({totalDays}日間)</span></div>
          )}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {h.reason}{h.note && <span className="ml-2">- {h.note}</span>}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          {undecided && section === 'current' && (
            <button onClick={() => patchUi({ editingId: h.id, editStart: h.startDate, editEnd: today, editReason: h.reason, editNote: h.note || '', editUndecided: false })}
              className="px-3 py-1 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600">復帰日を登録</button>
          )}
          <button onClick={() => startHlEdit(h)}
            className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200">編集</button>
          {ui.deleteConfirm === h.id ? (
            <div className="flex gap-1">
              <button onClick={() => handleHlDelete(h.id)} disabled={hlSaving}
                className="px-3 py-1 text-xs font-bold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">削除する</button>
              <button onClick={() => patchUi({ deleteConfirm: null })}
                className="px-3 py-1 text-xs bg-gray-200 text-gray-700 rounded">やめる</button>
            </div>
          ) : (
            <button onClick={() => patchUi({ deleteConfirm: h.id })}
              className="px-3 py-1 text-xs bg-red-50 dark:bg-red-900/20 text-red-600 rounded hover:bg-red-100">削除</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* 新規登録 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm">
        <button onClick={() => patchUi({ formOpen: !ui.formOpen })}
          className="w-full px-4 py-3 flex items-center justify-between text-left">
          <span className="font-medium text-gray-900 dark:text-white">＋ 新規登録</span>
          <span className="text-gray-400 text-lg">{ui.formOpen ? '−' : '＋'}</span>
        </button>
        {ui.formOpen && (
          <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700 pt-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">スタッフ</label>
              <select value={ui.formWorkerId}
                onChange={e => patchUi({ formWorkerId: e.target.value ? Number(e.target.value) : '' })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                <option value="">選択してください</option>
                {workers.filter(w => w.visa && w.visa !== 'none').map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">出発日</label>
                <input type="date" value={ui.formStart} onChange={e => patchUi({ formStart: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">帰国日</label>
                <input type="date" value={ui.formEnd} disabled={ui.formUndecided} onChange={e => patchUi({ formEnd: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-40 disabled:bg-gray-100 dark:disabled:bg-gray-900" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input type="checkbox" checked={ui.formUndecided}
                onChange={e => patchUi({ formUndecided: e.target.checked, ...(e.target.checked ? { formEnd: '' } : {}) })} className="w-4 h-4" />
              復帰日は未定（急な帰国・戻る時期が決まっていない）
            </label>
            <div>
              <label className="block text-sm text-gray-600 mb-1">理由</label>
              <select value={ui.formReason} onChange={e => patchUi({ formReason: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                {['一時帰国', 'ビザ更新帰国', 'その他'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">備考</label>
              <textarea value={ui.formNote} onChange={e => patchUi({ formNote: e.target.value })} rows={2} placeholder="任意"
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
            <button onClick={handleHlAdd}
              disabled={hlSaving || !ui.formWorkerId || !ui.formStart || (!ui.formUndecided && !ui.formEnd)}
              className="w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
              {hlSaving ? '登録中...' : '登録する'}
            </button>
          </div>
        )}
      </div>

      {/* 現在帰国中 */}
      <div>
        <div className="border-l-4 border-red-500 pl-3 mb-3">
          <h2 className="font-bold text-gray-900 dark:text-white">
            現在帰国中
            {currentLeaves.length > 0 && (
              <span className="ml-2 text-sm font-normal text-red-600">({currentLeaves.length}名)</span>
            )}
          </h2>
        </div>
        {currentLeaves.length === 0 ? (
          <div className="text-sm text-gray-400 pl-7">現在帰国中のスタッフはいません</div>
        ) : (
          <div className="space-y-3">{currentLeaves.map(h => renderHlCard(h, 'current'))}</div>
        )}
      </div>

      {/* 帰国予定 */}
      <div>
        <div className="border-l-4 border-blue-500 pl-3 mb-3">
          <h2 className="font-bold text-gray-900 dark:text-white">
            帰国予定
            {upcomingLeaves.length > 0 && (
              <span className="ml-2 text-sm font-normal text-blue-600">({upcomingLeaves.length}件)</span>
            )}
          </h2>
        </div>
        {upcomingLeaves.length === 0 ? (
          <div className="text-sm text-gray-400 pl-7">帰国予定はありません</div>
        ) : (
          <div className="space-y-3">{upcomingLeaves.map(h => renderHlCard(h, 'upcoming'))}</div>
        )}
      </div>

      {/* 過去履歴 */}
      <div>
        <div className="border-l-4 border-gray-300 pl-3 mb-3">
          <button onClick={() => patchUi({ showPast: !ui.showPast })}
            className="font-bold text-gray-600 dark:text-gray-400 flex items-center gap-2">
            過去の帰国履歴
            {pastLeaves.length > 0 && <span className="text-sm font-normal">({pastLeaves.length}件)</span>}
            <span className="text-sm">{ui.showPast ? '▲' : '▼'}</span>
          </button>
        </div>
        {ui.showPast && (pastLeaves.length === 0 ? (
          <div className="text-sm text-gray-400 pl-7">過去の帰国履歴はありません</div>
        ) : (
          <div className="space-y-2">
            {pastLeaves.map(h => (
              <div key={h.id} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{h.workerName}</span>
                  <span className="text-xs text-gray-400">{h.reason}</span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {fmt(h.startDate)} 〜 {fmt(h.endDate)} <span className="ml-2">({daysBetween(h.startDate, h.endDate)}日間)</span>
                </div>
                {h.note && <div className="text-xs text-gray-400 mt-1">{h.note}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
