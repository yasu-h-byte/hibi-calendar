'use client'
/**
 * 出面の一括入力（2026-09-30 代表依頼）
 *
 * 応援現場の出面は事業責任者（政仁さん）が一括で入力する運用。人と日にちをまとめて選び、
 * 同じ内容（出勤・欠勤・現場都合休・消す）を一度に入れる。保存は1マスずつの入力と同じ経路
 * （page.tsx の scheduleSave）に流すので、工種（鉄骨・仮設）の振り分け・ロック・各種ガードも同じに効く。
 *
 * ベトナム人スタッフの「出勤」を空欄に新しく入れることはできない（本人のスマホ入力が原則・
 * lib/attendance.ts canAdminEditEntry）。その分は最初から外して件数を知らせる。
 */
import { useMemo, useState } from 'react'
import type { AttEntry, Worker, DayType } from '../types'
import { calcOvertimeHours, type SiteWorkSchedule } from '@/types'

export type BulkKind = 'work' | 'rest' | 'comp' | 'clear'

export interface BulkItem { workerId: string; day: number; entry: AttEntry | null }

const DOW = ['日', '月', '火', '水', '木', '金', '土']

export default function BulkEntryModal({
  open, onClose, ym, daysInMonth, workers, entries, calendarDays, lockedDays, timeBasedFor, onApply, homeLeaves, workSchedule,
}: {
  open: boolean
  onClose: () => void
  ym: string
  daysInMonth: number
  workers: Worker[]
  entries: Record<string, Record<number, AttEntry | null>>
  calendarDays: Record<string, DayType> | null
  /** 職長承認・最終承認でロックされた日 */
  lockedDays: Set<number>
  /** この人は時刻で入力するか（ベトナム人・新ルール） */
  timeBasedFor: (w: Worker) => boolean
  onApply: (items: BulkItem[]) => void
  /** 帰国申請（承認済みの期間は、出面が空でも「帰国中」なので一括入力しない） */
  homeLeaves?: { workerId: number; startDate: string; endDate: string; status: string }[]
  /** 現場の勤務時間・休憩（残業h の計算に使う） */
  workSchedule?: SiteWorkSchedule
}) {
  const [who, setWho] = useState<Set<string>>(new Set())
  const [days, setDays] = useState<Set<number>>(new Set())
  const [kind, setKind] = useState<BulkKind>('work')
  const [st, setSt] = useState('08:00')
  const [et, setEt] = useState('17:00')
  const [breaks, setBreaks] = useState({ b1: true, b2: true, b3: true })
  const [ot, setOt] = useState('')
  const [keepExisting, setKeepExisting] = useState(true)

  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const dow = (d: number) => new Date(y, m - 1, d).getDay()
  const isWorkDay = (d: number) => calendarDays ? calendarDays[String(d)] === 'work' : dow(d) !== 0
  const isForeign = (w: Worker) => !!w.visa && w.visa !== 'none' && w.visa !== ''

  const plan = useMemo(() => {
    const items: BulkItem[] = []
    let skipLocked = 0, skipExisting = 0, skipForeignWork = 0, skipAbsent = 0, skipProtected = 0, overwriteStaff = 0, skipRestDay = 0
    const isoOf = (d: number) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
    for (const w of workers) {
      if (!who.has(String(w.id))) continue
      for (const d of [...days].sort((a, b) => a - b)) {
        if (lockedDays.has(d)) { skipLocked++; continue }
        const cur = entries[String(w.id)]?.[d]
        // 帰国中・退職後の日は入れない（2026-09-30 点検: 帰国中の日に0.6補が入り休業補償の過払いになる）
        const iso = isoOf(d)
        const onHomeLeave = (homeLeaves || []).some(hl =>
          String(hl.workerId) === String(w.id) && hl.status === 'approved' && iso >= hl.startDate && iso <= hl.endDate)
        // 入社前の日も入れない（2026-10-02 点検: 10/26 入社の人の 10/1〜25 に 0.6補 が入り過払いになりえた）
        if (kind !== 'clear' && (onHomeLeave || (w.retired && iso > w.retired) || (w.hireDate && iso < w.hireDate))) { skipAbsent++; continue }
        // 有給・帰国・試験のマスは「入力済みを変えない」を外しても上書きしない（有給の取り消しは申請の画面から）
        if (cur && (cur.p || cur.hk || cur.exam)) { skipProtected++; continue }
        if (keepExisting && cur && kind !== 'clear') { skipExisting++; continue }
        if (cur && cur.s === 'staff') overwriteStaff++
        if (kind === 'clear') { if (cur) items.push({ workerId: String(w.id), day: d, entry: null }); continue }
        if (kind === 'rest') { items.push({ workerId: String(w.id), day: d, entry: { w: 0, r: 1, s: 'admin' } }); continue }
        // 0.6補（会社都合の休み）はカレンダーの仕事の日だけ（スタッフのスマホ・サーバと同じ決まり・2026-10-02 総合点検。
        //   旧: 休みの日にも入り、休業手当（60%）の過払いになりえた）
        if (kind === 'comp' && !isWorkDay(d) && cur?.w !== 0.6) { skipRestDay++; continue }
        if (kind === 'comp') { items.push({ workerId: String(w.id), day: d, entry: { w: 0.6, s: 'admin' } }); continue }
        // 出勤
        // 外国人スタッフの出勤は、その日に本人の入力（s:'staff'）か出勤の記録があるときだけ（サーバの canAdminEditEntry と同じ・2026-10-02）
        if (isForeign(w) && !(cur && (cur.s === 'staff' || ((cur.w || 0) > 0 && cur.w !== 0.6 && !cur.p && !cur.r && !cur.h && !cur.hk)))) { skipForeignWork++; continue }
        let entry: AttEntry
        if (timeBasedFor(w)) {
          entry = { w: 1, st, et, b1: breaks.b1 ? 1 : 0, b2: breaks.b2 ? 1 : 0, b3: breaks.b3 ? 1 : 0, s: 'admin' }
          const otH = calcOvertimeHours(entry, workSchedule)   // 現場の休憩設定で数える（保存時と同じ決まり）
          if (otH > 0) entry.o = otH
        } else {
          entry = { w: 1, s: 'admin' }
          const o = Number(ot)
          if (o > 0) entry.o = Math.min(8, Math.round(o * 10) / 10)
        }
        items.push({ workerId: String(w.id), day: d, entry })
      }
    }
    return { items, skipLocked, skipExisting, skipForeignWork, skipAbsent, skipProtected, overwriteStaff, skipRestDay }
  }, [workers, who, days, kind, st, et, breaks, ot, keepExisting, entries, lockedDays, timeBasedFor, homeLeaves, ym, workSchedule])

  if (!open) return null
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n }
  const btn = 'px-2.5 py-1 rounded-lg border border-gray-300 dark:border-gray-600 text-xs hover:bg-gray-50 dark:hover:bg-gray-700'
  const kinds: { k: BulkKind; label: string }[] = [
    { k: 'work', label: '出勤' }, { k: 'rest', label: '欠勤（本人都合）' }, { k: 'comp', label: '現場都合休（0.6補）' }, { k: 'clear', label: '消す' },
  ]
  const hasTimeBased = workers.some(w => who.has(String(w.id)) && timeBasedFor(w))
  const hasLegacy = workers.some(w => who.has(String(w.id)) && !timeBasedFor(w))

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start sm:items-center justify-center p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold">一括入力</h3>
            <p className="text-xs text-gray-500 mt-0.5">人と日にちをまとめて選び、同じ内容を一度に入れます。工種（鉄骨・仮設）は日ごとの指定どおりに振り分けます。</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-400 hover:text-gray-600">&times;</button>
        </div>

        {/* 人 */}
        <section>
          <div className="flex items-center gap-2 mb-1.5">
            <b className="text-sm">① 人</b>
            <button className={btn} onClick={() => setWho(new Set(workers.map(w => String(w.id))))}>全員</button>
            <button className={btn} onClick={() => setWho(new Set())}>外す</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {workers.map(w => {
              const on = who.has(String(w.id))
              return (
                <button key={w.id} onClick={() => setWho(toggle(who, String(w.id)))}
                  className={`px-2.5 py-1 rounded-full text-xs border ${on ? 'bg-hibi-navy text-white border-hibi-navy' : 'border-gray-300 dark:border-gray-600'}`}>
                  {w.name}{isForeign(w) ? ' 🇻🇳' : ''}
                </button>
              )
            })}
          </div>
        </section>

        {/* 日にち */}
        <section>
          <div className="flex items-center gap-2 mb-1.5">
            <b className="text-sm">② 日にち</b>
            <button className={btn} onClick={() => setDays(new Set(Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(d => isWorkDay(d) && !lockedDays.has(d))))}>カレンダーの稼働日</button>
            <button className={btn} onClick={() => setDays(new Set())}>外す</button>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: (dow(1)) }, (_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
              const on = days.has(d)
              const locked = lockedDays.has(d)
              const wd = isWorkDay(d)
              return (
                <button key={d} disabled={locked} onClick={() => setDays(toggle(days, d))}
                  className={`rounded-lg py-1 text-xs border tabular-nums ${on ? 'bg-hibi-navy text-white border-hibi-navy' : wd ? 'border-gray-300 dark:border-gray-600' : 'border-gray-200 text-gray-400 bg-gray-50 dark:bg-gray-700/40'} disabled:opacity-40`}>
                  {d}<span className="text-2xs ml-0.5">{DOW[dow(d)]}</span>{locked && <span className="ml-0.5 text-2xs">済</span>}
                </button>
              )
            })}
          </div>
        </section>

        {/* 内容 */}
        <section className="space-y-2">
          <b className="text-sm">③ 入れる内容</b>
          <div className="flex flex-wrap gap-1.5">
            {kinds.map(o => (
              <button key={o.k} onClick={() => setKind(o.k)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${kind === o.k ? 'bg-hibi-navy text-white border-hibi-navy' : 'border-gray-300 dark:border-gray-600'}`}>{o.label}</button>
            ))}
          </div>
          {kind === 'work' && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {hasTimeBased && (
                <>
                  <label>始業 <input type="time" value={st} onChange={e => setSt(e.target.value)} className="border rounded px-2 py-1 dark:bg-gray-700" /></label>
                  <label>終業 <input type="time" value={et} onChange={e => setEt(e.target.value)} className="border rounded px-2 py-1 dark:bg-gray-700" /></label>
                  {(['b1', 'b2', 'b3'] as const).map((k, i) => (
                    <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={breaks[k]} onChange={e => setBreaks({ ...breaks, [k]: e.target.checked })} />{['午前休憩', '昼休み', '午後休憩'][i]}</label>
                  ))}
                </>
              )}
              {hasLegacy && (
                <label>残業（時間・日本人など） <input type="number" min={0} max={8} step={0.5} value={ot} onChange={e => setOt(e.target.value)} className="w-20 border rounded px-2 py-1 dark:bg-gray-700" /></label>
              )}
            </div>
          )}
          {kind !== 'clear' && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <input type="checkbox" checked={keepExisting} onChange={e => setKeepExisting(e.target.checked)} />
              入力済みのマスは変えない
            </label>
          )}
        </section>

        {/* 確認 */}
        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/40 p-3 text-sm">
          <b>{plan.items.length}マス</b>に入れます
          {(plan.skipExisting + plan.skipLocked + plan.skipForeignWork + plan.skipAbsent + plan.skipProtected + plan.skipRestDay) > 0 && (
            <span className="text-xs text-gray-500 ml-2">
              （除外: {[
                plan.skipExisting ? `入力済み ${plan.skipExisting}` : '',
                plan.skipLocked ? `承認済みの日 ${plan.skipLocked}` : '',
                plan.skipForeignWork ? `ベトナム人スタッフの出勤 ${plan.skipForeignWork}（本人のスマホ入力が必要）` : '',
                plan.skipAbsent ? `帰国中・退職後 ${plan.skipAbsent}` : '',
                plan.skipProtected ? `有給・帰国・試験 ${plan.skipProtected}` : '',
                plan.skipRestDay ? `休みの日の0.6補 ${plan.skipRestDay}（仕事の日だけ）` : '',
              ].filter(Boolean).join('・')}）
            </span>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm">やめる</button>
          <button disabled={plan.items.length === 0}
            onClick={() => {
              if (kind === 'clear' && !confirm(`${plan.items.length}マスの入力を消します。よろしいですか？`)) return
              if (kind !== 'clear' && plan.overwriteStaff > 0 &&
                !confirm(`本人がスマホで入れた ${plan.overwriteStaff}マスを上書きします（始業・終業の時刻も置き換わります）。よろしいですか？`)) return
              if (plan.items.length > 150 &&
                !confirm(`${plan.items.length}マスは多めです。保存に少し時間がかかります（4件ずつ送ります）。続けますか？`)) return
              onApply(plan.items); onClose()
            }}
            className="px-5 py-2 rounded-lg bg-hibi-navy text-white text-sm font-bold disabled:opacity-40">
            {plan.items.length}マスに入れる
          </button>
        </div>
      </div>
    </div>
  )
}
