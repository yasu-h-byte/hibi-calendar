'use client'

/**
 * 運転者の記録モーダル（運転手当・2026-10-01 施行）。
 *
 * その日その現場に出ている人の中から、行き便・帰り便の運転者を選ぶ。
 * 車が2台なら各便2名になる。同じ人が行き帰り両方を運転することも多い
 * （運転者は朝は寝ていたいので夕方に運転したがる、という実態も踏まえ、
 * 便ごとに独立して選べる）。
 */

import { useEffect, useState } from 'react'

interface WorkerOption {
  id: number
  name: string
}

interface Props {
  isOpen: boolean
  day: number
  siteName: string
  /** その日に出面のある人（選択肢） */
  workers: WorkerOption[]
  current: { am: number[]; pm: number[] } | undefined
  onSave: (am: number[], pm: number[]) => void
  onClose: () => void
}

export default function DriverModal({ isOpen, day, siteName, workers, current, onSave, onClose }: Props) {
  const [am, setAm] = useState<number[]>([])
  const [pm, setPm] = useState<number[]>([])

  useEffect(() => {
    if (isOpen) {
      setAm(current?.am || [])
      setPm(current?.pm || [])
    }
  }, [isOpen, current])

  if (!isOpen) return null

  const toggle = (list: number[], set: (v: number[]) => void, id: number) =>
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="font-bold text-hibi-navy dark:text-white">🚗 {day}日の運転者 — {siteName}</h3>
          <p className="text-[11px] text-gray-500 mt-1">
            会社集合後に社有車を運転した人を、行き・帰りそれぞれ選んでください（車2台なら各2名）。
            同乗者がいない単独移動は対象外です。
          </p>
        </div>

        <div className="p-5">
          {workers.length === 0 ? (
            <p className="text-sm text-gray-400">この日に出面のある人がいません。</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-1.5">氏名</th>
                  <th className="text-center w-16">行き</th>
                  <th className="text-center w-16">帰り</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {workers.map(w => (
                  <tr key={w.id}>
                    <td className="py-1.5">{w.name}</td>
                    <td className="text-center">
                      <input type="checkbox" checked={am.includes(w.id)} onChange={() => toggle(am, setAm, w.id)} className="w-4 h-4" />
                    </td>
                    <td className="text-center">
                      <input type="checkbox" checked={pm.includes(w.id)} onChange={() => toggle(pm, setPm, w.id)} className="w-4 h-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(am.length > 0 || pm.length > 0) && (
            <p className="text-[11px] text-gray-500 mt-3">
              行き {am.length}名・帰り {pm.length}名。運転手当は片道単位で自動計算されます（判定値60分以上の現場は1,000円/片道、未満は500円）。
            </p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">キャンセル</button>
          <button onClick={() => onSave(am, pm)} className="px-4 py-2 text-sm rounded-lg bg-hibi-navy text-white font-bold hover:opacity-90">保存</button>
        </div>
      </div>
    </div>
  )
}
