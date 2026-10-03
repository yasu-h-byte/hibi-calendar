'use client'

/**
 * 運転者の記録モーダル（運転手当・2026-10-01 施行）。
 *
 * その日その現場に出ている人の中から、行き便・帰り便の運転者を選ぶ。
 * 車が2台なら各便2名になる。同じ人が行き帰り両方を運転することも多い
 * （運転者は朝は寝ていたいので夕方に運転したがる、という実態も踏まえ、
 * 便ごとに独立して選べる）。
 *
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */

import { useEffect, useRef, useState } from 'react'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

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
  /**
   * 保存。文字列を返す（または投げる）と失敗として赤の帯に出し、モーダルは開いたまま（2026-10-02 総合点検）。
   * PC の出面画面は従来どおり何も返さない（閉じるのは親の isOpen）。
   */
  onSave: (am: number[], pm: number[]) => void | string | Promise<void | string>
  onClose: () => void
}

const sameIds = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y), sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

export default function DriverModal({ isOpen, day, siteName, workers, current, onSave, onClose }: Props) {
  const [am, setAm] = useState<number[]>([])
  const [pm, setPm] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const wasOpen = useRef(false)

  // 開いた瞬間だけ current で初期化する（2026-10-02 総合点検）。
  //   旧: current が依存に入っていたので、親が再描画して参照が変わるたびに選択が元に戻った
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setAm(current?.am || [])
      setPm(current?.pm || [])
    }
    wasOpen.current = isOpen
  }, [isOpen, current])

  if (!isOpen) return null

  const toggle = (list: number[], set: (v: number[]) => void, id: number) =>
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id])

  const dirty = !sameIds(am, current?.am || []) || !sameIds(pm, current?.pm || [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const r = await onSave(am, pm)
      if (typeof r === 'string') return { ok: false, error: r }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={`${day}日の運転者 — ${siteName}`}
      sub="会社集合後に社有車を運転した人を、行き・帰りそれぞれ選んでください（車2台なら各2名）。同乗者がいない単独移動は対象外です。"
      size="md"
      dirty={dirty}
      footer={(
        <>
          <CancelButton onClick={onClose} disabled={saving} />
          <SaveButton action="保存" onSave={handleSave} />
        </>
      )}
    >
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
            {/* 職長のスマホからも使うので、マスごと押せる 44px 以上の行にする（2026-10-02 総合点検。
                旧: 16px のチェックが 32px の行に隣り合い、片道1,000円の手当に直結する押し間違いが起きやすかった） */}
            {workers.map(w => (
              <tr key={w.id}>
                <td className="py-1.5">{w.name}</td>
                <td className="p-0">
                  <label className="flex items-center justify-center min-h-[44px] cursor-pointer active:bg-gray-100 dark:active:bg-gray-700">
                    <input type="checkbox" checked={am.includes(w.id)} onChange={() => toggle(am, setAm, w.id)} className="w-6 h-6" />
                  </label>
                </td>
                <td className="p-0">
                  <label className="flex items-center justify-center min-h-[44px] cursor-pointer active:bg-gray-100 dark:active:bg-gray-700">
                    <input type="checkbox" checked={pm.includes(w.id)} onChange={() => toggle(pm, setPm, w.id)} className="w-6 h-6" />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(am.length > 0 || pm.length > 0) && (
        <p className="text-xs text-gray-500 mt-3">
          行き {am.length}名・帰り {pm.length}名。運転手当は片道1,000円で自動計算されます（同乗者を乗せた便だけ記録してください）。
        </p>
      )}
    </Modal>
  )
}
