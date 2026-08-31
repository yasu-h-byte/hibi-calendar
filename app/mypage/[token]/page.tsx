'use client'

/**
 * 日本人スタッフのマイページ（2026-08-28 新設）
 *
 * 日本人は出面を職長が記録するため、本人のスマホには出面入力を置かない。
 * 見るのは「有給の残数と申請」「道具代の残額」の2つだけ。
 *
 * ベトナム人向けの /attendance/[token] とは別ページにしている（あちらは
 * 出面入力が主役・日越2言語）。道具代の申請は載せない — 経費申請は
 * マネーフォワードで行うため、ここに置くと二重入力になる（2026-08-28 代表）。
 */
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'

interface MyPageData {
  worker: { id: number; name: string; jobType: string }
  today: string
  leave: {
    noGrant: boolean
    grantDate: string
    periodEnd: string
    total: number
    used: number
    remaining: number
    fiveDayShortfall: number
  }
  sites: { id: string; name: string }[]
  foreman: { siteId: string; siteName: string } | null
}

interface LeaveRequest {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled'
  reason?: string
  rejectedReason?: string
}

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
}

interface ToolBudget {
  budget: number
  used: number
  remaining: number
  purchases: Purchase[]
  period: { start: string; end: string; index: number } | null
  error?: string
}

const STATUS_LABEL: Record<LeaveRequest['status'], { label: string; cls: string }> = {
  pending: { label: '申請中', cls: 'bg-amber-100 text-amber-800' },
  foreman_approved: { label: '職長確認済み', cls: 'bg-blue-100 text-blue-700' },
  approved: { label: '承認済み', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '却下', cls: 'bg-red-100 text-red-600' },
  cancelled: { label: '取り消し', cls: 'bg-gray-200 text-gray-500' },
}

/** 申請日など近い日付用: 「9月3日（木）」 */
const fmtDate = (iso: string) => {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${iso}T00:00:00`).getDay()]
  return `${Number(m)}月${Number(d)}日（${w}）`
}

/** 年をまたぐ期間表示用: 「2025年10月1日」 */
const fmtFull = (iso: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

/**
 * 付与期間の最終日。periodEnd は [grantDate, +12ヶ月) の**開いた端**なので、
 * そのまま出すと「10月1日まで」と1日ずれる。1日戻して 9月30日 と表示する。
 */
const lastDayOf = (endExclusiveIso: string) => {
  if (!endExclusiveIso) return ''
  const d = new Date(`${endExclusiveIso}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function MyPage() {
  const token = useParams().token as string

  const [data, setData] = useState<MyPageData | null>(null)
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [tool, setTool] = useState<ToolBudget | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // 有給申請モーダル
  const [showApply, setShowApply] = useState(false)
  const [applyDate, setApplyDate] = useState('')
  const [applySite, setApplySite] = useState('')
  const [applyReason, setApplyReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mypage?token=${token}`)
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error || 'エラーが発生しました')
        return
      }
      const d: MyPageData = await res.json()
      setData(d)
      if (!applySite && d.sites.length > 0) setApplySite(d.sites[0].id)

      // 有給申請の一覧と道具代は既存 API をそのまま使う
      const [rRes, tRes] = await Promise.all([
        fetch(`/api/leave-request?token=${token}`),
        fetch(`/api/tool-budget?token=${token}`),
      ])
      if (rRes.ok) setRequests((await rRes.json()).requests || [])
      if (tRes.ok) setTool(await tRes.json())
      else setTool(null)
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [token, applySite])

  useEffect(() => { load() }, [load])

  const submitLeave = async () => {
    if (!data || !applyDate || saving) return
    setSaving(true); setMsg('')
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request', token, date: applyDate,
          siteId: applySite || undefined,
          reason: applyReason || undefined,
        }),
      })
      if (!res.ok) {
        alert((await res.json().catch(() => null))?.error || '申請できませんでした')
        return
      }
      setShowApply(false)
      setApplyDate('')
      setApplyReason('')
      setMsg('有給を申請しました。承認されるとここに反映されます。')
      setTimeout(() => setMsg(''), 4000)
      load()
    } finally { setSaving(false) }
  }

  const cancelRequest = async (r: LeaveRequest) => {
    if (!confirm(`${fmtDate(r.date)} の有給申請を取り消します。よろしいですか？`)) return
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId: r.id, token }),
      })
      if (!res.ok) {
        alert((await res.json().catch(() => null))?.error || '取り消しできませんでした')
        return
      }
      load()
    } catch { alert('通信エラーが発生しました') }
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F1F2F5]">
        <div className="text-hibi-charcoal font-bold">読み込み中...</div>
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F1F2F5] p-4">
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center max-w-sm w-full">
          <div className="text-red-500 font-bold mb-2">エラー</div>
          <div className="text-gray-700 text-sm">{error}</div>
        </div>
      </div>
    )
  }
  if (!data) return null

  const lv = data.leave
  // 申請中・承認済みの未来の有給（本人が「出す予定」を把握できるように）
  const upcoming = requests.filter(r =>
    (r.status === 'pending' || r.status === 'foreman_approved' || r.status === 'approved')
    && r.date >= data.today)

  return (
    <div className="min-h-screen bg-[#F1F2F5] pb-10">
      <div className="bg-hibi-charcoal text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-sm opacity-70">マイページ</div>
          <div className="text-lg sm:text-xl font-bold truncate">{data.worker.name} さん</div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {msg && (
          <div className="bg-green-100 text-green-800 rounded-xl p-3 text-center font-bold text-sm">{msg}</div>
        )}

        {/* ── 有給 ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm font-bold text-gray-500 mb-3">🌴 有給休暇</div>

          {lv.noGrant ? (
            <div className="text-sm text-gray-500 py-2">
              まだ付与されていません。付与されるとここに残日数が出ます。
            </div>
          ) : (
            <>
              <div className="flex items-end gap-3">
                <div className="text-4xl font-extrabold text-green-700 tabular-nums leading-none">
                  {lv.remaining}
                </div>
                <div className="text-sm text-gray-500 pb-1">日 残っています</div>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                今期 {lv.total}日 のうち {lv.used}日 取得済み
                <span className="block mt-0.5">
                  期間: {fmtFull(lv.grantDate)} 〜 {fmtFull(lastDayOf(lv.periodEnd))}
                </span>
              </div>

              {lv.fiveDayShortfall > 0 && (
                <div className="mt-3 bg-red-50 border-2 border-red-200 rounded-lg p-3">
                  <div className="text-sm font-bold text-red-700">
                    ⚠️ 今期中にあと {lv.fiveDayShortfall}日 取得が必要です
                  </div>
                  <div className="text-xs text-red-600 mt-1">
                    法律で「年5日以上の取得」が義務づけられています。
                    {fmtFull(lastDayOf(lv.periodEnd))} までに取ってください。
                  </div>
                </div>
              )}
            </>
          )}

          <button
            onClick={() => { setShowApply(true); setApplyDate('') }}
            disabled={lv.noGrant || lv.remaining <= 0}
            className="w-full mt-4 rounded-xl py-3.5 bg-hibi-amber text-hibi-charcoal font-extrabold shadow-[0_4px_12px_rgba(245,166,35,0.4)] active:bg-hibi-amberDark disabled:opacity-40"
          >
            🌴 有給を申請する
          </button>
          {!lv.noGrant && lv.remaining <= 0 && (
            <div className="text-xs text-gray-400 text-center mt-1.5">残日数がないため申請できません</div>
          )}
        </div>

        {/* ── これからの有給 ── */}
        {upcoming.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="text-sm font-bold text-gray-500 mb-2">これからの有給</div>
            <div className="space-y-1.5">
              {upcoming.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="text-sm font-medium text-gray-800">{fmtDate(r.date)}</span>
                  <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_LABEL[r.status].cls}`}>
                    {STATUS_LABEL[r.status].label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 道具代 ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm font-bold text-gray-500 mb-3">🔧 道具代</div>
          {/* period が null = 期間起点日が未設定。この状態の budget は「既定額」でしかなく、
              実際には何も管理されていない。残額として見せると誤解を招くので出さない */}
          {!tool || tool.error || !tool.period ? (
            <div className="text-sm text-gray-500">
              道具代の枠がまだ設定されていません。事務担当にお問い合わせください。
            </div>
          ) : (
            <>
              <div className="flex items-end gap-3">
                <div className="text-3xl font-extrabold text-hibi-charcoal tabular-nums leading-none">
                  ¥{tool.remaining.toLocaleString()}
                </div>
                <div className="text-sm text-gray-500 pb-0.5">残り</div>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                年間 ¥{tool.budget.toLocaleString()} のうち ¥{tool.used.toLocaleString()} 使用
                {tool.period && (
                  <span className="block mt-0.5">
                    期間: {tool.period.start.replace(/-/g, '/')} 〜 {tool.period.end.replace(/-/g, '/')}
                  </span>
                )}
              </div>
              {tool.purchases.length > 0 && (
                <div className="mt-3 border-t border-gray-100 pt-3 space-y-1.5">
                  {[...tool.purchases].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(p => (
                    <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-gray-500 tabular-nums whitespace-nowrap">
                        {p.date.slice(5).replace('-', '/')}
                      </span>
                      <span className="flex-1 truncate text-gray-700">{p.item || '道具'}</span>
                      <span className="tabular-nums font-bold text-gray-800">¥{p.amount.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
                道具の購入申請はマネーフォワードから行ってください。
                ここには承認・登録された分が反映されます。
              </p>
            </>
          )}
        </div>

        {/* 職長は出面の確認画面へ */}
        {data.foreman && (
          <a href={`/attendance/foreman/${token}`}
            className="block bg-white rounded-xl border border-gray-200 shadow-sm p-4 active:bg-gray-50">
            <div className="flex items-center gap-3">
              <span className="text-xl">📋</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-bold text-hibi-charcoal">出面の確認・承認</span>
                <span className="block text-xs text-gray-500 truncate">{data.foreman.siteName}</span>
              </span>
              <span className="text-gray-300">›</span>
            </div>
          </a>
        )}
      </div>

      {/* ── 有給申請モーダル ── */}
      {showApply && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setShowApply(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg px-5 pt-5"
            style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-charcoal mb-4 text-center">有給の申請</h3>

            <label className="block mb-3">
              <span className="text-xs text-gray-500 font-bold">取得する日</span>
              <input type="date" value={applyDate} min={data.today}
                onChange={e => setApplyDate(e.target.value)}
                className="mt-1 w-full border-2 border-gray-300 rounded-lg px-3 py-3 text-base tabular-nums" />
              <span className="text-[11px] text-gray-400 mt-1 block">
                当日・未来の日を選べます（現場が稼働している日のみ）
              </span>
            </label>

            {data.sites.length > 1 && (
              <label className="block mb-3">
                <span className="text-xs text-gray-500 font-bold">現場</span>
                <select value={applySite} onChange={e => setApplySite(e.target.value)}
                  className="mt-1 w-full border-2 border-gray-300 rounded-lg px-3 py-3 text-base bg-white">
                  {data.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}

            <label className="block mb-4">
              <span className="text-xs text-gray-500 font-bold">理由（任意）</span>
              <input type="text" value={applyReason} onChange={e => setApplyReason(e.target.value)}
                placeholder="私用 など"
                className="mt-1 w-full border-2 border-gray-300 rounded-lg px-3 py-3 text-base" />
            </label>

            <button onClick={submitLeave} disabled={!applyDate || saving}
              className="w-full rounded-xl py-3.5 bg-hibi-amber text-hibi-charcoal font-extrabold active:bg-hibi-amberDark disabled:opacity-40">
              {saving ? '送信中...' : 'この日で申請する'}
            </button>
            <button onClick={() => setShowApply(false)}
              className="w-full mt-2 rounded-xl py-3 bg-white border-2 border-gray-300 text-hibi-charcoal font-bold active:bg-gray-100">
              やめる
            </button>

            {/* 申請履歴（取り消しもここから） */}
            {requests.length > 0 && (
              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="text-xs font-bold text-gray-500 mb-2">申請の履歴</div>
                <div className="max-h-52 overflow-y-auto space-y-1.5">
                  {requests.slice(0, 20).map(r => (
                    <div key={r.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-gray-700 min-w-0 truncate">{fmtDate(r.date)}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${STATUS_LABEL[r.status].cls}`}>
                        {STATUS_LABEL[r.status].label}
                      </span>
                      {r.status === 'pending' && (
                        <button onClick={() => cancelRequest(r)}
                          className="text-[11px] text-red-600 font-bold whitespace-nowrap px-2 py-0.5">
                          取り消す
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
