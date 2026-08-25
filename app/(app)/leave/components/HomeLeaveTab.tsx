'use client'

import { useState } from 'react'
import { HomeLeave, PLWorker } from '../types'
import { todayJstIso } from '@/lib/date-utils'
import { fetchWithAuth, postJson } from '@/lib/api-client'

/** 出面に残った帰国フラグの突合結果 */
interface OrphanDay { date: string; workerId: number; locked: boolean }
type ReconcileState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'checked'; orphans: OrphanDay[] }
  | { status: 'fixing'; orphans: OrphanDay[] }
  | { status: 'fixed'; removed: number; skippedLocked: number }
  | { status: 'error'; message: string }

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
  // 出面の帰国フラグ突合（2026-08-03 追加）。詳細は app/api/home-leave/reconcile/route.ts
  const [reconcile, setReconcile] = useState<ReconcileState>({ status: 'idle' })

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
  /**
   * 帰国期間の中に出勤打刻がある場合（409 WORKED_DAYS_IN_RANGE）の対話処理。
   * 2026-08-20 追加。終了日に「復帰日」を入れる入力ミスが繰り返し起きたため
   * （ファン: 帰国8日→正しくは7日 / フン: 帰国18日→正しくは13日で基本給63,888円の過少）。
   * 打刻と矛盾する期間は保存前に止め、正しい最終帰国日を提案して1クリックで直せるようにする。
   *
   * @returns 提案日で再送信するなら その日付、キャンセルなら null
   */
  const askFixEndDate = async (res: Response): Promise<string | null> => {
    let data: { error?: string; message?: string; suggestedEndDate?: string; conflicts?: { date: string; summary: string }[] } = {}
    try { data = await res.json() } catch { /* JSONでなければ後段でnull */ }
    if (data.error !== 'WORKED_DAYS_IN_RANGE' || !data.suggestedEndDate) {
      if (data.message) alert(data.message)
      return null
    }
    const list = (data.conflicts || []).slice(0, 8).map(c => `　${c.date}  ${c.summary}`).join('\n')
    const more = (data.conflicts || []).length > 8 ? `\n　…他${(data.conflicts || []).length - 8}日` : ''
    const ok = confirm(
      `${data.message}\n\n【出勤打刻のある日】\n${list}${more}\n\n` +
      `OK … 最終帰国日を ${data.suggestedEndDate} に直して登録する\n` +
      `キャンセル … 入力画面に戻る`
    )
    return ok ? data.suggestedEndDate : null
  }

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
        return
      }
      if (res.status === 409) {
        const fixed = await askFixEndDate(res)
        if (!fixed) { patchUi({ formEnd: '' }); return }
        const retry = await fetch('/api/home-leave', {
          method: 'POST',
          headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            workerId: Number(ui.formWorkerId),
            workerName: w?.name || '',
            startDate: ui.formStart,
            endDate: fixed,
            reason: ui.formReason,
            note: ui.formNote,
          }),
        })
        if (retry.ok) {
          patchUi({ formOpen: false, formWorkerId: '', formStart: '', formEnd: '', formReason: '一時帰国', formNote: '', formUndecided: false })
          onRefresh()
        }
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
        return
      }
      if (res.status === 409) {
        const fixed = await askFixEndDate(res)
        if (!fixed) return
        const retry = await fetch('/api/home-leave', {
          method: 'POST',
          headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update', id,
            startDate: ui.editStart,
            returnUndecided: false,
            endDate: fixed,
            reason: ui.editReason,
            note: ui.editNote,
          }),
        })
        if (retry.ok) { cancelHlEdit(); onRefresh() }
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
              <label className="block text-xs text-gray-500 mb-1">
                最終帰国日
                <span className="block text-[10px] text-gray-400 leading-tight">この日まで帰国（翌日から出勤）</span>
              </label>
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
          {/* 期間の変更履歴（2026-08-25 追加）。
              当初いつまでの予定だったかが分からず活動ログを直接調べる必要があったため、
              カードから直接追えるようにした。変更が無いレコードには何も出さない。 */}
          {(() => {
            const hist = h.changeHistory || []
            // 申請〜承認の経緯。既にデータは保存されていたが画面に出していなかった。
            // 承認がどこで止まっているかも見えるようになる。
            const flow: { label: string; at: string }[] = []
            if (h.requestedAt) flow.push({ label: '本人が申請', at: h.requestedAt })
            if (h.foremanApprovedAt) flow.push({ label: '職長が承認', at: h.foremanApprovedAt })
            if (h.reviewedAt) flow.push({ label: '最終承認', at: h.reviewedAt })
            if (hist.length === 0 && flow.length === 0) return null
            return (
              <div className="mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-gray-600 space-y-2">
                {flow.length > 0 && (
                  <div>
                    <div className="text-[10px] text-gray-400 mb-1">申請の経緯</div>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                      {flow.map((f, i) => (
                        <span key={i} className="flex items-center gap-1.5">
                          {i > 0 && <span className="text-gray-300">→</span>}
                          <span>{f.at.slice(0, 10)}</span>
                          <span className="text-gray-600 dark:text-gray-300">{f.label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {hist.length > 0 && (
                  <div>
                    <div className="text-[10px] text-gray-400 mb-1">期間の変更履歴</div>
                    <div className="space-y-1">
                      {hist.map((ch, i) => (
                        <div key={i} className="text-[11px] text-gray-500 dark:text-gray-400">
                          <div className="tabular-nums">
                            <span className="text-gray-400">{ch.at.slice(0, 10)}</span>
                            <span className="mx-1.5">{ch.field === 'endDate' ? '最終帰国日' : ch.field === 'startDate' ? '出発日' : ch.field}</span>
                            <span className="line-through text-gray-400">{fmt(ch.before)}</span>
                            <span className="mx-1">→</span>
                            <span className="font-medium text-gray-700 dark:text-gray-200">{fmt(ch.after)}</span>
                          </div>
                          {ch.note && (
                            <div className="text-[10px] text-gray-400 pl-1 mt-0.5">{ch.note}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
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
                <label className="block text-sm text-gray-600 mb-1">
                  最終帰国日
                  <span className="block text-[11px] font-normal text-gray-400 leading-tight">この日まで帰国（翌日から出勤）</span>
                </label>
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

      {/* ── 出面の帰国フラグ点検（2026-08-03 追加） ──
          帰国フラグは承認時に出面へ実際に書き込まれる実体データ。2026-08-03 以前は
          期間変更・削除が出面へ同期されず、どの申請にも紐づかない残骸が発生していた。
          書き込み側は lib/home-leave-sync.ts で根治済みだが、過去データの掃除用に残す。 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-4">
        <h3 className="font-bold text-hibi-navy dark:text-gray-200 flex items-center gap-2">
          🔍 出面の帰国表示を点検
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          出面入力画面に、どの帰国申請にも対応しない「✈帰国」が残っていないか調べます。
          期間を変更したのに古い帰国表示が消えない場合はここで確認してください。
          先に検出だけ行い、内容を確認してから削除します。
        </p>

        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={async () => {
              setReconcile({ status: 'checking' })
              try {
                const res = await fetchWithAuth('/api/home-leave/reconcile', { password })
                if (!res.ok) throw new Error(`検出に失敗しました (${res.status})`)
                const data = await res.json()
                setReconcile({ status: 'checked', orphans: data.orphans || [] })
              } catch (e) {
                setReconcile({ status: 'error', message: e instanceof Error ? e.message : '通信エラー' })
              }
            }}
            disabled={reconcile.status === 'checking' || reconcile.status === 'fixing'}
            className="bg-white border border-gray-300 text-hibi-navy dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {reconcile.status === 'checking' ? '検出中...' : '残っている帰国表示を検出'}
          </button>

          {reconcile.status === 'checked' && reconcile.orphans.filter(o => !o.locked).length > 0 && (
            <button
              onClick={async () => {
                const orphans = reconcile.status === 'checked' ? reconcile.orphans : []
                setReconcile({ status: 'fixing', orphans })
                const r = await postJson<{ removed: number; skippedLocked: number }>(
                  '/api/home-leave/reconcile', { fix: true }, { password },
                )
                if (!r.ok || !r.data) {
                  setReconcile({ status: 'error', message: r.error || '削除に失敗しました' })
                  return
                }
                setReconcile({ status: 'fixed', removed: r.data.removed, skippedLocked: r.data.skippedLocked })
                onRefresh()
              }}
              className="bg-hibi-navy hover:bg-hibi-light text-white rounded-lg px-4 py-2 text-sm font-bold"
            >
              {reconcile.orphans.filter(o => !o.locked).length}件を削除する
            </button>
          )}
        </div>

        {reconcile.status === 'checked' && (
          reconcile.orphans.length === 0 ? (
            <div className="mt-3 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
              ✓ 余分な帰国表示はありません
            </div>
          ) : (
            <div className="mt-3 text-sm bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
              <div className="font-bold text-amber-800 dark:text-amber-300">
                {reconcile.orphans.length}件の余分な帰国表示が見つかりました
              </div>
              <ul className="mt-2 space-y-0.5 text-amber-900 dark:text-amber-200 max-h-48 overflow-y-auto">
                {reconcile.orphans.map(o => (
                  <li key={`${o.workerId}_${o.date}`}>
                    {o.date}　{workers.find(w => w.id === o.workerId)?.name || `ID:${o.workerId}`}
                    {o.locked && <span className="ml-2 text-xs text-gray-500">（月次ロック済みのため削除しません）</span>}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}

        {reconcile.status === 'fixing' && (
          <div className="mt-3 text-sm text-gray-500">削除中...</div>
        )}

        {reconcile.status === 'fixed' && (
          <div className="mt-3 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
            ✓ {reconcile.removed}件の余分な帰国表示を削除しました
            {reconcile.skippedLocked > 0 && `（月次ロック済み ${reconcile.skippedLocked}件はそのまま）`}
            <div className="text-xs text-gray-500 mt-1">出面入力画面を再読み込みすると反映されます</div>
          </div>
        )}

        {reconcile.status === 'error' && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
            {reconcile.message}
          </div>
        )}
      </div>
    </div>
  )
}
