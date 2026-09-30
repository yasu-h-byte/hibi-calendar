'use client'
/**
 * 月末の本人確認カード（2026-09-30）
 *
 * 月末3日（その月）と月初10日（前の月）に、スタッフのスマホの上のほうに出る。
 * 出勤・有給・会社の都合の休み・自分の都合の休み・未入力の数を見せ、
 * 「正しい」「まちがいがある（どこが）」を押してもらう。記録は事務所の月次集計に出る。
 * 数え方は lib/attendance-confirm.ts。
 */
import { useCallback, useEffect, useState } from 'react'
import type { StaffMonthSummary, AttConfirmDoc } from '@/lib/attendance-confirm'
import { REST_REASONS } from '@/components/attendance/RestReportModal'

interface ConfirmData {
  ym: string | null
  summary?: StaffMonthSummary
  confirmation?: AttConfirmDoc | null
  stale?: boolean
}

export default function MonthConfirmCard({ token, reloadKey }: { token: string; reloadKey?: number }) {
  const [data, setData] = useState<ConfirmData | null>(null)
  const [mode, setMode] = useState<'view' | 'issue'>('view')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/attendance/confirm?token=${encodeURIComponent(token)}`)
      if (res.ok) setData(await res.json())
    } catch { /* 表示しないだけ */ }
  }, [token])
  useEffect(() => { load() }, [load, reloadKey])

  if (!data?.ym || !data.summary) return null
  const s = data.summary
  const c = data.confirmation
  const month = parseInt(data.ym.slice(4, 6))
  const done = !!c && !data.stale
  const expanded = open || !done

  const send = async (status: 'ok' | 'issue') => {
    setSending(true); setErr(null)
    try {
      const res = await fetch('/api/attendance/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ym: data.ym, status, note: status === 'issue' ? note : undefined }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error || 'エラー / Lỗi'); return }
      setMode('view'); setNote(''); setOpen(false)
      await load()
    } catch {
      setErr('つうしん エラー / Lỗi kết nối')
    } finally {
      setSending(false)
    }
  }

  const reasonLabel = (r?: string) => REST_REASONS.find(x => x.value === r)?.label || ''
  const Row = ({ ja, vi, v, unit = '日', tone = '' }: { ja: string; vi: string; v: number; unit?: string; tone?: string }) => (
    <div className={`flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0 ${tone}`}>
      <span className="text-sm">{ja}<span className="block text-[11px] text-gray-400">{vi}</span></span>
      <span className="text-lg font-extrabold tabular-nums">{v}<span className="text-xs font-bold ml-0.5">{unit}</span></span>
    </div>
  )

  return (
    <div className={`rounded-2xl border-2 p-4 mb-4 ${done ? 'border-green-200 bg-green-50' : 'border-hibi-amber bg-white'}`}>
      <button type="button" onClick={() => done && setOpen(!open)} className="w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-extrabold text-hibi-charcoal">📋 {month}月の出面の確認</div>
            <div className="text-xs text-gray-500">Xác nhận chấm công tháng {month}</div>
          </div>
          {done ? (
            <span className="text-xs font-bold text-green-700 bg-white rounded-full px-2 py-1">
              {c!.status === 'ok' ? '✓ 確認ずみ / Đã xác nhận' : '✉ 連絡ずみ / Đã báo'}
            </span>
          ) : (
            <span className="text-xs font-bold text-hibi-charcoal bg-hibi-amber rounded-full px-2 py-1">確認してください</span>
          )}
        </div>
        {data.stale && (
          <p className="mt-2 text-xs font-bold text-red-600">
            確認したあとで出面が変わりました。もう一度確認してください。<br />
            Chấm công đã thay đổi sau khi xác nhận. Hãy xác nhận lại.
          </p>
        )}
      </button>

      {expanded && (
        <div className="mt-3">
          <div className="bg-white rounded-xl px-3">
            <Row ja="出勤" vi="Đi làm" v={s.workDays} />
            {s.otHours > 0 && <Row ja="残業" vi="Làm thêm giờ" v={s.otHours} unit="時間" />}
            <Row ja="有給" vi="Nghỉ phép có lương" v={s.plDays} />
            <Row ja="会社の都合の休み" vi="Nghỉ do công ty" v={s.compDays} />
            <Row ja="自分の都合の休み" vi="Nghỉ vì lý do cá nhân" v={s.restDays} tone={s.restDays > 0 ? 'text-red-700' : ''} />
            {s.examDays > 0 && <Row ja="試験" vi="Thi" v={s.examDays} />}
            {s.homeLeaveDays > 0 && <Row ja="帰国" vi="Về nước" v={s.homeLeaveDays} />}
            {s.missingDays.length > 0 && <Row ja="未入力の仕事の日" vi="Ngày làm việc chưa nhập" v={s.missingDays.length} tone="text-red-700" />}
          </div>

          {s.restList.length > 0 && (
            <div className="mt-2 text-xs text-gray-600">
              <div className="font-bold">自分の都合の休みの日 / Ngày nghỉ cá nhân</div>
              <ul className="mt-1 space-y-0.5">
                {s.restList.map(r => (
                  <li key={r.day} className={r.suspect ? 'text-red-700 font-bold' : ''}>
                    {month}/{r.day} {reasonLabel(r.reason)}{r.note ? `「${r.note}」` : ''}
                    {r.suspect && <> ← 会社の都合の休みではありませんか？ / Có phải nghỉ do công ty không?</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.missingDays.length > 0 && (
            <p className="mt-2 text-xs text-red-700">
              未入力の日 / Ngày chưa nhập: {s.missingDays.map(d => `${month}/${d}`).join('、')}<br />
              未入力のままだと、自分の都合の休みとして計算されます。<br />
              Nếu không nhập, sẽ bị tính là nghỉ vì lý do cá nhân.
            </p>
          )}

          <p className="mt-3 text-xs text-gray-500">
            この数で給料を計算します。まちがいがあれば、すぐに知らせてください。<br />
            Lương sẽ được tính theo số này. Nếu có sai, hãy báo ngay.
          </p>

          {mode === 'view' ? (
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button type="button" disabled={sending} onClick={() => send('ok')}
                className="bg-green-600 text-white rounded-xl py-3 font-bold active:bg-green-700 disabled:opacity-50">
                ✓ 正しい<span className="block text-xs font-normal">Đúng</span>
              </button>
              <button type="button" disabled={sending} onClick={() => setMode('issue')}
                className="bg-white border-2 border-red-300 text-red-700 rounded-xl py-3 font-bold active:bg-red-50 disabled:opacity-50">
                まちがいがある<span className="block text-xs font-normal">Có sai</span>
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                placeholder="例: 9/25は出勤しました / VD: Ngày 25/9 tôi đã đi làm"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setMode('view'); setErr(null) }}
                  className="bg-gray-200 text-gray-600 rounded-xl py-3 text-sm">戻る / Quay lại</button>
                <button type="button" disabled={sending || !note.trim()} onClick={() => send('issue')}
                  className="bg-red-600 text-white rounded-xl py-3 font-bold disabled:opacity-50">送る / Gửi</button>
              </div>
            </div>
          )}
          {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
          {c && !data.stale && (
            <p className="mt-2 text-[11px] text-gray-400">
              {new Date(c.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} に{c.status === 'ok' ? '確認' : '連絡'}しました
            </p>
          )}
        </div>
      )}
    </div>
  )
}
