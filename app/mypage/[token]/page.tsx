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
 *
 * 職長もこのページを使う。職長専用の出面画面は用意してあるが、職長は従来どおり
 * PC画面をスマホで操作する運用になったため、ここからは導線を張らない（2026-08-28 代表）。
 *
 * 2026-10-01（代表）: 職長・政仁さん・代表には先頭に「承認すること」を出す。
 *   職長 = 出面のまとめ承認・有給／帰国申請の職長承認。政仁さん・代表 = 最終承認・職長がいない現場の代行・配置の見直し。
 *   components/mypage/ForemanApprovals.tsx。それ以外の人には何も出ない。
 * 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */
import { leaveRequestEarliestDate } from '@/lib/leave-rules'
import { todayJstIso } from '@/lib/date-utils'
import { confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import StaffHeader from '@/components/StaffHeader'
import { Icon } from '@/components/ui/Icon'
import ForemanApprovals from '@/components/mypage/ForemanApprovals'
import LeaveSettleCard from '@/components/mypage/LeaveSettleCard'
import LeaveSettleApprovals from '@/components/leave/LeaveSettleApprovals'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

interface MyPageData {
  worker: { id: number; name: string; jobType: string }
  /** 「承認すること」を出す人か（職長・政仁さん・代表） */
  canApprove?: boolean
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
}

interface LeaveRequest {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled' | 'revoked'
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
  /** 前の期間からの繰越（2026-09-30）。マイナスは使いすぎの持ち越し */
  carry?: number
  budget: number
  used: number
  remaining: number
  purchases: Purchase[]
  period: { start: string; end: string; index: number } | null
  notStarted?: boolean
  error?: string
}

const STATUS_LABEL: Record<LeaveRequest['status'], { label: string; cls: string }> = {
  pending: { label: '申請中', cls: 'bg-amber-100 text-amber-800' },
  foreman_approved: { label: '職長確認済み', cls: 'bg-blue-100 text-blue-700' },
  approved: { label: '承認済み', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '却下', cls: 'bg-red-100 text-red-600' },
  cancelled: { label: '取り消し', cls: 'bg-gray-200 text-gray-500' },
  revoked: { label: '管理者取消', cls: 'bg-gray-200 text-gray-500' },
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
  const dataRef = useRef<MyPageData | null>(null)
  // 取得の連番。古い応答は捨てる
  const loadSeqRef = useRef(0)
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  // undefined = 読み込み中、null = 取得できなかった（読み込み中に「枠が未設定」と誤表示しないため）
  const [tool, setTool] = useState<ToolBudget | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // 有給申請モーダル
  const [showApply, setShowApply] = useState(false)
  const [applyDate, setApplyDate] = useState('')
  const [applySite, setApplySite] = useState('')
  const [applyReason, setApplyReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // 現場の初期値は関数型の更新で入れ、load を applySite に依存させない（2026-10-02 総合点検）。
  //   旧: 1回目の応答で setApplySite すると load が作り直されて useEffect がもう一度走り、開くたびに3本の GET が2回ずつ走った
  //      （有給残は最大13か月分の出面を読む）。申請モーダルで現場を変えても取り直していた
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const res = await fetch(`/api/mypage?token=${token}`)
      if (seq !== loadSeqRef.current) return
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error || 'エラーが発生しました')
        return
      }
      const d: MyPageData = await res.json()
      if (seq !== loadSeqRef.current) return
      setData(d)
      dataRef.current = d
      setError('')
      if (d.sites.length > 0) setApplySite(prev => prev || d.sites[0].id)

      // 有給申請の一覧と道具代は既存 API をそのまま使う
      const [rRes, tRes] = await Promise.all([
        fetch(`/api/leave-request?token=${token}`),
        fetch(`/api/tool-budget?token=${token}`),
      ])
      if (seq !== loadSeqRef.current) return
      if (rRes.ok) setRequests((await rRes.json()).requests || [])
      if (tRes.ok) setTool(await tRes.json())
      else setTool(null)
    } catch {
      if (seq === loadSeqRef.current) setError('通信エラーが発生しました')
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  // 画面に戻ってきたとき、日本時間の今日が変わっていれば取り直す（2026-10-02 総合点検。申請できる最初の日が前日基準のまま残らないように）
  useEffect(() => {
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const cur = dataRef.current
      if (cur && cur.today !== todayJstIso()) load()
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
    }
  }, [load])

  // 申請ボタン（SaveButton）から呼ぶ。失敗の理由を返すとボタンが赤の帯を出す。通信が切れたときの例外もそのままボタンへ
  const submitLeave = async (): Promise<{ ok: boolean; error?: string } | void> => {
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
        return { ok: false, error: (await res.json().catch(() => null))?.error || 'サーバが受け付けませんでした' }
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
    if (!(await confirmDanger({
      title: `${fmtDate(r.date)} の有給申請を取り消しますか？`,
      confirmLabel: '取り消す',
    }))) return
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId: r.id, token }),
      })
      if (!res.ok) {
        notify.failed('取り消し', (await res.json().catch(() => null))?.error || 'サーバが受け付けませんでした')
        return
      }
      load()
    } catch (e) { notify.failed('取り消し', e) }
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-hibi-bg">
        <div className="text-hibi-charcoal font-bold">読み込み中...</div>
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-hibi-bg p-4">
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center max-w-sm w-full">
          <div className="text-red-500 font-bold mb-2">エラー</div>
          <div className="text-gray-700 text-sm">{error}</div>
          {/* ホーム画面のアプリには再読込ボタンがないので、画面に置く（2026-10-02 総合点検） */}
          <button type="button" onClick={() => { setError(''); setLoading(true); load() }}
            className="mt-4 w-full min-h-[48px] bg-hibi-amber text-hibi-charcoal rounded-xl py-3 text-base font-extrabold active:bg-hibi-amberDark">
            もう一度
          </button>
        </div>
      </div>
    )
  }
  if (!data) return null

  const lv = data.leave
  // 申請中・承認済みの未来の有給（本人が「出す予定」を把握できるように）。
  // これからの日の却下も理由つきで出す（2026-10-02 総合点検。旧: 却下は履歴にラベルだけで理由を出す所がなかった）
  const upcoming = requests.filter(r =>
    (r.status === 'pending' || r.status === 'foreman_approved' || r.status === 'approved' || r.status === 'rejected')
    && r.date >= data.today)
  // 申請できる人（残日数がある）。残0でも履歴・取り消しは見られるようにする（旧: ボタンが無効で履歴に行けなかった）
  const canApply = !lv.noGrant && lv.remaining > 0

  return (
    <div className="min-h-screen bg-hibi-bg pb-10">
      <StaffHeader label="マイページ" name={`${data.worker.name} さん`} />

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {msg && (
          <div className="bg-green-100 text-green-800 rounded-xl p-3 text-center font-bold text-sm">{msg}</div>
        )}

        {/* ── 承認すること（職長だけ） ── */}
        <ForemanApprovals token={token} canApprove={!!data.canApprove} />
        {/* 有給精算の承認（政仁さん・代表だけ。承認待ちがあるときだけ出る） */}
        {data.canApprove && <LeaveSettleApprovals token={token} />}

        {/* ── 有給 ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm font-bold text-gray-500 mb-3 inline-flex items-center gap-1.5"><Icon name="umbrella" size={15} />有給休暇</div>

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
                今期 {lv.total}日 のうち {lv.used}日 使用済み
                <span className="block mt-0.5">
                  期間: {fmtFull(lv.grantDate)} 〜 {fmtFull(lastDayOf(lv.periodEnd))}
                </span>
              </div>

              {lv.fiveDayShortfall > 0 && (
                <div className="mt-3 bg-red-50 border-2 border-red-200 rounded-lg p-3">
                  <div className="text-sm font-bold text-red-700">
                    今期中にあと {lv.fiveDayShortfall}日 取得が必要です
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
            disabled={!canApply}
            className="w-full mt-4 rounded-xl py-3.5 inline-flex items-center justify-center gap-1.5 bg-hibi-amber text-hibi-charcoal font-extrabold shadow-[0_4px_12px_rgba(245,166,35,0.4)] active:bg-hibi-amberDark disabled:opacity-40"
          >
            <Icon name="umbrella" size={16} />有給を申請する
          </button>
          {!lv.noGrant && lv.remaining <= 0 && (
            <div className="text-xs text-hibi-sub text-center mt-1.5">残日数がないため申請できません</div>
          )}
          {/* 有給のルールの説明（年5日・申請・有給精算・期末の買取。public/notice-yukyu-rule-jp.html・2026-10-08） */}
          <a href="/notice-yukyu-rule-jp.html"
            className="w-full mt-2 rounded-xl min-h-[44px] py-2.5 inline-flex items-center justify-center gap-1.5 bg-white border-2 border-gray-300 text-hibi-charcoal font-bold active:bg-gray-100">
            <Icon name="book" size={16} />有給のルールを読む
          </a>
          {!canApply && requests.length > 0 && (
            <button type="button"
              onClick={() => { setShowApply(true); setApplyDate('') }}
              className="w-full mt-2 rounded-xl min-h-[44px] py-2.5 bg-white border-2 border-gray-300 text-hibi-charcoal font-bold active:bg-gray-100">
              申請の履歴・取り消し
            </button>
          )}
        </div>

        {/* ── 有給精算（日本人の日給月給の人だけ出る・2026-10-08） ── */}
        <LeaveSettleCard token={token} onChanged={load} />

        {/* ── これからの有給 ── */}
        {upcoming.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="text-sm font-bold text-gray-500 mb-2">これからの有給</div>
            <div className="space-y-1.5">
              {upcoming.map(r => (
                <div key={r.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800">{fmtDate(r.date)}</span>
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_LABEL[r.status].cls}`}>
                      {STATUS_LABEL[r.status].label}
                    </span>
                  </div>
                  {r.status === 'rejected' && (
                    <div className="text-sm text-red-800 mt-0.5">却下の理由: {r.rejectedReason || '—'}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 道具代 ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm font-bold text-gray-500 mb-3 inline-flex items-center gap-1.5"><Icon name="wrench" size={15} />道具代</div>
          {/* period が null = 期間起点日が未設定。この状態の budget は「既定額」でしかなく、
              実際には何も管理されていない。残額として見せると誤解を招くので出さない */}
          {tool === undefined ? (
            <div className="text-sm text-gray-400">読み込み中...</div>
          ) : !tool || tool.error || !tool.period ? (
            <div className="text-sm text-gray-500">
              道具代の枠がまだ設定されていません。事務担当にお問い合わせください。
            </div>
          ) : tool.notStarted ? (
            /* 制度開始前（例: 日本人は 2026-10-01 施行）。残額として見せず開始予告だけ出す */
            <div className="text-sm text-gray-700">
              <span className="font-bold">{fmtFull(tool.period.start)}</span> から
              年間 <span className="font-bold tabular-nums">¥{tool.budget.toLocaleString()}</span> の
              道具代補助が始まります。
              <span className="block text-xs text-hibi-sub mt-1.5">
                それまでの購入申請は従来どおりマネーフォワードから行ってください。
              </span>
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
                年間 ¥{tool.budget.toLocaleString()}{(tool.carry ?? 0) !== 0 && <>（前期からの繰越 {(tool.carry ?? 0) > 0 ? '+' : '−'}¥{Math.abs(tool.carry ?? 0).toLocaleString()}）</>} のうち ¥{tool.used.toLocaleString()} 使用
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
              <p className="text-xs text-hibi-sub mt-3 leading-relaxed">
                道具の購入申請はマネーフォワードから行ってください。
                ここには承認・登録された分が反映されます。
              </p>
            </>
          )}
        </div>

      </div>

      {/* ── 有給申請モーダル ── */}
      {showApply && (
        <Modal
          open
          onClose={() => setShowApply(false)}
          title={canApply ? '有給の申請' : '有給の申請の履歴'}
          dirty={canApply && (!!applyDate || applyReason.trim() !== '')}
          footer={
            <>
              <CancelButton onClick={() => setShowApply(false)} disabled={saving} size="lg">{canApply ? 'やめる' : '閉じる'}</CancelButton>
              {canApply && (
                <SaveButton action="申請" label="この日で申請する" disabled={!applyDate || saving} size="lg" className="flex-1" onSave={submitLeave} />
              )}
            </>
          }
        >
            {!canApply && (
              <p className="text-sm text-hibi-sub mb-3 text-center">残日数がないため、新しい申請はできません。</p>
            )}
            {canApply && (
            <>
            <label className="block mb-3">
              <span className="text-xs text-gray-500 font-bold">取得する日</span>
              <input type="date" value={applyDate} min={leaveRequestEarliestDate(data.today)}
                onChange={e => setApplyDate(e.target.value)}
                className="mt-1 w-full border-2 border-gray-300 rounded-lg px-3 py-3 text-base tabular-nums" />
              <span className="text-xs text-hibi-sub mt-1 block">
                前日までに申請してください。当日・過ぎた日は申請できません（現場が稼働している日のみ）
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

            <label className="block">
              <span className="text-xs text-gray-500 font-bold">理由（任意）</span>
              <input type="text" value={applyReason} onChange={e => setApplyReason(e.target.value)}
                placeholder="私用 など"
                className="mt-1 w-full border-2 border-gray-300 rounded-lg px-3 py-3 text-base" />
            </label>
            </>
            )}

            {/* 申請履歴（取り消しもここから）。却下は理由も出す */}
            {requests.length > 0 && (
              <div className={`border-t border-gray-100 pt-4 ${canApply ? 'mt-5' : ''}`}>
                <div className="text-xs font-bold text-gray-500 mb-2">申請の履歴</div>
                <div className="space-y-1">
                  {requests.slice(0, 20).map(r => (
                    <div key={r.id}>
                      <div className="flex items-center justify-between gap-2 min-h-[44px]">
                        <span className="text-sm text-gray-700 min-w-0 truncate">{fmtDate(r.date)}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${STATUS_LABEL[r.status].cls}`}>
                          {STATUS_LABEL[r.status].label}
                        </span>
                        {r.status === 'pending' && (
                          /* 44px 以上（2026-10-02 総合点検。旧: 11px の文字だけで約20px） */
                          <button onClick={() => cancelRequest(r)}
                            className="text-sm text-red-600 font-bold whitespace-nowrap min-h-[44px] px-3 rounded-xl border-2 border-red-200 bg-red-50 active:bg-red-100">
                            取り消す
                          </button>
                        )}
                      </div>
                      {r.status === 'rejected' && (
                        <div className="text-sm text-red-800 -mt-1 mb-1">却下の理由: {r.rejectedReason || '—'}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
        </Modal>
      )}
    </div>
  )
}
