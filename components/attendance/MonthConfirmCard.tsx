'use client'
/**
 * 本人の出面確認カード（2026-09-30）
 * 2026-10-03: 飾りの絵文字を外した（線のアイコンか文字に）
 *
 * 前の月の全部の日に職長承認と最終承認（事業責任者）がそろったら、スタッフのスマホの上のほうに出る
 * （そろうまでは「チェックが終わったらここに出ます」の1行だけ。締めたら出ない）。
 * 出勤・有給・会社の都合の休み・自分の都合の休み・未入力の数を見せ、
 * 「正しい」「まちがいがある（どこが）」を押してもらう。記録は事務所の月次集計と月締めのチェックに出る。
 * 数え方は lib/attendance-confirm.ts。前の月の出面は承認でロックされているので、毎日の保存では読み直さない。
 */
import { useCallback, useEffect, useState } from 'react'
import type { StaffMonthSummary, AttConfirmDoc } from '@/lib/attendance-confirm'
import { REST_REASONS } from '@/components/attendance/RestReportModal'
import { STAFF_TEXT, biLine } from '@/lib/labels'

interface ConfirmData {
  ym: string | null
  /** 職長・事業責任者のチェック待ち */
  waiting?: boolean
  summary?: StaffMonthSummary
  confirmation?: AttConfirmDoc | null
  stale?: boolean
  /** 承認がそろっている（false なら押せない＝事務所が直している途中） */
  ready?: boolean
}

export default function MonthConfirmCard({ token }: { token: string }) {
  const [data, setData] = useState<ConfirmData | null>(null)
  const [mode, setMode] = useState<'view' | 'issue'>('view')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // 取得の失敗（2026-10-02 総合点検。旧: 失敗するとカードごと出ず、本人は確認の月があることに気づけなかった）
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/attendance/confirm?token=${encodeURIComponent(token)}`)
      if (res.ok) setData(await res.json())
      else setLoadFailed(true)
    } catch { setLoadFailed(true) }
  }, [token])
  useEffect(() => { load() }, [load])

  if (loadFailed && !data) {
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 mb-4 text-sm text-red-700 flex items-center justify-between gap-2">
        <span>{biLine(STAFF_TEXT.loadFailed)}<span className="block text-xs">出面の確認 / Xác nhận chấm công</span></span>
        <button type="button" onClick={load}
          className="min-h-[44px] px-3 rounded-xl bg-white border-2 border-red-300 text-red-700 font-bold active:bg-red-100 shrink-0">
          {biLine(STAFF_TEXT.retry)}
        </button>
      </div>
    )
  }
  if (!data?.ym) return null
  if (data.waiting) {
    const wm = parseInt(data.ym.slice(4, 6))
    return (
      <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 mb-4 text-xs text-gray-500">
        {wm}月の出面の確認は、職長と事業責任者のチェックが全部終わったら、ここに出ます。<br />
        Xác nhận chấm công tháng {wm} sẽ hiện ở đây sau khi tổ trưởng và người phụ trách kiểm tra xong.
      </div>
    )
  }
  if (!data.summary) return null
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

  // 理由も日越（2026-10-02 総合点検。旧: 日本語のラベルだけ）
  const reasonLabel = (r?: string) => {
    const x = REST_REASONS.find(x => x.value === r)
    return x ? `${x.label} / ${x.vi}` : ''
  }
  // ベトナム語は本人にとって本文なので 12px 以上・text-hibi-sub の濃さ（2026-10-02 総合点検。旧: 11px の gray-400）
  const Row = ({ ja, vi, v, unit = '日', tone = '' }: { ja: string; vi: string; v: number; unit?: string; tone?: string }) => (
    <div className={`flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0 ${tone}`}>
      <span className="text-sm">{ja}<span className="block text-xs text-hibi-sub">{vi}</span></span>
      <span className="text-lg font-extrabold tabular-nums">{v}<span className="text-xs font-bold ml-0.5">{unit}</span></span>
    </div>
  )

  return (
    <div className={`rounded-2xl border-2 p-4 mb-4 ${done ? 'border-green-200 bg-green-50' : 'border-hibi-amber bg-white'}`}>
      <button type="button" onClick={() => done && setOpen(!open)} className="w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-extrabold text-hibi-charcoal">{month}月の出面の確認</div>
            <div className="text-xs text-gray-500">Xác nhận chấm công tháng {month}</div>
          </div>
          {done ? (
            <span className="text-xs font-bold text-green-700 bg-white rounded-full px-2 py-1">
              {c!.status === 'ok' ? '✓ 確認ずみ / Đã xác nhận' : c!.resolvedAt ? '✓ 会社が対応 / Công ty đã xử lý' : '連絡ずみ / Đã báo'}
            </span>
          ) : (
            <span className="text-xs font-bold text-hibi-charcoal bg-hibi-amber rounded-full px-2 py-1">{biLine(STAFF_TEXT.pleaseConfirm)}</span>
          )}
        </div>
        {/* 会社からの返事（事務所が「対応済み」にしたとき・2026-09-30） */}
        {done && c!.status === 'issue' && c!.resolvedAt && (
          <p className="mt-2 text-xs text-sky-800 bg-sky-50 rounded-lg px-3 py-2 whitespace-pre-wrap">
            会社が確認しました / Công ty đã kiểm tra.{c!.reply ? `\n会社から / Từ công ty: ${c!.reply}` : ''}
          </p>
        )}
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
            {/* 休憩短縮（旧契約の毎日20分など・2026-09-30）: 出面には記録せず給与計算で足している分を見せる */}
            {s.breakShorten && s.breakShorten.minutes > 0 && (
              <div className="py-1.5 border-b border-gray-100 last:border-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm">休憩短縮（毎日{s.breakShorten.minPerDay}分）
                    <span className="block text-xs text-hibi-sub">Rút ngắn nghỉ ({s.breakShorten.minPerDay} phút/ngày)</span>
                  </span>
                  <span className="text-lg font-extrabold tabular-nums">
                    {Math.floor(s.breakShorten.minutes / 60)}<span className="text-xs font-bold ml-0.5">時間</span>
                    {s.breakShorten.minutes % 60 > 0 && <>{s.breakShorten.minutes % 60}<span className="text-xs font-bold ml-0.5">分</span></>}
                  </span>
                </div>
                <div className="text-xs text-hibi-sub mt-0.5">
                  出勤{s.breakShorten.days}日 × {s.breakShorten.minPerDay}分。残業と同じ単価で給料に入ります。<br />
                  {s.breakShorten.days} ngày × {s.breakShorten.minPerDay} phút. Được trả lương như làm thêm giờ.
                </div>
              </div>
            )}
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

          {data.ready === false ? (
            <p className="mt-3 text-xs font-bold text-gray-500">
              事務所が出面を直しています。チェックが終わったら、もう一度確認できます。<br />
              Công ty đang sửa chấm công. Sau khi kiểm tra xong, bạn có thể xác nhận lại.
            </p>
          ) : mode === 'view' ? (
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
              {/* 16px（旧 text-sm だと iOS がフォーカスで画面を拡大する・2026-10-02 総合点検） */}
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                placeholder="例: 9/25は出勤しました / VD: Ngày 25/9 tôi đã đi làm"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-base" />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setMode('view'); setErr(null) }}
                  className="bg-gray-200 text-gray-600 rounded-xl py-3 text-sm">戻る / Quay lại</button>
                <button type="button" disabled={sending || !note.trim()} onClick={() => send('issue')}
                  className="bg-red-600 text-white rounded-xl py-3 font-bold disabled:opacity-50">送る / Gửi</button>
              </div>
            </div>
          )}
          {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
          {c && !data.stale && (
            <p className="mt-2 text-xs text-hibi-sub tabular-nums">
              {new Date(c.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} に{c.status === 'ok' ? STAFF_TEXT.confirmedAt.ja : STAFF_TEXT.reportedAt.ja}
              <span className="block">{c.status === 'ok' ? STAFF_TEXT.confirmedAt.vi : STAFF_TEXT.reportedAt.vi} lúc {new Date(c.at).toLocaleString('vi-VN', { timeZone: 'Asia/Tokyo' })}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
