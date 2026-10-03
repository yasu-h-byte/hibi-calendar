'use client'

// ダッシュボード（2026-10-01 改修・UI順次改修 波1・見本キャンバス6段目「ダッシュボード 改善案」）
//
//   旧: 「今日の判断」→ 勤怠申請 → お知らせ → 評価 → 前日の稼働 → 今月の数字 → グラフ が縦に1列。
//       勤怠申請・お知らせ・評価は絵文字と色帯の古い見た目のままで、読む順番もばらばらだった。
//   新: ① 上に「今やること」4枚（承認待ち・給与の検算・期限・年5日）
//       ② 左＝やること（申請を1件1行・気になること）／右＝数字を見るもの（前日の稼働・今月の数字・お知らせ・評価）
//   計算・権限・承認の処理は変えない（見せ方だけ）。承認ボタンの出し分けは旧 AttendanceRequestCard と同じ。

import { can } from '@/lib/permissions'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { fmtYenMan, fmtNum } from '@/lib/format'
import EvaluationCard from '@/components/EvaluationCard'
import { AuthUser } from '@/types'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Segment, Chip, type ChipTone } from '@/components/ui/PageParts'
import { currentYmJst, todayJstIso, addDaysIso } from '@/lib/date-utils'
import { fetchSidebarBadges } from '@/components/Sidebar'

// ─── Types ───

interface DashboardSummary {
  totalManDays: number
  billing: number
  prevTotalManDays: number
  pctWork: number
}

interface TodaySiteStatus {
  siteId: string
  siteName: string
  tobi: number
  doko: number
  subTobi: number
  subDoko: number
  total: number
}

interface DailyAttendance {
  day: number
  sites: { siteId: string; siteName: string; count: number }[]
}

interface SiteOption {
  id: string
  name: string
}

interface LeaveRequestItem {
  id: string
  workerName: string
  date: string
  siteId: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
  siteForemanName?: string  // 該当現場の職長名（ボタン表示用）
}

interface AbsenceReport {
  workerName: string
  date: string
  reason: string
  reasonLabel: string
  note?: string
}

interface HomeLongLeaveItem {
  id: string
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
  siteForemanName?: string  // 対象スタッフの配置現場の職長名（ボタン表示用）
}

interface QuietIssue {
  kind: 'nightUnregistered' | 'legalShortfall' | 'sundayNoRest' | 'earlyReturn' | 'staleAttendance'
    | 'wageRevisionPending' | 'staleAssignment'
  workerName: string
  detail: string
  href: string
}

interface ActionItems {
  pendingLeaveRequests: { count: number; items: LeaveRequestItem[] }
  absenceReports?: AbsenceReport[]
  homeLongLeaveRequests?: HomeLongLeaveItem[]
  plShortfall?: { count: number; names?: string[] }
  quietIssues?: { count: number; items: QuietIssue[] }
  visaExpiry?: { count: number; items: { name: string; daysLeft: number; expiry: string }[] }
}

interface DashboardData {
  summary: DashboardSummary
  todayStatus: { siteStatus: TodaySiteStatus[]; absentWorkers: { id: number; name: string }[] }
  dailyAttendance: DailyAttendance[]
  siteList: SiteOption[]
  selectedYm: string
  actionItems?: ActionItems
}

// ─── Helpers ───

const SITE_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-orange-500', 'bg-indigo-500',
]
const siteColor = (index: number) => SITE_COLORS[(index < 0 ? 0 : index) % SITE_COLORS.length]

const DOW = ['日', '月', '火', '水', '木', '金', '土']
/** 2026-10-01 → 10/1（木） */
const mdw = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}（${DOW[new Date(`${iso}T00:00:00`).getDay()]}）`
/** 2026-10-01 → 10/1 */
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

const KIND_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  staleAssignment: { label: '配置の見直し', tone: 'amber' },
  staleAttendance: { label: '出面未入力', tone: 'amber' },
  nightUnregistered: { label: '夜勤未登録', tone: 'amber' },
  legalShortfall: { label: '法定割れ', tone: 'red' },
  sundayNoRest: { label: '日曜（休みなし週）', tone: 'amber' },
  earlyReturn: { label: '帰国申請', tone: 'amber' },
  wageRevisionPending: { label: '賃金改定未反映', tone: 'blue' },
}

/** カードの外枠と見出し（案1 UDホワイト） */
function Card({ title, sub, right, children, id }: {
  title: React.ReactNode
  sub?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  id?: string
}) {
  return (
    <section id={id} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden scroll-mt-4">
      <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex items-center justify-between gap-3">
        <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">
          {title}{sub && <span className="ml-2 text-[0.8125rem] font-normal text-hibi-sub dark:text-gray-400">{sub}</span>}
        </h2>
        {right}
      </div>
      {children}
    </section>
  )
}

function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-[0.8125rem] font-bold text-hibi-navy dark:text-blue-300 inline-flex items-center gap-0.5 hover:underline whitespace-nowrap">
      {children}<Icon name="chevronRight" size={13} />
    </a>
  )
}

// ─── お知らせ ───

interface DashboardAnnouncement {
  id: string; title: string; content: string
  category: 'new' | 'fix' | 'info'; publishedAt: string
}

const CAT: Record<string, { label: string; tone: ChipTone }> = {
  new: { label: '新機能', tone: 'blue' },
  fix: { label: '修正', tone: 'green' },
  info: { label: 'お知らせ', tone: 'gray' },
}

function relTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 60) return `${Math.max(diff, 0)}分前`
  if (diff < 1440) return `${Math.floor(diff / 60)}時間前`
  const days = Math.floor(diff / 1440)
  return days === 1 ? '昨日' : days < 7 ? `${days}日前` : `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}`
}

function AnnouncementsCard({ password }: { password: string }) {
  const [items, setItems] = useState<DashboardAnnouncement[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!password) return
    fetch('/api/announcements', { headers: { 'x-admin-password': password } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setItems((data.announcements || []).slice(0, 3)) })
      .finally(() => setLoaded(true))
  }, [password])

  if (!loaded || items.length === 0) return null
  return (
    <Card title="お知らせ">
      <ul className="divide-y divide-hibi-line dark:divide-gray-700">
        {items.map(a => {
          const c = CAT[a.category] || CAT.info
          return (
            <li key={a.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-1">
                <Chip tone={c.tone}>{c.label}</Chip>
                <span className="text-xs text-hibi-sub dark:text-gray-400">{relTime(a.publishedAt)}</span>
              </div>
              <div className="text-sm font-bold text-gray-900 dark:text-gray-100">{a.title}</div>
              <p className="text-xs text-hibi-sub dark:text-gray-400 whitespace-pre-wrap line-clamp-2 mt-0.5">{a.content}</p>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ─── 申請（有給・帰国）＋ 欠勤届 ───

type ReqFilter = 'all' | 'foreman' | 'final'

function RequestsCard({ leaveItems, absenceReports, homeLongLeaveItems, password, userRole, userForemanSites, onUpdate }: {
  leaveItems: LeaveRequestItem[]
  absenceReports: AbsenceReport[]
  homeLongLeaveItems: HomeLongLeaveItem[]
  password: string
  userRole: string  // 'admin' | 'approver' | 'foreman' | 'jimu' | 'officer'
  userForemanSites: string[]  // 職長の場合、担当現場のIDリスト
  onUpdate: () => void
}) {
  const [processing, setProcessing] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReqFilter>('all')
  // 却下は「理由を入れる → 却下する」の2段階（2026-10-02 総合点検）。
  //   旧: 承認ボタンの隣の「却下」1クリックで確定し、まとめ行なら N件が理由なしで即却下になっていた。
  //   理由は本人のスマホに表示される（休暇管理の申請タブ・職長のマイページと同じ送り方）
  const [rejecting, setRejecting] = useState<{ key: string; reason: string } | null>(null)

  // 権限制御（旧 AttendanceRequestCard と同じ）:
  //   - 職長承認: admin / approver は全件、foreman は自分の担当現場のみ
  //   - 最終承認: admin / approver のみ（事業責任者）
  //   - 却下: 承認できる人だけ（職長承認待ちは職長承認できる人、最終承認待ちは最終承認できる人）。
  //     2026-10-02 総合点検。旧: 職長承認待ちの却下ボタンが権限の無い役割にも出ていた
  const isAdminLike = userRole === 'admin' || userRole === 'approver'
  const isForeman = userRole === 'foreman'
  const canFinalApprove = isAdminLike
  const canForemanApproveFor = (siteId?: string): boolean => {
    if (isAdminLike) return true
    return isForeman && !!siteId && userForemanSites.includes(siteId)
  }

  const postOne = async (id: string, action: string, apiPath: string, wid: number, reason?: string) => fetch(apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify({
      action,
      requestId: id,
      ...(action === 'foreman_approve' ? { foremanId: wid } : action === 'reject' ? { rejectedBy: wid, reason: reason || '' } : { approvedBy: wid }),
    }),
  })

  /** 1件でも複数件でも同じ（同じ人・同じ理由の有給はまとめて1行＝まとめて処理） */
  const act = async (ids: string[], action: string, apiPath: string = '/api/leave-request', reason?: string) => {
    if (ids.length === 0) return
    setProcessing(`${action}:${ids[0]}`)
    try {
      const stored = localStorage.getItem('hibi_auth')
      const wid = (stored ? JSON.parse(stored).user?.workerId : 0) || 0
      const results = await Promise.all(ids.map(id => postOne(id, action, apiPath, wid, reason)))
      // 2026-08-27（休暇届総点検）: 失敗（出勤実績との矛盾409・ロック409・権限403等）を必ず表示する
      const failures: string[] = []
      for (const res of results) {
        if (res.ok) continue
        const err = await res.json().catch(() => null)
        failures.push(err?.message || err?.error || `処理に失敗しました (${res.status})`)
      }
      if (failures.length > 0) {
        alert(ids.length > 1
          ? `${ids.length}件中 ${failures.length}件が失敗しました:\n${[...new Set(failures)].slice(0, 4).map(f => `・${f}`).join('\n')}`
          : failures[0])
      }
      setRejecting(null)
      onUpdate()
    } catch { alert('通信エラーが発生しました') }
    finally { setProcessing(null) }
  }

  // 有給は「スタッフ + 理由」でまとめる（同じ段階の中で。理由は前後の空白を無視）
  function groupLeaves(list: LeaveRequestItem[]): LeaveRequestItem[][] {
    const groups: LeaveRequestItem[][] = []
    const idx: Record<string, number> = {}
    for (const r of list) {
      const k = `${r.workerName}_${(r.reason || '').trim()}`
      if (idx[k] === undefined) { idx[k] = groups.length; groups.push([]) }
      groups[idx[k]].push(r)
    }
    return groups
  }

  interface Row {
    key: string
    kind: 'leave' | 'home'
    stage: 'foreman' | 'final'
    name: string
    dates: string
    reason: string
    count: number
    ids: string[]
    siteId?: string
    foremanName?: string
  }
  const rows: Row[] = []
  for (const stage of ['foreman', 'final'] as const) {
    const status = stage === 'foreman' ? 'pending' : 'foreman_approved'
    for (const g of groupLeaves(leaveItems.filter(i => i.status === status))) {
      rows.push({
        key: `l_${g[0].id}`, kind: 'leave', stage, name: g[0].workerName,
        dates: g.map(r => r.date).sort().map(mdw).join('・'),
        reason: (g[0].reason || '').trim(), count: g.length, ids: g.map(r => r.id),
        siteId: g[0].siteId, foremanName: g[0].siteForemanName,
      })
    }
    for (const r of homeLongLeaveItems.filter(i => i.status === status)) {
      rows.push({
        key: `h_${r.id}`, kind: 'home', stage, name: r.workerName,
        dates: `${mdw(r.startDate)} 〜 ${mdw(r.endDate)}`, reason: r.reason || '', count: 1, ids: [r.id],
        foremanName: r.siteForemanName,
      })
    }
  }
  const foremanN = rows.filter(r => r.stage === 'foreman').length
  const finalN = rows.length - foremanN
  const shown = filter === 'all' ? rows : rows.filter(r => r.stage === filter)

  const today = todayJstIso()
  const todayAbsence = absenceReports.filter(a => a.date === today)
  const pastAbsence = absenceReports.filter(a => a.date !== today)

  const btn = 'h-9 px-3.5 rounded-[9px] text-[0.8125rem] font-bold whitespace-nowrap disabled:opacity-50'
  return (
    <Card id="requests" title="申請（有給・帰国）" right={<MoreLink href="/leave?tab=requests">休暇管理を開く</MoreLink>}>
      {rows.length > 0 && (
        <div className="px-5 py-3 flex flex-wrap items-center gap-3">
          <Segment value={filter} onChange={setFilter} items={[
            ['all', `すべて ${rows.length}`], ['foreman', `職長承認待ち ${foremanN}`], ['final', `最終承認待ち ${finalN}`],
          ]} />
          <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">同じ人・同じ理由の有給はまとめて1行</span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-hibi-sub dark:text-gray-400 flex items-center gap-2">
          <Icon name="check" size={16} className="text-green-600" />承認待ちの申請はありません
        </div>
      ) : shown.length === 0 ? (
        <div className="px-5 py-6 text-sm text-hibi-sub dark:text-gray-400">この絞り込みに当てはまる申請はありません</div>
      ) : shown.map(r => {
        const api = r.kind === 'home' ? '/api/home-long-leave' : '/api/leave-request'
        // 帰国申請には siteId が無いため、職長は「いずれかの担当現場あり」で押せる扱い（旧と同じ）
        const canForeman = r.kind === 'home' ? (isAdminLike || (isForeman && userForemanSites.length > 0)) : canForemanApproveFor(r.siteId)
        const busy = processing !== null
        const canReject = r.stage === 'foreman' ? canForeman : canFinalApprove
        const isRejecting = rejecting?.key === r.key
        return (
          <div key={r.key} className="border-t border-hibi-line dark:border-gray-700 px-5 py-3 grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)_auto] gap-2 sm:gap-3.5 items-center">
            <div className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100">{r.name}</div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={r.kind === 'home' ? 'cyan' : 'gray'}>{r.kind === 'home' ? '帰国' : '有給'}</Chip>
                <span className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100 break-words">{r.dates}</span>
                {r.count > 1 && <Chip tone="gray">{r.count}件まとめて</Chip>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {r.stage === 'foreman'
                  ? <Chip tone="amber">職長承認待ち{r.foremanName ? `（${r.foremanName}）` : ''}</Chip>
                  : <Chip tone="blue">職長承認済み・最終承認待ち</Chip>}
                {r.reason && <span className="text-xs text-hibi-sub dark:text-gray-400">{r.reason}</span>}
              </div>
            </div>
            <div className="flex gap-2 sm:justify-end">
              {r.stage === 'foreman' ? (
                canForeman && (
                  <button onClick={() => act(r.ids, 'foreman_approve', api)} disabled={busy}
                    className={`${btn} bg-hibi-navy text-white hover:bg-hibi-light`}>{r.count > 1 ? 'まとめて職長承認' : '職長承認'}</button>
                )
              ) : canFinalApprove ? (
                <button onClick={() => act(r.ids, 'approve', api)} disabled={busy}
                  className={`${btn} bg-green-700 text-white hover:bg-green-800`}>{r.count > 1 ? 'まとめて最終承認' : '最終承認'}</button>
              ) : (
                <span className="text-xs text-hibi-sub dark:text-gray-400 self-center">最終承認待ち</span>
              )}
              {canReject && !isRejecting && (
                <button onClick={() => setRejecting({ key: r.key, reason: '' })} disabled={busy}
                  className={`${btn} border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-900/20`}>却下...</button>
              )}
            </div>
            {canReject && isRejecting && (
              <div className="sm:col-span-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10 p-3 flex flex-wrap items-center gap-2">
                <label className="text-[0.8125rem] font-bold text-red-700 dark:text-red-300" htmlFor={`reject-reason-${r.key}`}>却下の理由（本人に伝わります）</label>
                <input id={`reject-reason-${r.key}`} type="text" value={rejecting.reason} autoFocus
                  onChange={e => setRejecting({ key: r.key, reason: e.target.value })}
                  placeholder="例: 現場の人数が足りない日です。別の日で申請してください"
                  className="flex-1 min-w-[220px] h-9 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm" />
                <button onClick={() => act(r.ids, 'reject', api, rejecting.reason.trim())} disabled={busy || !rejecting.reason.trim()}
                  className={`${btn} bg-red-600 text-white hover:bg-red-700`}>{r.count > 1 ? `${r.count}件を却下する` : '却下する'}</button>
                <button onClick={() => setRejecting(null)} disabled={busy}
                  className={`${btn} border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200`}>やめる</button>
              </div>
            )}
          </div>
        )
      })}
      {(todayAbsence.length > 0 || pastAbsence.length > 0) && (
        <div className="border-t border-hibi-line dark:border-gray-700 px-5 py-3 space-y-2">
          {todayAbsence.length > 0 && (
            <div>
              <div className="text-[0.8125rem] font-bold text-gray-900 dark:text-gray-100 mb-1.5">今日の欠勤届</div>
              <div className="flex flex-wrap gap-1.5">
                {todayAbsence.map((a, i) => <Chip key={i} tone="red">{a.workerName}・{a.reasonLabel}{a.note ? `（${a.note}）` : ''}</Chip>)}
              </div>
            </div>
          )}
          {pastAbsence.length > 0 && (
            <div>
              <div className="text-[0.8125rem] font-bold text-gray-900 dark:text-gray-100 mb-1">過去7日の欠勤</div>
              <ul className="text-xs text-hibi-sub dark:text-gray-400 space-y-0.5">
                {pastAbsence.map((a, i) => (
                  <li key={i}><span className="tabular-nums">{md(a.date)}</span> <b className="text-gray-700 dark:text-gray-300">{a.workerName}</b> {a.reasonLabel}{a.note ? `（${a.note}）` : ''}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ─── 気になること ───

function IssuesCard({ issues, calendarPending }: { issues: QuietIssue[]; calendarPending: number }) {
  if (issues.length === 0 && calendarPending === 0) return null
  const row = (key: string, href: string, label: string, tone: ChipTone, name: string, detail: string) => (
    <a key={key} href={href}
      className="border-t border-hibi-line dark:border-gray-700 first:border-t-0 px-5 py-3 grid grid-cols-1 sm:grid-cols-[130px_150px_minmax(0,1fr)_auto] gap-1 sm:gap-3.5 items-center hover:bg-gray-50 dark:hover:bg-gray-700/40 transition group">
      <span><Chip tone={tone}>{label}</Chip></span>
      <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{name}</span>
      <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{detail}</span>
      <Icon name="chevronRight" size={16} className="hidden sm:block text-gray-400 group-hover:text-hibi-navy dark:group-hover:text-white" />
    </a>
  )
  return (
    <Card title="気になること" sub="急がないが、締めまでに見ておくこと。配置の見直しは、移動した人なら出面入力の配置から外す">
      <div>
        {calendarPending > 0 && row('cal', '/calendar', '就業カレンダー', 'amber', `未承認 ${calendarPending}件`, '来月分の承認待ち')}
        {issues.map((it, i) => {
          const k = KIND_LABEL[it.kind] || { label: '確認', tone: 'amber' as ChipTone }
          return row(`q${i}`, it.href, k.label, k.tone, it.workerName, it.detail)
        })}
      </div>
    </Card>
  )
}

// ─── 前日の稼働 ───

function YesterdayCard({ data, siteList }: { data: DashboardData['todayStatus']; siteList: SiteOption[] }) {
  const yIso = addDaysIso(todayJstIso(), -1)
  const sites = (data?.siteStatus || []).filter(s => s.total > 0)
  const sum = (k: keyof TodaySiteStatus) => sites.reduce((s, r) => s + (r[k] as number), 0)
  return (
    <Card title="前日の稼働" sub={mdw(yIso)}>
      {sites.length === 0 ? (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-hibi-sub dark:text-gray-400">前日の出面入力がありません</p>
          <p className="text-xs text-gray-400 mt-1">出面入力画面で入力するとここに反映されます</p>
        </div>
      ) : (
        <>
          <div className="px-5 py-2 grid grid-cols-[minmax(0,1fr)_40px_40px_48px_52px] gap-2 text-xs font-bold text-hibi-sub dark:text-gray-300 bg-hibi-thead dark:bg-gray-700">
            <span>現場</span><span className="text-right">鳶</span><span className="text-right">土工</span><span className="text-right">外注</span><span className="text-right">合計</span>
          </div>
          {sites.map(s => (
            <div key={s.siteId} className="border-t border-hibi-line dark:border-gray-700 px-5 py-2 grid grid-cols-[minmax(0,1fr)_40px_40px_48px_52px] gap-2 items-center text-sm tabular-nums">
              <span className="flex items-center gap-2 font-bold text-gray-900 dark:text-gray-100 min-w-0">
                <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${siteColor(siteList.findIndex(x => x.id === s.siteId))}`} />
                <span className="truncate">{s.siteName}</span>
              </span>
              <span className="text-right">{s.tobi}</span>
              <span className="text-right">{s.doko}</span>
              <span className="text-right text-hibi-sub dark:text-gray-400">{s.subTobi + s.subDoko}</span>
              <span className="text-right font-bold text-base">{s.total}</span>
            </div>
          ))}
          <div className="border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 min-w-0">
              {(data.absentWorkers || []).length > 0 ? `休み ${data.absentWorkers.length}名：${data.absentWorkers.map(w => w.name).join('、')}` : '休みの人はいません'}
            </span>
            <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 whitespace-nowrap">合計 <b className="text-lg text-gray-900 dark:text-white tabular-nums">{fmtNum(sum('total'))}</b> 人工</span>
          </div>
        </>
      )}
    </Card>
  )
}

// ─── 今月の数字（総人工・売上・日別の稼働人数） ───

function MonthCard({ data, ym, loading, error, onPrev, onNext, canCost }: {
  data: DashboardData; ym: string; loading: boolean; error: boolean; onPrev: () => void; onNext: () => void
  /** 原価・収益を見られる人だけリンクを出す（給与の鍵・2026-10-02） */
  canCost: boolean
}) {
  // 2026-10-01: 月を切り替えた直後・取得に失敗したときに、前の月の数字が新しい月の見出しの下に出ていた。
  //   数字は「応答の月（selectedYm）＝ 選んでいる月」のときだけ出し、それ以外は読み込み中／失敗を出す
  const ready = data.selectedYm === ym
  const s = ready ? data.summary : null
  const days = ready ? (data.dailyAttendance || []) : []
  const maxDaily = Math.max(1, ...days.map(d => d.sites.reduce((a, st) => a + st.count, 0)))
  return (
    <Card title="今月の数字" sub={`${ym.slice(0, 4)}年${Number(ym.slice(4, 6))}月`} right={
      <div className="flex items-center h-9 rounded-[9px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
        <button onClick={onPrev} aria-label="前の月" className="w-8 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[9px]"><Icon name="chevronLeft" size={16} strokeWidth={2.2} /></button>
        <span className="px-1 text-[0.8125rem] font-bold tabular-nums">{Number(ym.slice(4, 6))}月</span>
        <button onClick={onNext} aria-label="次の月" className="w-8 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[9px]"><Icon name="chevronRight" size={16} strokeWidth={2.2} /></button>
      </div>
    }>
      {!ready && (
        <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">
          {loading || !error ? '読み込み中...' : 'この月の数字を取得できませんでした'}
        </div>
      )}
      {s && (
        <div className="px-5 pt-4 pb-3 grid grid-cols-2 gap-4">
          <div>
            <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">総人工</div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl leading-tight font-bold tabular-nums text-gray-900 dark:text-white">{fmtNum(s.totalManDays)}</span>
              <span className="text-sm text-hibi-sub dark:text-gray-400">人工</span>
            </div>
            {s.prevTotalManDays > 0 && s.pctWork !== 0 && (
              <span title={ym === currentYmJst() ? '前月の同じ日までとの比較' : '前月1か月との比較'}><Chip tone={s.pctWork > 0 ? 'green' : 'red'}>前月より {s.pctWork > 0 ? '+' : '−'}{Math.abs(Math.round(s.pctWork))}%</Chip></span>
            )}
          </div>
          <div>
            <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{s.billing > 0 ? '売上' : '売上（概算）'}</div>
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl leading-tight font-bold tabular-nums ${s.billing === 0 ? 'text-gray-400' : 'text-gray-900 dark:text-white'}`}>
                {s.billing === 0 ? '未入力' : fmtYenMan(s.billing)}
              </span>
              {/* fmtYenMan は「¥2,719万」まで返すので、足すのは「円」だけ（旧は「万円」で万が二重だった） */}
              {s.billing > 0 && <span className="text-sm text-hibi-sub dark:text-gray-400">円</span>}
            </div>
            {canCost && <MoreLink href="/cost">原価・収益へ</MoreLink>}
          </div>
        </div>
      )}
      {days.length > 0 && (
        <div className="px-5 pb-4">
          <div className="text-xs text-hibi-sub dark:text-gray-400 mb-1.5">日別の稼働人数（現場ごと）</div>
          <div className="flex items-end gap-[2px] h-[120px] border-b border-hibi-line dark:border-gray-700">
            {days.map(da => {
              const total = da.sites.reduce((a, st) => a + st.count, 0)
              return (
                <div key={da.day} className="flex-1 min-w-0 h-full flex flex-col justify-end" title={`${da.day}日 ${total}名`}>
                  {da.sites.map(st => (
                    <div key={st.siteId} className={`w-full ${siteColor(data.siteList.findIndex(x => x.id === st.siteId))}`}
                      style={{ height: `${(st.count / maxDaily) * 112}px` }} title={`${da.day}日 ${st.siteName}: ${st.count}名`} />
                  ))}
                </div>
              )
            })}
          </div>
          <div className="flex justify-between text-2xs text-hibi-sub dark:text-gray-400 mt-1 tabular-nums">
            <span>1</span><span>10</span><span>20</span><span>{days.length}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-hibi-sub dark:text-gray-400">
            {data.siteList.map((st, i) => (
              <span key={st.id} className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-sm ${siteColor(i)}`} />{st.name}</span>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Main ───

export default function DashboardPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState<string>('')
  const [userForemanSites, setUserForemanSites] = useState<string[]>([])
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [ym, setYm] = useState(currentYmJst)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  // 「給与の検算」「就業カレンダー」の件数（サイドバーのバッジと同じ）
  const [actionBadges, setActionBadges] = useState<{ monthly: number; calendar: number; leave: number } | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw, user } = JSON.parse(stored)
      setPassword(pw)
      setUserRole(user?.role || '')
      setUserForemanSites(user?.foremanSites || [])
      if (user) setAuthUser(user as AuthUser)
    }
  }, [])

  // 月を素早く切り替えたとき、古い月の応答が後から届いて上書きしないよう、前の取得は取り消す（2026-10-01）
  const abortRef = useRef<AbortController | null>(null)
  const fetchData = useCallback(async () => {
    if (!password) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ ym, period: 'month', site: 'all' })
      const res = await fetch(`/api/dashboard?${params}`, {
        headers: { 'x-admin-password': password },
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      if (!res.ok) { setError('データの取得に失敗しました'); return }
      const json = await res.json()
      if (ctrl.signal.aborted || json?.selectedYm !== ym) return  // 別の月の応答は捨てる
      setData(json)
    } catch {
      if (ctrl.signal.aborted) return
      setError('通信エラーが発生しました')
    } finally {
      if (abortRef.current === ctrl) setLoading(false)
    }
  }, [password, ym])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => () => abortRef.current?.abort(), [])

  // サイドバーと同じ件数 → 同じ取得を共有する（API を2本同時に走らせない・2026-10-01）
  useEffect(() => {
    if (!password) return
    fetchSidebarBadges(password).then(b => { if (b) setActionBadges(b) })
  }, [password])

  const navigateMonth = (direction: -1 | 1) => {
    const y = parseInt(ym.slice(0, 4))
    const m = parseInt(ym.slice(4, 6))
    const d = new Date(y, m - 1 + direction, 1)
    setYm(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const today = todayJstIso()
  const ai = data?.actionItems
  const leaveItems = ai?.pendingLeaveRequests?.items || []
  const homeItems = ai?.homeLongLeaveRequests || []
  const reqN = leaveItems.length + homeItems.length
  const reqForemanN = leaveItems.filter(i => i.status === 'pending').length + homeItems.filter(i => i.status === 'pending').length
  const monthlyN = actionBadges?.monthly || 0
  const visa = ai?.visaExpiry
  const pl = ai?.plShortfall
  const scrollToRequests = () => document.getElementById('requests')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader group={`${today.slice(0, 4)}年${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日（${DOW[new Date(`${today}T00:00:00`).getDay()]}）`} title="ダッシュボード" />

      {error && <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{error}</div>}

      {/* ① 今やること */}
      {data && (
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <TodoCard
            icon="check" tone={reqN > 0 ? 'urgent' : 'ok'}
            title="承認待ち"
            big={reqN > 0 ? `${reqN}件` : 'ありません'}
            sub={reqN > 0
              ? `有給 ${leaveItems.length}件・帰国 ${homeItems.length}件（職長承認待ち ${reqForemanN}・最終承認待ち ${reqN - reqForemanN}）`
              : '有給・帰国の申請が来るとここに出ます'}
            action={reqN > 0 ? '申請を見る' : undefined}
            onClick={reqN > 0 ? scrollToRequests : undefined}
          />
          {/* 月次集計を開ける人（monthly.view＝給与を見られる3人）にだけ出す（2026-10-02 総合点検。
              旧: 役員・ほかの事務にも「月次集計を開く」が出て、押すと「この画面は見られません」になっていた） */}
          {can(authUser, 'monthly.view') && (
            <TodoCard
              icon="chart" tone={monthlyN > 0 ? 'urgent' : 'ok'}
              title="給与の検算"
              big={monthlyN > 0 ? `要確認 ${monthlyN}名` : 'いまは問題なし'}
              sub={monthlyN > 0 ? '自動検算で異常が見つかった人がいます。締める前に計算根拠を確認' : '自動検算で異常が出たらここに出ます'}
              action={monthlyN > 0 ? '月次集計を開く' : undefined}
              onClick={monthlyN > 0 ? () => router.push('/monthly') : undefined}
            />
          )}
          <TodoCard
            icon="clock" tone={(visa?.count || 0) > 0 ? 'warn' : 'ok'}
            title="在留期限"
            big={(visa?.count || 0) > 0 ? `期限が近い人 ${visa!.count}名` : 'いまは問題なし'}
            sub={(visa?.count || 0) > 0
              ? `${visa!.items.slice(0, 3).map(v => `${v.name}（あと${v.daysLeft}日）`).join('、')}${visa!.count > 3 ? ` ほか${visa!.count - 3}名` : ''}`
              : '期限が近い人が出たらここに出ます'}
            action={(visa?.count || 0) > 0 ? '人員マスタを開く' : undefined}
            onClick={(visa?.count || 0) > 0 ? () => router.push('/workers') : undefined}
          />
          <TodoCard
            icon="umbrella" tone={(pl?.count || 0) > 0 ? 'urgent' : 'ok'}
            title="年5日の取得義務"
            big={(pl?.count || 0) > 0 ? `未達 ${pl!.count}名` : 'いまは問題なし'}
            sub={(pl?.count || 0) > 0
              ? `${(pl!.names || []).slice(0, 3).join('、')}${pl!.count > 3 ? ` ほか${pl!.count - 3}名` : ''}`
              : '期限が近づいて未達の人が出たらここに出ます'}
            action={(pl?.count || 0) > 0 ? '休暇管理を開く' : undefined}
            onClick={(pl?.count || 0) > 0 ? () => router.push('/leave') : undefined}
          />
        </section>
      )}

      {/* お知らせ・評価は本体（/api/dashboard）を待たずに最初から出す（2026-10-01 高速化。旧: 本体の応答後に取得が始まっていた） */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4 items-start">
        {/* ② 左: やること */}
        <div className="space-y-4 min-w-0">
          {data ? (
            <>
              <RequestsCard
                leaveItems={leaveItems}
                absenceReports={ai?.absenceReports || []}
                homeLongLeaveItems={homeItems}
                password={password}
                userRole={userRole}
                userForemanSites={userForemanSites}
                onUpdate={fetchData}
              />
              <IssuesCard issues={ai?.quietIssues?.items || []} calendarPending={actionBadges?.calendar || 0} />
            </>
          ) : loading ? (
            <div className="text-center py-12 text-gray-400">読み込み中...</div>
          ) : null}
        </div>
        {/* ③ 右: 数字を見るもの */}
        <div className="space-y-4 min-w-0">
          {data && (
            <>
              <YesterdayCard data={data.todayStatus} siteList={data.siteList || []} />
              <MonthCard data={data} ym={ym} loading={loading} error={!!error} onPrev={() => navigateMonth(-1)} onNext={() => navigateMonth(1)} canCost={can(authUser, 'cost.view')} />
            </>
          )}
          <AnnouncementsCard password={password} />
          {authUser && <EvaluationCard user={authUser} />}
        </div>
      </div>
    </div>
  )
}
