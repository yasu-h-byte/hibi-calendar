/**
 * 夜勤モーダル（台風待機など、年に数回のケース用）
 *
 * グリッドのセルは日勤の時刻・休憩で既に埋まっているため、夜勤の時刻をセル内に足すと
 * レイアウトが崩れる。夜勤は頻度が低いので、セルの「夜」バッジからこのモーダルを開いて
 * 入力する方式にしている。
 *
 * 日勤との関係（夜勤は日勤の長さに関係なく常に 1.5人工）:
 *   - 夜勤のみ        … 日勤なし。人工 1.5
 *   - 日勤＋夜勤      … 日勤で働いてそのまま夜間待機に入るケース。人工 1＋1.5＝2.5
 *   - 半日(0.5)＋夜勤 … 午後から出勤してそのまま待機。人工 0.5＋1.5＝2.0
 *
 * ⚠️ 人工の表示は必ず calcManDays() を使う。ここで「日勤=1」と決め打ちすると
 *    半日出勤の日に給与計算と食い違う（2026-08-12 に実際に起きたバグ）。
 *
 * 終業は「翌5:00」を "29:00" という24時超え表記で保存する。こうすると時刻→分の変換が
 * 単調増加になり、実労働・深夜時間の計算が日付またぎ補正なしで正しく動く。
 */
'use client'

import { useEffect, useState } from 'react'
import {
  formatTimeLabel, timeToMinutes, calcManDays, NIGHT_DEFAULT_BREAK_MIN, NIGHT_SHIFT_MANDAYS,
  NIGHT_START_OPTIONS, NIGHT_END_OPTIONS,
} from '@/types'
import { AttEntry } from '../types'

/** 夜勤の入力値（保存時に AttEntry へマージされる形） */
export interface NightShiftValue {
  nst: string
  net: string
  nb: number
  nonly: boolean
  nnote: string
}

interface Props {
  isOpen: boolean
  workerName: string
  day: number
  entry: AttEntry | null | undefined
  /** null を渡すと夜勤を取り消す */
  onSave: (value: NightShiftValue | null) => void
  onClose: () => void
}

/** 深夜(22:00-5:00)と重なる時間（分）。lib/compute.ts の calcNightMinutes と同一ロジック */
function nightMinutesOf(startMin: number, endMin: number): number {
  let end = endMin
  if (end <= startMin) end += 24 * 60
  const windows: [number, number][] = [[0, 300], [1320, 1740], [1320 + 1440, 1740 + 1440]]
  let total = 0
  for (const [a, b] of windows) {
    const lo = Math.max(startMin, a)
    const hi = Math.min(end, b)
    if (hi > lo) total += hi - lo
  }
  return total
}

export default function NightShiftModal({
  isOpen, workerName, day, entry, onSave, onClose,
}: Props) {
  const [nst, setNst] = useState('20:00')
  const [net, setNet] = useState('29:00')
  const [nb, setNb] = useState(NIGHT_DEFAULT_BREAK_MIN)
  const [nonly, setNonly] = useState(false)
  const [nnote, setNnote] = useState('')

  // 開くたびに既存値を読み込む
  useEffect(() => {
    if (!isOpen) return
    setNst(entry?.nst || '20:00')
    setNet(entry?.net || '29:00')
    setNb(entry?.nb ?? NIGHT_DEFAULT_BREAK_MIN)
    setNonly(!!entry?.nonly)
    setNnote(entry?.nnote || '台風待機')
  }, [isOpen, entry])

  if (!isOpen) return null

  const startMin = timeToMinutes(nst)
  const endMin = timeToMinutes(net)
  const spanMin = Math.max(0, endMin - startMin)
  const workMin = Math.max(0, spanMin - nb)
  const nightMin = Math.min(nightMinutesOf(startMin, endMin), workMin)
  // ⚠️ 人工は必ず calcManDays で出す。ここで独自に「日勤=1」と決め打ちすると、
  //    半日出勤（w=0.5）の日に給与計算と表示が食い違う（2026-08-12 のバグ）。
  const dayManDays = nonly ? 0 : (entry?.w || 0)
  const manDays = calcManDays({ ...(entry || { w: 1 }), ns: 1, nonly: nonly ? 1 : undefined })
  const invalid = endMin <= startMin || workMin <= 0

  const fmtH = (min: number) => `${Math.floor(min / 60)}時間${min % 60 > 0 ? `${min % 60}分` : ''}`

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-md p-6 max-h-[88vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-hibi-navy mb-1">夜勤の入力</h3>
        <p className="text-xs text-gray-500 mb-4">{workerName} ／ {day}日</p>

        {/* 日勤の有無 */}
        <div className="mb-4">
          <p className="text-xs font-bold text-gray-600 mb-2">この日の勤務</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setNonly(false)}
              className={`rounded-lg py-2.5 text-sm font-bold border transition ${
                !nonly
                  ? 'bg-hibi-navy text-white border-hibi-navy'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              日勤＋夜勤
            </button>
            <button
              onClick={() => setNonly(true)}
              className={`rounded-lg py-2.5 text-sm font-bold border transition ${
                nonly
                  ? 'bg-hibi-navy text-white border-hibi-navy'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              夜勤のみ
            </button>
          </div>
        </div>

        {/* 夜勤の始業・終業 */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">夜勤の始業</label>
            <select
              value={nst}
              onChange={e => setNst(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white tabular-nums"
            >
              {NIGHT_START_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">夜勤の終業</label>
            <select
              value={net}
              onChange={e => setNet(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white tabular-nums"
            >
              {NIGHT_END_OPTIONS.map(t => (
                <option key={t} value={t}>{formatTimeLabel(t)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 休憩 */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-gray-600 mb-1">夜勤中の休憩（分）</label>
          <input
            type="number"
            min={0}
            max={480}
            step={15}
            value={nb}
            onChange={e => setNb(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base tabular-nums"
          />
        </div>

        {/* 理由 */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-gray-600 mb-1">理由</label>
          <input
            type="text"
            value={nnote}
            onChange={e => setNnote(e.target.value)}
            placeholder="台風待機 など"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base"
          />
        </div>

        {/* 計算結果 */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-4 space-y-1">
          {invalid ? (
            <p className="text-sm font-bold text-red-600">
              終業が始業より後になるように選んでください
            </p>
          ) : (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">夜勤の実労働</span>
                <span className="font-bold tabular-nums text-hibi-navy">{fmtH(workMin)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">うち深夜（22:00〜5:00）</span>
                <span className="font-bold tabular-nums text-purple-700">{fmtH(nightMin)}</span>
              </div>
              <div className="flex justify-between text-sm pt-1 border-t border-indigo-200">
                <span className="text-gray-600">
                  この日の人工
                  {/* 内訳を出す。出勤欄が 0.5（半日）だと 2.5 ではなく 2.0 になるため */}
                  <span className="block text-[11px] text-gray-400 tabular-nums">
                    日勤 {dayManDays} ＋ 夜勤 {NIGHT_SHIFT_MANDAYS}
                  </span>
                </span>
                <span className="font-bold tabular-nums text-hibi-navy">{manDays} 人工</span>
              </div>
              <p className="text-[11px] text-gray-500 pt-1">
                日本人は人工で支給・元請け請求。ベトナム人は時給・深夜割増で法令どおり計算します。
              </p>
            </>
          )}
        </div>

        <div className="flex gap-2">
          {entry?.ns ? (
            <button
              onClick={() => onSave(null)}
              className="flex-1 border border-red-300 text-red-600 rounded-xl py-3 font-bold text-sm hover:bg-red-50 transition"
            >
              夜勤を取り消す
            </button>
          ) : (
            <button
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-600 rounded-xl py-3 font-bold text-sm hover:bg-gray-50 transition"
            >
              キャンセル
            </button>
          )}
          <button
            onClick={() => onSave({ nst, net, nb, nonly, nnote: nnote.trim() })}
            disabled={invalid}
            className="flex-1 bg-hibi-navy text-white rounded-xl py-3 font-bold text-sm transition disabled:opacity-50 hover:opacity-90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
