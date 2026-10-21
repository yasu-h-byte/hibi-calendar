'use client'
/**
 * スタッフのスマホ出面の「始業・終業の時刻」と「休憩（午前・午後）のチェック」（2026-10-21 総点検 §7-2）。
 *
 * 旧: app/attendance/[token]/page.tsx の「今日の入力」と「過去日の編集モーダル」に同じフォームが 2 回書かれていた
 * （時刻の選択肢・休憩の行・未取得の赤字）。片方だけ直すズレの元だったので 1 つにした。見た目は variant で切り替える:
 *   - today: 白いカード（影つき）・大きい字（今日の打刻）
 *   - past:  灰色の枠・ひとまわり小さい字（過去日の編集モーダルの中）
 * 昼休憩は画面に出さない（内部で処理・旧と同じ）。
 */
import type { SiteWorkSchedule } from '@/types'
import { STAFF_TEXT, biLine } from '@/lib/labels'

/** 始業は 5:00〜13:00、終業は 15:00〜23:00 の 30 分刻み（現場ごとの始業時刻に対応） */
function timeOptions(fromHour: number): string[] {
  return Array.from({ length: 17 }, (_, i) => `${String(fromHour + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`)
}

export interface StaffTimeBreakFormProps {
  variant: 'today' | 'past'
  workSchedule: Pick<SiteWorkSchedule, 'morningBreak' | 'afternoonBreak'>
  startTime: string
  endTime: string
  onStartTime: (v: string) => void
  onEndTime: (v: string) => void
  /** 午前休憩を取った */
  break1: boolean
  /** 午後休憩を取った */
  break3: boolean
  onBreak1: (v: boolean) => void
  onBreak3: (v: boolean) => void
}

export default function StaffTimeBreakForm(p: StaffTimeBreakFormProps) {
  const past = p.variant === 'past'
  const card = past ? 'bg-gray-50 rounded-xl p-3' : 'bg-white rounded-xl border border-gray-200 shadow-sm p-4'
  const timeCls = `${past ? 'text-xl' : 'text-2xl'} font-bold text-hibi-charcoal tabular-nums text-center w-full border-none bg-transparent`
  const breaks = [
    { id: 'b1', cfg: p.workSchedule.morningBreak, label: STAFF_TEXT.breakAm, checked: p.break1, set: p.onBreak1 },
    { id: 'b3', cfg: p.workSchedule.afternoonBreak, label: STAFF_TEXT.breakPm, checked: p.break3, set: p.onBreak3 },
  ].filter(b => b.cfg.enabled)
  return (
    <>
      {/* 始業・終業 */}
      <div className="grid grid-cols-2 gap-3">
        <div className={`${card} text-center`}>
          <p className="text-xs text-gray-500 mb-1">{biLine(STAFF_TEXT.start)}</p>
          <select value={p.startTime} onChange={e => p.onStartTime(e.target.value)} className={timeCls}>
            {timeOptions(5).map(val => <option key={val} value={val}>{val}</option>)}
          </select>
        </div>
        <div className={`${card} text-center`}>
          <p className="text-xs text-gray-500 mb-1">{biLine(STAFF_TEXT.end)}</p>
          <select value={p.endTime} onChange={e => p.onEndTime(e.target.value)} className={timeCls}>
            {timeOptions(15).map(val => <option key={val} value={val}>{val}</option>)}
          </select>
        </div>
      </div>

      {/* 休憩（午前・午後だけ表示。昼休憩は内部で処理） */}
      {breaks.length > 0 && (
        <div className={card}>
          <p className="text-xs text-gray-500 mb-2">{biLine(STAFF_TEXT.breakTime)}</p>
          <div className={past ? 'space-y-1' : 'space-y-2'}>
            {breaks.map(b => (
              /* 行ごと押せる 44px 以上（2026-10-02 総合点検。旧: 20px のチェックと1行の文字だけで押しにくかった） */
              <label key={b.id} className={`flex items-center gap-3 cursor-pointer min-h-[44px] rounded-lg active:bg-gray-100 ${past ? '-mx-1 px-1' : '-mx-2 px-2'}`}>
                <input
                  type="checkbox"
                  checked={b.checked}
                  onChange={e => b.set(e.target.checked)}
                  className="w-6 h-6 rounded text-hibi-navy shrink-0"
                />
                <span className={`text-base ${b.checked ? 'text-gray-700' : 'text-red-600 font-bold'}`}>
                  {b.label.ja}（{b.cfg.minutes}分）/ {b.label.vi} ({b.cfg.minutes} phút)
                  {!b.checked && ` ← ${biLine(STAFF_TEXT.breakNotTaken)}`}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
