/**
 * スタッフごとの月次出勤カレンダービュー（社労士確認用）
 *
 * 2026-06-XX 追加: 印刷ページ (/monthly/audit-print) で使用。
 *   出勤・有給・補償・欠勤・帰国中などを日別に色分け表示。
 *   社労士が「この人が何日にどう働いたか」を一目で確認できる。
 */
'use client'

interface AttendanceEntry {
  w?: number       // 出勤 (1=フル, 0.5=半日, 0.6=補償, 0=休)
  o?: number       // 残業時間
  p?: number       // 有給 (1=有給)
  r?: number       // 欠勤
  h?: number       // 現場休
  hk?: number      // 帰国中
  exam?: number    // 試験
  st?: string      // 開始時刻
  et?: string      // 終了時刻
  _siteId?: string // どの現場のエントリか
}

interface Props {
  ym: string                                  // YYYYMM
  entries: Record<number, AttendanceEntry>    // day -> entry
  siteNames: Record<string, string>           // siteId -> 表示名
}

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

// エントリから状態ラベルを決定
function getStatus(e: AttendanceEntry | undefined): {
  label: string
  short: string
  bgClass: string
  textClass: string
} {
  if (!e) return { label: '－', short: '－', bgClass: 'bg-gray-50', textClass: 'text-gray-400' }
  if (e.p) return { label: '有給', short: '有', bgClass: 'bg-green-100', textClass: 'text-green-800' }
  if (e.hk) return { label: '帰国中', short: '帰', bgClass: 'bg-cyan-100', textClass: 'text-cyan-800' }
  if (e.exam) return { label: '試験', short: '試', bgClass: 'bg-purple-100', textClass: 'text-purple-800' }
  if (e.r) return { label: '欠勤', short: '欠', bgClass: 'bg-red-100', textClass: 'text-red-800' }
  if (e.h) return { label: '現場休', short: '現休', bgClass: 'bg-yellow-100', textClass: 'text-yellow-800' }
  if (e.w === 0.6) return { label: '補償日', short: '補', bgClass: 'bg-orange-100', textClass: 'text-orange-800' }
  if (e.w === 0.5) return { label: '半日', short: '半', bgClass: 'bg-blue-50', textClass: 'text-blue-700' }
  if ((e.w || 0) > 0) return { label: '出勤', short: '出', bgClass: 'bg-blue-100', textClass: 'text-blue-800' }
  return { label: '－', short: '－', bgClass: 'bg-gray-50', textClass: 'text-gray-400' }
}

export default function WorkerCalendarView({ ym, entries, siteNames }: Props) {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const firstDayOfWeek = new Date(y, m - 1, 1).getDay()  // 0=日

  // カレンダーグリッド生成（最大6週）
  const weeks: ({ day: number; entry: AttendanceEntry | undefined } | null)[][] = []
  let currentWeek: ({ day: number; entry: AttendanceEntry | undefined } | null)[] = []
  for (let i = 0; i < firstDayOfWeek; i++) currentWeek.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    currentWeek.push({ day: d, entry: entries[d] })
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null)
    weeks.push(currentWeek)
  }

  // 集計
  const totals = { work: 0, leave: 0, comp: 0, absent: 0, hkRest: 0, exam: 0, ot: 0 }
  for (const e of Object.values(entries)) {
    if (!e) continue
    if (e.p) totals.leave++
    else if (e.hk) totals.hkRest++
    else if (e.exam) totals.exam++
    else if (e.r) totals.absent++
    else if (e.w === 0.6) totals.comp++
    else if ((e.w || 0) > 0) totals.work++
    totals.ot += (e.o || 0)
  }

  return (
    <div className="text-xs">
      <h4 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">
        ⑥ 日別出勤詳細 ({y}年{m}月)
      </h4>

      <table className="w-full text-center" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr className="bg-gray-100">
            {DAY_LABELS.map((label, i) => (
              <th
                key={i}
                className={`py-1 px-1 border border-gray-300 text-xs font-bold ${
                  i === 0 ? 'text-red-600' : i === 6 ? 'text-blue-600' : 'text-gray-700'
                }`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((cell, ci) => {
                if (!cell) {
                  return <td key={ci} className="border border-gray-200 p-1 bg-gray-50/50 h-[42px]"></td>
                }
                const status = getStatus(cell.entry)
                const isSunday = ci === 0
                const siteShort = cell.entry?._siteId ? (siteNames[cell.entry._siteId] || cell.entry._siteId).slice(0, 4) : ''
                const ot = cell.entry?.o
                return (
                  <td
                    key={ci}
                    className={`border border-gray-200 p-1 align-top h-[42px] ${status.bgClass}`}
                  >
                    <div className={`text-[10px] font-bold ${isSunday ? 'text-red-600' : 'text-gray-700'}`}>
                      {cell.day}
                    </div>
                    <div className={`text-[10px] font-semibold ${status.textClass} leading-tight`}>
                      {status.short}
                      {ot && ot > 0 ? <span className="ml-0.5">+{ot}h</span> : null}
                    </div>
                    {siteShort && status.short !== '－' && (
                      <div className="text-[8px] text-gray-500 leading-none truncate">{siteShort}</div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* 集計サマリー */}
      <div className="mt-2 text-[11px] text-gray-600 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>出勤 <strong>{totals.work}日</strong></span>
        {totals.comp > 0 && <span>補償 <strong className="text-orange-700">{totals.comp}日</strong></span>}
        {totals.leave > 0 && <span>有給 <strong className="text-green-700">{totals.leave}日</strong></span>}
        {totals.absent > 0 && <span>欠勤 <strong className="text-red-700">{totals.absent}日</strong></span>}
        {totals.hkRest > 0 && <span>帰国 <strong className="text-cyan-700">{totals.hkRest}日</strong></span>}
        {totals.exam > 0 && <span>試験 <strong className="text-purple-700">{totals.exam}日</strong></span>}
        {totals.ot > 0 && <span>残業合計 <strong>{totals.ot}h</strong></span>}
      </div>
    </div>
  )
}
