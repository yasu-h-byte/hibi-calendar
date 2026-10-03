/**
 * 配置編集モーダル（attendance/page.tsx から抽出）
 *
 * 作業員 / 外注先 のタブ切り替えで、現場への配置を編集する。
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 *
 * セキュリティ多層防御:
 *   - key={siteId+ym} で site/月切替時に強制 re-mount（state リセット）
 *   - 開封時の siteId/ym を useRef で保持、保存時に親側で照合
 *   この多層防御は 2026-05-27 の sasazuka → IHI 上書き事案の再発防止
 */
'use client'

import { useState, useMemo, useRef } from 'react'
import { orgBadgeCls, orgBadgeLabel } from '@/lib/labels'
import { jobShortLabel } from '@/lib/jobs'
import { Modal, CancelButton, PrimaryButton } from '@/components/ui/Modal'

/**
 * 配置モーダルが必要とする worker フィールドの最小セット
 * （attendance/page.tsx の Worker と互換、API レスポンス由来の raw 形）
 */
export interface AssignModalWorker {
  id: number
  name: string
  org: string
  visa: string
  job: string
}

interface SubconOption {
  id: string
  name: string
  type: string
}

interface Props {
  siteId: string
  ym: string
  siteName: string
  currentWorkerIds: number[]
  allWorkers: AssignModalWorker[]
  currentSubconIds: string[]
  allSubcons: SubconOption[]
  onSave: (workerIds: number[], subconIds: string[], expectedSiteId: string, expectedYm: string) => void
  onClose: () => void
}

export default function AssignModal({
  siteId,
  ym,
  siteName,
  currentWorkerIds,
  allWorkers,
  currentSubconIds,
  allSubcons,
  onSave,
  onClose,
}: Props) {
  // 2026-05-18 拡張: 作業員 / 外注先 タブ切替
  const [tab, setTab] = useState<'worker' | 'subcon'>('worker')
  const [assignedWorkerIds, setAssignedWorkerIds] = useState<Set<number>>(new Set(currentWorkerIds))
  const [assignedSubconIds, setAssignedSubconIds] = useState<Set<string>>(new Set(currentSubconIds))
  const [search, setSearch] = useState('')

  // モーダル open 時点のサイト/月を保持し、保存時に親側で照合する
  const openedSiteIdRef = useRef(siteId)
  const openedYmRef = useRef(ym)

  // ── 作業員 ──
  const unassignedWorkers = useMemo(() => {
    return allWorkers
      .filter(w => !assignedWorkerIds.has(w.id))
      .filter(w => !search || w.name.includes(search))
  }, [allWorkers, assignedWorkerIds, search])
  const assignedWorkers = useMemo(() => {
    return allWorkers.filter(w => assignedWorkerIds.has(w.id))
  }, [allWorkers, assignedWorkerIds])
  const addWorker = (id: number) => {
    setAssignedWorkerIds(prev => new Set([...prev, id]))
  }
  const removeWorker = (id: number) => {
    setAssignedWorkerIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // ── 外注先 ──
  const unassignedSubcons = useMemo(() => {
    return allSubcons
      .filter(sc => !assignedSubconIds.has(sc.id))
      .filter(sc => !search || sc.name.includes(search))
  }, [allSubcons, assignedSubconIds, search])
  const assignedSubcons = useMemo(() => {
    return allSubcons.filter(sc => assignedSubconIds.has(sc.id))
  }, [allSubcons, assignedSubconIds])
  const addSubcon = (id: string) => {
    setAssignedSubconIds(prev => new Set([...prev, id]))
  }
  const removeSubcon = (id: string) => {
    setAssignedSubconIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleSave = () => {
    onSave(
      Array.from(assignedWorkerIds),
      Array.from(assignedSubconIds),
      openedSiteIdRef.current,
      openedYmRef.current,
    )
  }

  // 開いたときの配置と違えば、閉じる前に確かめる
  const sameSet = <T,>(a: Set<T>, b: T[]) => a.size === b.length && b.every(v => a.has(v))
  const dirty = !sameSet(assignedWorkerIds, currentWorkerIds) || !sameSet(assignedSubconIds, currentSubconIds)

  return (
    <Modal
      open
      onClose={onClose}
      title={`${siteName} 配置編集`}
      size="lg"
      flush
      dirty={dirty}
      footer={(
        <>
          <CancelButton onClick={onClose} />
          <PrimaryButton onClick={handleSave}>保存する</PrimaryButton>
        </>
      )}
    >
      {/* 左右の一覧がそれぞれ中でスクロールするよう、本文の高さを決めておく */}
      <div className="h-[60vh] flex flex-col">
        {/* タブ切替 */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => { setTab('worker'); setSearch('') }}
            className={`flex-1 py-3 text-sm font-medium transition ${
              tab === 'worker'
                ? 'border-b-2 border-hibi-navy text-hibi-navy bg-blue-50'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
            style={{ minHeight: 44 }}
          >
            作業員（{assignedWorkerIds.size}）
          </button>
          <button
            onClick={() => { setTab('subcon'); setSearch('') }}
            className={`flex-1 py-3 text-sm font-medium transition ${
              tab === 'subcon'
                ? 'border-b-2 border-orange-500 text-orange-700 bg-orange-50'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
            style={{ minHeight: 44 }}
          >
            外注先（{assignedSubconIds.size}）
          </button>
        </div>

        {/* Modal body */}
        <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
          {tab === 'worker' && (
            <>
              {/* Left: Unassigned workers */}
              <div className="flex-1 border-b sm:border-b-0 sm:border-r border-gray-200 flex flex-col min-h-0">
                <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                  <div className="text-xs font-bold text-gray-600 mb-1">未配置の作業員</div>
                  <input
                    type="text"
                    placeholder="名前で検索..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                  {unassignedWorkers.length === 0 && (
                    <div className="text-center text-gray-400 text-xs py-4">該当なし</div>
                  )}
                  {unassignedWorkers.map(w => (
                    <button
                      key={w.id}
                      onClick={() => addWorker(w.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-blue-50 rounded transition"
                      style={{ minHeight: 36 }}
                    >
                      <span className="text-green-600 text-lg leading-none">+</span>
                      <span className="font-medium text-gray-800">{w.name}</span>
                      <span className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${orgBadgeCls(w.org, w.visa)}`}>
                        {orgBadgeLabel(w.org, w.visa)}
                      </span>
                      {w.job && (
                        <span className="text-3xs text-gray-400">
                          {jobShortLabel(w.job)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: Assigned workers */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="px-4 py-2 bg-blue-50 border-b border-gray-200">
                  <div className="text-xs font-bold text-hibi-navy">配置済み ({assignedWorkers.length}名)</div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                  {assignedWorkers.length === 0 && (
                    <div className="text-center text-gray-400 text-xs py-4">作業員が配置されていません</div>
                  )}
                  {assignedWorkers.map(w => (
                    <div
                      key={w.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm bg-white rounded border border-gray-100"
                      style={{ minHeight: 36 }}
                    >
                      <span className="font-medium text-gray-800 flex-1">{w.name}</span>
                      <span className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${orgBadgeCls(w.org, w.visa)}`}>
                        {orgBadgeLabel(w.org, w.visa)}
                      </span>
                      <button
                        onClick={() => removeWorker(w.id)}
                        className="text-red-400 hover:text-red-600 text-lg leading-none ml-1"
                        title="配置解除"
                        style={{ minHeight: 36, minWidth: 36 }}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'subcon' && (
            <>
              {/* Left: Unassigned subcons */}
              <div className="flex-1 border-b sm:border-b-0 sm:border-r border-gray-200 flex flex-col min-h-0">
                <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                  <div className="text-xs font-bold text-gray-600 mb-1">未配置の外注先</div>
                  <input
                    type="text"
                    placeholder="名前で検索..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                  />
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                  {unassignedSubcons.length === 0 && (
                    <div className="text-center text-gray-400 text-xs py-4">該当なし</div>
                  )}
                  {unassignedSubcons.map(sc => (
                    <button
                      key={sc.id}
                      onClick={() => addSubcon(sc.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-orange-50 rounded transition"
                      style={{ minHeight: 36 }}
                    >
                      <span className="text-green-600 text-lg leading-none">+</span>
                      <span className="font-medium text-gray-800">{sc.name}</span>
                      <span className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${
                        sc.type === '土工業者' ? 'bg-amber-100 text-amber-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {sc.type}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: Assigned subcons */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="px-4 py-2 bg-orange-50 border-b border-gray-200">
                  <div className="text-xs font-bold text-orange-700">配置済み ({assignedSubcons.length}社)</div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                  {assignedSubcons.length === 0 && (
                    <div className="text-center text-gray-400 text-xs py-4">外注先が配置されていません</div>
                  )}
                  {assignedSubcons.map(sc => (
                    <div
                      key={sc.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm bg-white rounded border border-gray-100"
                      style={{ minHeight: 36 }}
                    >
                      <span className="font-medium text-gray-800 flex-1">{sc.name}</span>
                      <span className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${
                        sc.type === '土工業者' ? 'bg-amber-100 text-amber-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {sc.type}
                      </span>
                      <button
                        onClick={() => removeSubcon(sc.id)}
                        className="text-red-400 hover:text-red-600 text-lg leading-none ml-1"
                        title="配置解除"
                        style={{ minHeight: 36, minWidth: 36 }}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
