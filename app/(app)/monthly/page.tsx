'use client'
// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: 飾りの絵文字を外した（線のアイコンか文字に）

import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { fmtYen, fmtNum, fmtPct } from '@/lib/format'
import { confirmDialog, confirmWithReason } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import PayrollAuditModal from '@/components/monthly/PayrollAuditModal'
import { validatePayrolls, type PayrollSnapshot, type PayrollValidationIssue } from '@/lib/payroll-validator'
import { summarizeOpenIssues, type PayNoteAck } from '@/lib/pay-note-ack'
import StaffConfirmBadge, { type StaffConfirmInfo } from './components/StaffConfirmBadge'
import ConfirmReminder from './components/ConfirmReminder'
import { can } from '@/lib/permissions'
import { postJson } from '@/lib/api-client'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { Icon, type IconName } from '@/components/ui/Icon'
import { UnderlineTabs, ToolButton, Segment, SearchBox, RowButton } from '@/components/ui/PageParts'
import { CloseCard, OverviewList, needsAttention, type ApprovalStatus } from './components/MonthlyOverview'

// ────────────────────────────────────────
//  Types
// ────────────────────────────────────────

interface WorkerMonthly {
  id: number
  name: string
  org: string
  visa: string
  job: string
  rate: number
  hourlyRate?: number
  otMul: number
  salary?: number
  sites: string[]
  workDays: number
  actualWorkDays: number
  compDays: number
  workAll: number
  halfDays?: number
  otHours: number
  plDays: number
  plUsed: number
  restDays: number
  siteOffDays: number
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  // Salary calc fields (variable working hours system)
  hkDays?: number
  hkEarlyReturnDays?: number
  hkEarlyReturnFirstDate?: string  // 帰国中（一時帰国・復帰未定）日数。所定から除外され無給・非欠勤
  prescribedHours?: number
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  compBaseDeduction?: number  // 補償日 通常分控除（旧ルール固定給・会社都合休）
  salaryNetPay?: number
  // 3層構造 fields
  fixedBasePay?: number
  additionalAllowance?: number
  legalLimit?: number
  // 有給手当（日本人=日給×有給日数）／有給日給（ベトナム人=20日枠超×時給×7h）
  paidLeaveDays?: number
  paidLeaveAllowance?: number
  // 2026-06-XX 追加: 所定外労働手当（法定内・割増なし、新ルール時のみ）
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  // 法令準拠の詳細支給項目（5月以降）
  legalHolidayHours?: number
  legalHolidayAllowance?: number
  nightHours?: number
  nightAllowance?: number
  // 遠方現場日当・運転手当（2026-10 施行。支給額合計には加算済み、ここは内訳表示用）
  breakShortenHours?: number
  breakShortenAllowance?: number
  siteAllowance?: number
  allowanceDays?: number
  driveAllowance?: number
  driveLegs?: number
  // 夜勤（2026-08）: 人工は workDays と分離して持つ。詳細は lib/compute.ts の WorkerMonthly
  manDays?: number
  nightShiftDays?: number
  nightManDays?: number
  nightShiftHours?: number
  legalRequiredPay?: number
  nightShiftPaid?: number
  legalShortfall?: number
  sundayNoRestDays?: number[]
  lateNightRiskDays?: number
  guaranteeDays?: number
  calendarBlankDays?: number
  /** 「その他」の休みでメモが会社都合を指している日（0.6補の選び間違いの疑い） */
  suspectCompRestDays?: number[]
  restMismatchDays?: number[]
  compAllowance?: number
  regularWorkDays?: number
  // 出向情報
  isDispatched?: boolean
  dispatchTo?: string
  dispatchDeduction?: number
  // 旧ルール継続フラグ
  useOldRules?: boolean
  workerPrescribedDays?: number
}

interface SubconMonthly {
  id: string
  name: string
  type: string
  rate: number
  otRate: number
  sites: string[]
  workDays: number
  otCount: number
  cost: number
}

// ────────────────────────────────────────
//  Export Types & Cards
// ────────────────────────────────────────

// 2026-09-17 帳票整理（代表指示）: 帳票の出口を「帳票出力」タブの1か所にまとめた。
//   旧: 集計タブ上部の「月次集計Excel」ボタン／集計タブ内の「キャシュモ提出」セクション／
//       帳票出力タブのカード（日比・HFU出面一覧を含む）と、同じ帳票が3か所から出せていた。
//   新: 帳票出力タブに「キャシュモ提出（毎月の2点）」「根拠書類」「社内用」の3グループ。
//       会社別の帳票（出面一覧・勤務予定シフト・実労働時間明細・月次集計Excel・計算根拠PDF）は
//       上2グループの会社別の行から出す。ここ（カード）は社内用だけ。対象月はタブ上部で1つ選ぶ
type ExportType = 'monthlyExcel' | 'perSite' | 'subcon' | 'bukake' | 'pl' | 'consentLedger'

interface ExportCard {
  icon: IconName
  title: string
  description: string
  format: 'Excel出力' | 'PDF出力'
  type: ExportType
  needsYm: boolean
  needsOrg?: boolean
}

const EXPORT_CARDS: ExportCard[] = [
  {
    icon: 'chart',
    title: '月次集計 Excel（全社・外注込み）',
    description: '日比建設・HFU・協力業者を1冊にまとめた社内用。キャシュモに送る会社別のものは上の「キャシュモ提出」から。',
    format: 'Excel出力',
    type: 'monthlyExcel',
    needsYm: true,
  },
  {
    icon: 'site',
    title: '現場別 出面一覧',
    description: '現場ごとにシートを分け、日比建設・HFUのセクション別で出面データを出力します。社内の原価確認用。',
    format: 'Excel出力',
    type: 'perSite',
    needsYm: true,
  },
  {
    icon: 'doc',
    title: '外注先向け 出面確認書',
    description: '外注先ごとの出面確認書をExcel形式で出力します。外注先への送付・確認用です。',
    format: 'Excel出力',
    type: 'subcon',
    needsYm: true,
  },
  {
    icon: 'trend',
    title: '歩掛管理表',
    description: '現場別の歩掛（人工数・鳶換算）をExcel形式で出力します。原価管理・見積もりに活用できます。',
    format: 'Excel出力',
    type: 'bukake',
    needsYm: true,
  },
  {
    icon: 'umbrella',
    title: '有給管理台帳',
    description: '年次有給休暇管理簿（一覧表＋1人1枚の個人票）。会社別に出力。日本人だけ・ベトナム人だけ・全期間は「休暇管理 → 管理簿（Excel）」から。',
    format: 'Excel出力',
    type: 'pl',
    needsYm: false,
    needsOrg: true,
  },
  // 2026-09-26: 帳票はすべてここから（就業カレンダー画面の下にも同じボタンあり）
  {
    icon: 'pen',
    title: 'カレンダー 周知・同意台帳',
    description: '変形労働時間制の周知・同意の記録（誰がいつどの現場のカレンダーを承認したか）。労基署対応用。過去の月もいつでも出力できます。',
    format: 'Excel出力',
    type: 'consentLedger',
    needsYm: true,
  },
]

type TopTab = 'summary' | 'export'

interface MonthlyData {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  locked: boolean
  lockedHibi: boolean
  lockedHfu: boolean
  workDays: number
  prescribedDays?: number
  baseDays?: number
  hasOldRulesWorkers?: boolean
  // 2026-06-12 (監査 Sprint2-D): 締め後に支給額が変わった場合の差分情報
  snapshotDiffs?: {
    org: string
    lockedAt?: string
    count: number
    items: { id: number; name: string; snapshot: number; current: number }[]
  }[]
  hasCalendarData?: boolean
  siteWorkDays?: Record<string, number>
  siteNames?: Record<string, string>
  /** 締め前の会社の出面の承認状況（締めと同じ判定・2026-10-02）。締め済みの会社は入らない */
  approvalStatus?: Partial<Record<'hibi' | 'hfu', ApprovalStatus>>
  totals: {
    workDays: number
    subWorkDays: number
    cost: number
    subCost: number
    billing: number
    profit: number
    otHours: number
  }
}

// ────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────

const ORG_LABELS: Record<string, string> = { hibi: '日比建設', hfu: 'HFU' }
const TYPE_LABELS: Record<string, string> = { tobi: 'とび', doko: '土工' }

function getYmOptions(count: number): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    result.push({
      ym: `${y}${String(m).padStart(2, '0')}`,
      label: `${y}年${m}月`,
    })
  }
  return result
}

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 前月（＝ふつう締める月）。開いたときはこの月を出す（2026-10-01: 旧は今月＝途中の月が出ていた） */
function prevYm(): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 表示用の「時間外労働(h)」を返す。
// - 新ルール（変形労働）ベトナム人: 所定外労働時間（=所定を超えた実体の時間。法定内+法定外を含む）
//   ※ 生の o 欄合計(otHours)は、st/et 入力月では実態とズレるため使わない
//   ※ 法定外残業(legalOtHours)は所定外の「内数」（同じ時間に割増が付くだけ）なので合算しない。
//     旧実装は 所定外+法定外 を足しており、例: 22.5h+5.1h=27.6h という実体のない数字が
//     表示されて Excel（所定外/法定外を別列表示）と突合できなかった（2026-07 奥寺さん指摘②）。
//     予定外の休日出勤等で「所定外0だが法定外あり」になるケースがあるため max を取る。
// - 日本人(日額制) / 旧ルール: 従来どおり出面の残業欄合計(otHours)
type OtDisplayable = { useOldRules?: boolean; otHours: number; nonStatutoryOTHours?: number; legalOtHours?: number }
function displayOtHours(w: OtDisplayable): number {
  if (w.useOldRules) return w.otHours
  if (w.nonStatutoryOTHours !== undefined || w.legalOtHours !== undefined) {
    return Math.round(Math.max(w.nonStatutoryOTHours || 0, w.legalOtHours || 0) * 10) / 10
  }
  return w.otHours
}

// 「うち法定外(割増対象)」— displayOtHours の内数として添えて表示する
function displayLegalOtHours(w: OtDisplayable): number {
  if (w.useOldRules) return 0
  return Math.round((w.legalOtHours || 0) * 10) / 10
}

type WorkerSortKey = 'name' | 'org' | 'workDays' | 'plDays' | 'otHours' | 'rate' | 'totalCost'

// ────────────────────────────────────────
//  Tabs
// ────────────────────────────────────────

const TABS = [
  { key: 'all', label: '全体' },
  { key: 'hibi', label: '日比建設' },
  { key: 'hfu', label: 'HFU' },
] as const

type TabKey = typeof TABS[number]['key']

// ────────────────────────────────────────
//  Component
// ────────────────────────────────────────

/** 本人確認の対象で、まだ確認ずみでない人（一覧の「本人確認まだ」の絞り込み・締めで一覧に出る人と同じ）。
 *  状態はサーバ（lib/attendance-confirm-server.ts staffConfirmRows）が月締めと同じ判定で決める（2026-10-02 一本化） */
function isConfirmPending(c: StaffConfirmInfo | undefined): boolean {
  return !!c && c.state !== 'ok'
}

export default function MonthlyPage() {
  // useSearchParams を使うため Suspense で包む（Next.js の静的生成の決まり）
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中…</div>}>
      <MonthlyPageInner />
    </Suspense>
  )
}

function MonthlyPageInner() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(prevYm)
  // 一覧の見せ方（2026-10-01）: list=見やすい一覧（1人1行・0円でない内訳だけ） / table=全項目の表（Excel と突き合わせる用）
  const [view, setView] = useState<'list' | 'table'>('list')
  const [listFilter, setListFilter] = useState<'all' | 'attention' | 'unconfirmed'>('all')
  const [listQuery, setListQuery] = useState('')
  const [tab, setTab] = useState<TabKey>('all')
  // 2026-06-XX 追加 (UI #3): 自動検算で違反のあったスタッフだけ絞り込むフィルタ
  const [showAnomalyOnly, setShowAnomalyOnly] = useState(false)
  const [data, setData] = useState<MonthlyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lockToggling, setLockToggling] = useState(false)

  // 所定日数
  const [prescribedDays, setPrescribedDays] = useState<string>('')

  // 2026-06-XX 追加: 旧ルール想定の「日曜以外の日数」を月から自動算出
  //   旧ルール (フン等) の所定日数は「原則 日曜のみ休み」が基準。
  //   例: 5月 = 31日 − 日曜5日 = 26日 (基準値)。GW/夏季/年末年始 などは
  //   ユーザーが手動で減算する想定。
  //   未設定月のフォールバック値および UI ヒント表示に使用。
  const calcDefaultPrescribedDays = useCallback((ymStr: string): number => {
    if (!ymStr || !/^\d{6}$/.test(ymStr)) return 0
    const y = parseInt(ymStr.slice(0, 4))
    const m = parseInt(ymStr.slice(4, 6))
    const daysInMonth = new Date(y, m, 0).getDate()
    let sundays = 0
    for (let d = 1; d <= daysInMonth; d++) {
      if (new Date(y, m - 1, d).getDay() === 0) sundays++
    }
    return daysInMonth - sundays
  }, [])
  // 計算根拠モーダル用
  const [auditingWorker, setAuditingWorker] = useState<WorkerMonthly | null>(null)
  const [savingWorkDays, setSavingWorkDays] = useState(false)

  // Top-level tab
  const [topTab, setTopTab] = useState<TopTab>('summary')
  // サイドメニュー「帳票出力」・メニュー検索から ?tab=export で直接開く（2026-09-26）。
  //   メニューの切り替えは同じ画面の中なので、URL が変わるたびに合わせる
  const tabParam = useSearchParams().get('tab')
  // 通知ベルから ?ym=YYYYMM で月を指定して開く（本人からの連絡・2026-09-30）
  const ymParam = useSearchParams().get('ym')
  useEffect(() => { if (ymParam && /^\d{6}$/.test(ymParam)) setYm(ymParam) }, [ymParam])
  // 月次集計 ↔ 帳票出力 の切り替えは URL の ?tab= にも書く（2026-09-28）。
  //   旧: 画面の中だけで切り替わり、サイドメニューの選択表示が逆の項目を指したままだった
  const switchTopTab = useCallback((t: TopTab) => {
    setTopTab(t)
    try {
      const u = new URL(window.location.href)
      if (t === 'export') u.searchParams.set('tab', 'export'); else u.searchParams.delete('tab')
      window.history.replaceState(null, '', `${u.pathname}${u.search}`)
      window.dispatchEvent(new Event('hibi:urlchange'))
    } catch { /* 表示だけの話なので失敗しても続ける */ }
  }, [])

  useEffect(() => {
    setTopTab(tabParam === 'export' ? 'export' : 'summary')
  }, [tabParam])
  // Export states（対象月は集計と共通の ym を使う。2026-09-17: カードごとの月選択を廃止）
  const [exportDownloading, setExportDownloading] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [exportSelectedOrg, setExportSelectedOrg] = useState<Record<string, string>>({ pl: 'all' })

  // Worker sort
  const [workerSortKey, setWorkerSortKey] = useState<WorkerSortKey>('name')
  const [workerSortAsc, setWorkerSortAsc] = useState(true)

  // Subcon sort

  const ymOptions = useMemo(() => getYmOptions(12), [])

  // Read auth
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw, user } = JSON.parse(stored)
        setPassword(pw)
        setCanResolveConfirm(can(user, 'monthly.close'))
      } catch { /* ignore */ }
    }
  }, [])

  const autoMonthDone = useRef(false)

  // Fetch data
  // 月を素早く切り替えたとき、前の月の応答があとから届いて上書きしない（lib/hooks/useLatestRequest・2026-10-02 総合点検）。
  //   旧: 締めは data.lockedHibi と state の ym を組み合わせて送るので、表示と操作対象がずれ得た
  const latest = useLatestRequest()
  const fetchData = useCallback(async () => {
    if (!password || !ym) return
    const req = latest.begin()
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/monthly?ym=${ym}`, {
        headers: { 'x-admin-password': password },
        signal: req.signal,
      })
      if (!req.isCurrent()) return
      if (!res.ok) {
        const msg = await res.text()
        setError(msg || 'データ取得に失敗しました')
        setData(null)
        return
      }
      const json: MonthlyData = await res.json()
      if (!req.isCurrent()) return
      // 前月を開いたが、もう両社とも締め済みなら今月へ（「締める月」を出す・最初の1回だけ）
      if (!autoMonthDone.current) {
        autoMonthDone.current = true
        if (!ymParam && ym === prevYm() && json.lockedHibi && json.lockedHfu) {
          setYm(currentYm())
          return
        }
      }
      setData(json)
      // 2026-06-XX: 未設定 (0/null) 月は「日曜以外の日数」を自動初期値に
      //   旧ルール継続者の所定日数は通常この値が基準（特別休暇分を手動で減算）
      const defaultDays = calcDefaultPrescribedDays(ym)
      setPrescribedDays(json.workDays ? String(json.workDays) : String(defaultDays))
    } catch (e) {
      if (latest.isAbort(e) || !req.isCurrent()) return  // 自分で止めた古い読み込み
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      if (req.isCurrent()) setLoading(false)
    }
  }, [password, ym, calcDefaultPrescribedDays, ymParam, latest])

  useEffect(() => { fetchData() }, [fetchData])

  // 月末の本人確認（スタッフがスマホで「正しい／まちがいがある」を押した記録・2026-09-30）
  const [staffConfirms, setStaffConfirms] = useState<Record<number, StaffConfirmInfo>>({})
  // 本人確認の取得に失敗した（2026-10-02 総合点検。旧: 失敗すると締めカードに「対象の人がいません」と出ていた）
  const [staffConfirmsFailed, setStaffConfirmsFailed] = useState(false)
  const [confirmsVersion, setConfirmsVersion] = useState(0)
  // 本人からの連絡を「対応済み」にできる人（月締めと同じ monthly.close）
  const [canResolveConfirm, setCanResolveConfirm] = useState(false)
  useEffect(() => {
    if (!password || !ym) return
    let alive = true
    fetch(`/api/attendance/confirm?ym=${ym}`, { headers: { 'x-admin-password': password } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((j: { items?: (StaffConfirmInfo & { workerId: number })[] }) => {
        if (!alive) return
        const m: Record<number, StaffConfirmInfo> = {}
        for (const it of j.items || []) m[it.workerId] = it
        setStaffConfirms(m)
        setStaffConfirmsFailed(false)
      })
      .catch(() => { if (alive) { setStaffConfirms({}); setStaffConfirmsFailed(true) } })
    return () => { alive = false }
  }, [password, ym, confirmsVersion])

  // 給与チェックの注意点の「確認した」記録（2026-10-05・lib/pay-note-ack.ts）。未確認だけを帯・件数・締めの前の確認に出す
  const [noteAcks, setNoteAcks] = useState<PayNoteAck[]>([])
  const [noteAcksVersion, setNoteAcksVersion] = useState(0)
  const [ackBusy, setAckBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!password || !ym) return
    let alive = true
    fetch(`/api/monthly/note-ack?ym=${ym}`, { headers: { 'x-admin-password': password } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((j: { acks?: PayNoteAck[] }) => { if (alive) setNoteAcks(j.acks || []) })
      // 読めなかったときは「確認なし」として全部を未確認で出す（安全側）
      .catch(() => { if (alive) setNoteAcks([]) })
    return () => { alive = false }
  }, [password, ym, noteAcksVersion])

  /** 注意点を確認済みにする（メモは任意）／確認を取り消す */
  const ackNote = useCallback(async (iss: PayrollValidationIssue) => {
    const note = await confirmWithReason({
      title: `${iss.workerName} さんのこの注意点を「確認した」にしますか？`,
      description: `${iss.message}\n\n確認済みにすると、帯とメニューの件数から外れます（「確認済み」の欄に残ります）。金額や日数が変わると、もう一度ここに出ます。`,
      confirmLabel: '確認した',
      reason: { label: 'メモ（任意）', placeholder: '例: 金額が小さいのでこのまま／代表に確認済み', required: false },
    })
    if (note === null) return
    const key = `${iss.workerId}|${iss.field}`
    setAckBusy(key)
    try {
      const res = await fetch('/api/monthly/note-ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'ack', ym, workerId: iss.workerId, code: iss.field, message: iss.message, note }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        notify.failed('確認の記録', j?.error || 'サーバが受け付けませんでした')
        return
      }
      setNoteAcksVersion(v => v + 1)
    } catch (e) {
      notify.failed('確認の記録', e)
    } finally {
      setAckBusy(null)
    }
  }, [password, ym])
  const unackNote = useCallback(async (iss: PayrollValidationIssue) => {
    if (!(await confirmDialog({
      title: `${iss.workerName} さんの注意点の確認を取り消しますか？`,
      description: '取り消すと、未確認として帯と件数に戻ります。',
      confirmLabel: '確認を取り消す',
    }))) return
    const key = `${iss.workerId}|${iss.field}`
    setAckBusy(key)
    try {
      const res = await fetch('/api/monthly/note-ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'unack', ym, workerId: iss.workerId, code: iss.field }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        notify.failed('確認の取り消し', j?.error || 'サーバが受け付けませんでした')
        return
      }
      setNoteAcksVersion(v => v + 1)
    } catch (e) {
      notify.failed('確認の取り消し', e)
    } finally {
      setAckBusy(null)
    }
  }, [password, ym])

  // ── Lock toggle ──

  const handleToggleLock = useCallback(async (org: 'hibi' | 'hfu') => {
    if (!password || !data) return
    const isCurrentlyLocked = org === 'hibi' ? data.lockedHibi : data.lockedHfu
    const newLocked = !isCurrentlyLocked
    const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
    const actionLabel = newLocked ? '月締め' : '月締めの解除'
    const ok = newLocked
      ? await confirmDialog({
          title: `${ym} の${orgLabel}を月締めしますか？`,
          description: '締めると、この月の出面と給与は直せなくなります。職長承認と政仁さんの最終承認がそろっていることを確かめてください。',
          confirmLabel: '締める',
        })
      : await confirmDialog({
          title: `${ym} の${orgLabel}の月締めを解除しますか？`,
          description: '解除すると、この月の出面と給与をまた直せるようになります。直し終わったらもう一度締めてください。',
          confirmLabel: '解除する',
        })
    if (!ok) return
    setLockToggling(true)
    try {
      const post = (extra: Record<string, unknown> = {}) => fetch('/api/monthly/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ ym, locked: newLocked, org, ...extra }),
      })
      // 締めの前の確認（承知のうえでだけ締める）。サーバが順に返すので、1つずつ聞いて旗を足して送り直す:
      //   PAY_NOTES_UNACKED   給与チェックの注意点で「確認した」が付いていないもの（2026-10-05）
      //   STAFF_CONFIRM_PENDING 本人確認（ベトナム人スタッフのスマホ）が残っている（2026-09-30）
      const flags: Record<string, boolean> = {}
      let res = await post()
      for (let i = 0; i < 2 && res.status === 409; i++) {
        const j = await res.clone().json().catch(() => null) as {
          code?: string
          pending?: { name: string; state: string; note?: string }[]
          notes?: { name: string; message: string }[]
        } | null
        if (j?.code === 'PAY_NOTES_UNACKED' && j.notes && !flags.allowUnackedNotes) {
          const list = j.notes.slice(0, 8).map(n => `・${n.name}: ${n.message.length > 90 ? `${n.message.slice(0, 90)}…` : n.message}`).join('\n')
          const more = j.notes.length > 8 ? `\n…他 ${j.notes.length - 8}件` : ''
          if (!(await confirmDialog({
            title: `給与チェックの注意点で、確認していないものが ${j.notes.length}件 あります。それでも締めますか？`,
            description: `${list}${more}\n\n`
              + '「やめる」で戻り、注意点の「確認した」を押してから締めると記録が残ります。\n'
              + 'このまま締めると、締めた人と確認していない注意点が記録に残ります。',
            confirmLabel: 'それでも締める',
          }))) return
          flags.allowUnackedNotes = true
          res = await post(flags)
        } else if (j?.code === 'STAFF_CONFIRM_PENDING' && j.pending && !flags.allowUnconfirmed) {
          const list = j.pending.slice(0, 15).map(p => `・${p.name}: ${p.state}${p.note ? `「${p.note}」` : ''}`).join('\n')
          const more = j.pending.length > 15 ? `\n…他 ${j.pending.length - 15}名` : ''
          if (!(await confirmDialog({
            title: `本人の出面確認が済んでいないスタッフが ${j.pending.length}名 います。それでも締めますか？`,
            description: `${list}${more}\n\n`
              + '連絡があった人は出面を見直してください。確認は、その月の職長承認と最終承認がそろうとスマホに出ます。\n'
              + '締めると、締めた人と確認が済んでいない人の名前が記録に残ります。',
            confirmLabel: 'それでも締める',
          }))) return
          flags.allowUnconfirmed = true
          res = await post(flags)
        } else break
      }
      // 2026-06-13: 締め前チェック（月未了・職長未承認）の 409 メッセージを表示
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        notify.failed(actionLabel, err?.error || 'サーバが受け付けませんでした')
        return
      }
      fetchData()
    } catch (e) {
      notify.failed(actionLabel, e)
    } finally {
      setLockToggling(false)
    }
  }, [password, data, ym, fetchData])

  // ── 所定日数の保存 ──

  const handleSaveWorkDays = useCallback(async () => {
    if (!password) return
    setSavingWorkDays(true)
    try {
      // 2026-10-02 総合点検: 断られたとき（締め済みの月の 409 など）に理由を出す。旧: 応答を見ておらず、
      //   保存できていないのに何も出ず、再取得で元の値に戻るだけだった
      const res = await postJson('/api/monthly', { action: 'setWorkDays', ym, value: Number(prescribedDays) || 0 }, { password })
      if (!res.ok) {
        notify.failed('所定日数を保存', res.error || 'サーバが受け付けませんでした')
        return
      }
      fetchData()
    } finally {
      setSavingWorkDays(false)
    }
  }, [password, ym, prescribedDays, fetchData])

  // 「前月コピー」（前月の出面を丸ごと当月へ写す保守用のボタン）は 2026-10-02 総合点検で画面から外した。
  //   出面は本人・職長の入力と承認で積み上げるものなので、締めの画面に置く理由が無く、
  //   森田さんマニュアルも「押さないで」と書いていた。サーバ側の copyPrevMonth も廃止

  // ── Export download handler ──

  const handleExportDownload = useCallback(async (card: ExportCard) => {
    if (!password) {
      setExportError('管理者パスワードが設定されていません')
      return
    }

    const eym = ym
    if (card.needsYm && !eym) {
      setExportError('対象月を選択してください')
      return
    }

    setExportError('')
    setExportDownloading(card.type)

    try {
      {
        const params = new URLSearchParams({ type: card.type })
        if (card.needsYm && eym) params.set('ym', eym)
        if (card.needsOrg) params.set('org', exportSelectedOrg[card.type] || 'all')
        if (card.type === 'monthlyExcel') params.set('org', 'all')

        const res = await fetch(`/api/export?${params}`, {
          headers: { 'x-admin-password': password },
        })

        if (!res.ok) {
          const errText = await res.text()
          setExportError(errText || 'ダウンロードに失敗しました')
          return
        }

        const disposition = res.headers.get('Content-Disposition') || ''
        const filenameMatch = disposition.match(/filename="(.+)"/)
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `export_${card.type}.xlsx`

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('Export error:', err)
      setExportError('エクスポートに失敗しました')
    } finally {
      setExportDownloading(null)
    }
  }, [password, ym, exportSelectedOrg])

  // ── Worker filtering & sorting ──

  // 2026-06-XX 修正 (UI #3): 2段階フィルタ
  //   Step 1: tabFilteredWorkers = タブ (全体/日比/HFU) でフィルタ
  //   Step 2: validation を tabFiltered で計算 (filteredWorkers 経由だと循環依存)
  //   Step 3: filteredWorkers = 異常フラグで更にフィルタ
  const tabFilteredWorkers = useMemo(() => {
    if (!data) return []
    if (tab === 'hibi') return data.workers.filter(w => w.org === 'hibi')
    if (tab === 'hfu') return data.workers.filter(w => w.org === 'hfu')
    return data.workers
  }, [data, tab])

  // tab フィルタ後の validation 結果（異常フィルタの ID source）
  // 2026-06-15 修正: 自動検算は「新ルール（変形労働制・2026年5月〜）」専用。
  //   4月以前は compute が全員を旧ルールで計算するため、新ルール検算を当てると
  //   構成要素不一致・所定外労働¥0 等の誤検知が大量に出る（給与計算自体は正しい）。
  //   → ym < '202605'（旧ルール月）は検算対象外にして空結果を返す。
  const validationOnTab = useMemo(() => {
    const targets = ym >= '202605' ? tabFilteredWorkers : []
    // 「確認した」が付いた注意点は外す（acked に分けて持つ・2026-10-05）
    return summarizeOpenIssues(validatePayrolls(targets as unknown as PayrollSnapshot[]).issues, noteAcks)
  }, [tabFilteredWorkers, ym, noteAcks])

  const filteredWorkers = useMemo(() => {
    if (!showAnomalyOnly) return tabFilteredWorkers
    const idsSet = new Set(validationOnTab.affectedWorkerIds)
    return tabFilteredWorkers.filter(w => idsSet.has(w.id))
  }, [tabFilteredWorkers, showAnomalyOnly, validationOnTab])

  const sortedWorkers = useMemo(() => {
    const list = [...filteredWorkers]
    list.sort((a, b) => {
      let cmp = 0
      switch (workerSortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'org': cmp = a.org.localeCompare(b.org); break
        case 'workDays': cmp = a.workDays - b.workDays; break
        case 'plDays': cmp = a.plDays - b.plDays; break
        case 'otHours': cmp = displayOtHours(a) - displayOtHours(b); break
        case 'rate': cmp = a.rate - b.rate; break
        case 'totalCost': cmp = a.totalCost - b.totalCost; break
      }
      return workerSortAsc ? cmp : -cmp
    })
    return list
  }, [filteredWorkers, workerSortKey, workerSortAsc])

  const workerTotals = useMemo(() => {
    const dispatchDeduction = filteredWorkers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
    const totalCostRaw = filteredWorkers.reduce((s, w) => s + w.totalCost, 0)
    return {
      workDays: filteredWorkers.reduce((s, w) => s + w.workDays, 0),
      workAll: filteredWorkers.reduce((s, w) => s + (w.workAll || w.workDays), 0),
      plDays: filteredWorkers.reduce((s, w) => s + w.plDays, 0),
      otHours: Math.round(filteredWorkers.reduce((s, w) => s + displayOtHours(w), 0) * 10) / 10,
      totalCost: totalCostRaw - dispatchDeduction,  // 出向控除済み
      totalCostRaw,                                   // 出向控除前
      dispatchDeduction,
    }
  }, [filteredWorkers])

  // 給与計算の自動検算（2026-06-XX 追加: 不変条件で過去バグ3種を検出）
  //   新ルール外国人スタッフのみが対象（旧ルール・日本人・月給制は対象外）
  //   バナー表示は tabFiltered ベースで判定（異常フィルタの ON/OFF で件数が変わらないように）
  const validationResult = validationOnTab

  const toggleWorkerSort = (key: WorkerSortKey) => {
    if (workerSortKey === key) setWorkerSortAsc(!workerSortAsc)
    else { setWorkerSortKey(key); setWorkerSortAsc(true) }
  }


  // ── Sort indicator ──

  function sortArrow(active: boolean, asc: boolean) {
    if (!active) return ''
    return asc ? ' ↑' : ' ↓'
  }

  // ── Org badge ──

  function orgBadge(org: string) {
    const isHfu = org === 'hfu'
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full ${
        isHfu ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
      }`}>
        {isHfu ? 'HFU' : '日比'}
      </span>
    )
  }

  // ── Absence calculation ──

  const isHfuTab = tab === 'hfu'
  const prescribedDaysNum = Number(prescribedDays) || 0
  const showAbsenceColumns = isHfuTab && prescribedDaysNum > 0
  // Show salary columns for all tabs (visible for all workers)
  const showSalaryColumns = true

  // 2026-06-12 修正 (監査): 画面側の金額フォールバック計算を削除。
  //   computeMonthly は absence/absentCost/netPay を常に初期化するため到達しないデッドコードだったが、
  //   「出力層は金額を再計算しない」原則に反し、API 形状変更時に compute とズレた金額が
  //   静かに表示されるリスクがあった。サーバ値のみを表示する。
  function calcAbsentDays(w: WorkerMonthly): number {
    return w.absence ?? 0
  }

  function calcAbsentDeduction(w: WorkerMonthly): number {
    return w.absentCost ?? 0
  }

  function calcNetPay(w: WorkerMonthly): number {
    return w.netPay ?? 0
  }

  // ── Render ──

  // 2026-09-26: 旧「外注」タブは原価・収益の「外注先別原価明細」と同じ表だったので廃止（原価・収益へ一本化）

  // Dynamic column count for empty state
  // 給与列: 旧ルール=5列, 新ルール=9列（+所定外労働/法休手当/深夜手当/休業手当）
  // 2026-06-XX 修正 (I-2): 新ルール時の所定外労働手当列を追加
  // 2026-06-15 追加: 補償日控除（会社都合休の通常分・旧ルール固定給者）は、該当者がいる時だけ列を出す
  const showCompBaseDeduction = filteredWorkers.some(w => (w.compBaseDeduction || 0) > 0)
  // 休憩短縮手当は該当者がいる月だけ列を出す（2026-09〜・現状フンさんのみ）
  const showBreakShorten = filteredWorkers.some(w => (w.breakShortenAllowance || 0) > 0)
  // 2026-08-28: 日当は保留・運転手当のみ施行。月ではなく「該当者がいるか」で列を出す
  const showAllowance = filteredWorkers.some(w => (w.siteAllowance || 0) > 0 || (w.driveAllowance || 0) > 0)
  const salaryColCount = (ym >= '202605' ? 9 : 5) + (showAllowance ? 2 : 0)
    + (showBreakShorten ? 1 : 0) + (showCompBaseDeduction ? 1 : 0)
  const workerColCount = 8 + (showAbsenceColumns ? 3 : 0) + salaryColCount

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* 月次集計 ↔ 帳票出力（2026-10-01: 下線タブに・絵文字をやめる） */}
      <UnderlineTabs
        label="月次集計のタブ"
        active={topTab}
        onChange={switchTopTab}
        tabs={[{ key: 'summary', label: '月次集計・締め' }, { key: 'export', label: '帳票出力' }]}
      />

      {/* ═══════════════ 帳票出力 Tab ═══════════════ */}
      {topTab === 'export' && (() => {
        const ymClean = ym.replace('-', '')
        const orgLabelOf = (o: 'hibi' | 'hfu') => (o === 'hibi' ? '日比建設' : 'HFU')
        // 会社別の Excel をダウンロード（キャシュモ提出・根拠書類の両グループで共通）
        const downloadOrgExcel = async (type: 'plannedShift' | 'actualHours' | 'monthlyExcel' | 'hibi' | 'hfu', org: 'hibi' | 'hfu', filename: string) => {
          if (!password) { setExportError('管理者パスワードが設定されていません'); return }
          setExportError('')
          setExportDownloading(`${type}-${org}`)
          try {
            const res = await fetch(`/api/export?type=${type}&ym=${ymClean}&org=${org}`, { headers: { 'x-admin-password': password } })
            if (!res.ok) { setExportError('ダウンロードに失敗しました'); return }
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            // 締める前に出した帳票は、ファイル名の頭に【未確定】（サーバが X-Unconfirmed で知らせる・2026-09-30）
            a.download = res.headers.get('X-Unconfirmed') === '1' ? `【未確定】${filename}` : filename
            a.click()
            URL.revokeObjectURL(url)
          } finally {
            setExportDownloading(null)
          }
        }
        const btn = (key: string, label: string, title: string, cls: string, onClick: () => void) => (
          <button
            key={key}
            onClick={onClick}
            disabled={exportDownloading === key}
            title={title}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition disabled:opacity-50 ${cls}`}
          >
            {exportDownloading === key ? '…' : label}
          </button>
        )
        const orgRow = (org: 'hibi' | 'hfu', buttons: React.ReactNode) => (
          <div key={org} className="flex flex-wrap items-center gap-2 py-2">
            <span className={`text-sm font-bold min-w-[80px] ${org === 'hibi' ? 'text-teal-900 dark:text-teal-200' : 'text-pink-900 dark:text-pink-200'}`}>{orgLabelOf(org)}</span>
            {buttons}
          </div>
        )
        return (
        <div className="space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">帳票出力</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">帳票はすべてここから出します。対象月は右で選びます（集計タブと共通）</p>
              {(!data?.lockedHibi || !data?.lockedHfu) && (
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                  注意: 月締めの前に出した提出用の帳票（出面一覧・月次集計・実労働時間明細・現場別出面一覧・外注確認書）は、
                  先頭に「未確定（締め前）」のシートが入り、ファイル名に【未確定】が付きます。提出には締めたあとに出し直したものを使ってください。
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 dark:text-gray-300">対象月</span>
              <select
                value={ym}
                onChange={e => setYm(e.target.value)}
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none"
              >
                {ymOptions.map(o => (
                  <option key={o.ym} value={o.ym}>{o.label}</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5">
                {data?.lockedHibi && <span className="px-2 py-0.5 bg-red-100 text-red-700 text-3xs font-bold rounded-full inline-flex items-center gap-1"><Icon name="lock" size={11} />日比 締め済</span>}
                {data?.lockedHfu && <span className="px-2 py-0.5 bg-red-100 text-red-700 text-3xs font-bold rounded-full inline-flex items-center gap-1"><Icon name="lock" size={11} />HFU 締め済</span>}
              </div>
            </div>
          </div>

          {exportError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
              {exportError}
            </div>
          )}

          {/* ── ① キャシュモ提出（毎月の2点）── 2026-09-17 代表決定 */}
          <section className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 rounded-xl p-4">
            <h2 className="text-sm font-bold text-indigo-900 dark:text-indigo-200">キャシュモ提出（毎月の2点・会社別）</h2>
            <p className="text-xs text-indigo-700 dark:text-indigo-300 mt-1 mb-2">
              月締めロック後に会社ごとに出してキャシュモへ送る。この2点にその会社の全員（日本人・ベトナム人）が載ります。PDF はブラウザの「PDFとして保存」
            </p>
            {(['hibi', 'hfu'] as const).map(org => orgRow(org, (
              <>
                {btn(`monthlyExcel-${org}`, '月次集計 Excel', '支給額の内訳（日本人シート／ベトナム人シート）。マネーフォワードに入れる数字',
                  'bg-green-600 text-white hover:bg-green-700',
                  () => downloadOrgExcel('monthlyExcel', org, `月次集計_${orgLabelOf(org)}_${ymClean}.xlsx`))}
                <button
                  onClick={() => window.open(`/monthly/audit-print?ym=${ymClean}&org=${org}`, '_blank')}
                  className="px-3 py-1.5 text-xs rounded-lg font-medium bg-purple-600 text-white hover:bg-purple-700 transition"
                  title="1人1ページの内訳＋日別カレンダー＋自動検算。新タブで開く → Cmd+P で PDF 保存"
                >
                  計算根拠 PDF
                </button>
              </>
            )))}
          </section>

          {/* ── ② 根拠書類（求められたら出す）── */}
          <section className="bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 rounded-xl p-4">
            <h2 className="text-sm font-bold text-hibi-navy dark:text-white">根拠書類（毎月は送らない・会社別）</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-2">
              キャシュモ・社労士・労基署に求められたときに出す。勤務予定シフト＝変形労働時間制で事前に定めた所定の記録／実労働時間明細＝残業時間の根拠（ベトナム人）／出面一覧＝全員の日別記録
            </p>
            {(['hibi', 'hfu'] as const).map(org => orgRow(org, (
              <>
                {btn(`plannedShift-${org}`, '勤務予定シフト', 'ベトナム人・各日各週の所定労働時間',
                  'border border-teal-500 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/30',
                  () => downloadOrgExcel('plannedShift', org, `勤務予定シフト_${orgLabelOf(org)}_${ymClean}.xlsx`))}
                {btn(`actualHours-${org}`, '実労働時間明細', 'ベトナム人・日別の始業・終業・休憩・実労働h',
                  'border border-emerald-500 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30',
                  () => downloadOrgExcel('actualHours', org, `実労働時間明細_${orgLabelOf(org)}_${ymClean}.xlsx`))}
                {btn(`${org}-${org}`, '出面一覧', '全員の日別 出勤・残業 ＋ 外国人の勤務時間一覧・勤怠サマリー',
                  'border border-sky-500 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-900/30',
                  () => downloadOrgExcel(org, org, `出面一覧_${orgLabelOf(org)}_${ymClean}.xlsx`))}
              </>
            )))}
          </section>

          {/* ── ③ 社内用 ── */}
          <section>
            <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-2">社内用（原価・外注・有給）</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {EXPORT_CARDS.map((card) => {
                const isDownloading = exportDownloading === card.type
                return (
                  <div key={card.type} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 hover:shadow-md transition-shadow p-4 flex flex-col">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon name={card.icon} size={22} className="text-hibi-navy dark:text-white shrink-0" />
                      <h3 className="font-bold text-hibi-navy dark:text-white text-sm">{card.title}</h3>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 flex-1">{card.description}</p>
                    {card.needsOrg && (
                      <div className="mb-2">
                        <select
                          value={exportSelectedOrg[card.type] || 'all'}
                          onChange={(e) => setExportSelectedOrg(prev => ({ ...prev, [card.type]: e.target.value }))}
                          className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
                        >
                          <option value="all">全社</option>
                          <option value="hibi">日比建設</option>
                          <option value="hfu">HFU</option>
                        </select>
                      </div>
                    )}
                    <button
                      onClick={() => handleExportDownload(card)}
                      disabled={isDownloading}
                      className={`w-full rounded-lg py-2 text-sm font-medium transition flex items-center justify-center gap-2
                        ${isDownloading
                          ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                          : 'bg-hibi-navy text-white hover:bg-hibi-light'
                        }`}
                    >
                      {isDownloading ? (
                        <>
                          <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                          <span>ダウンロード中...</span>
                        </>
                      ) : (
                        <>
                          <Icon name="download" size={14} />
                          <span>{card.needsYm ? `${card.format}（${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月）` : card.format}</span>
                        </>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
        )
      })()}

      {/* ═══════════════ 月次集計 Tab ═══════════════ */}
      {topTab === 'summary' && <>
      {/* Header & controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">月次集計・締め</h1>
            {data && (
              <p className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 mt-1">
                出勤延べ {fmtNum(data.totals.workDays)}人日 / 外注 {fmtNum(data.totals.subWorkDays)}人工 / 残業 {fmtNum(Math.round(data.workers.reduce((s, w) => s + displayOtHours(w), 0) * 10) / 10)}h
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ToolButton icon="download" onClick={() => switchTopTab('export')}
            title="帳票はすべて「帳票出力」タブから（キャシュモ提出の2点・根拠書類・社内用）">帳票出力</ToolButton>
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none"
          >
            {ymOptions.map(o => (
              <option key={o.ym} value={o.ym}>{o.label}</option>
            ))}
          </select>
          {ym === prevYm() && <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 whitespace-nowrap">締める月</span>}
          {ym === currentYm() && <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 whitespace-nowrap">今月（途中）</span>}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key
                ? 'bg-hibi-navy text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
        <a href="/cost" className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-hibi-navy underline">外注の人工・金額は「原価・収益」へ →</a>

        {/* 所定日数: カレンダーデータがある月は自動取得、ない月は手入力。
            2026-06-12 (監査 Sprint2): 旧ルール継続者（フン）が在籍する月は、カレンダーが
            あっても全社所定の入力欄を常時表示する（フンの欠勤控除は main.workDays[ym] を
            使うため毎月の設定が必要。旧: 欄が消えて Firestore 直編集が必要だった） */}
        {data?.hasCalendarData && !data?.hasOldRulesWorkers && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium whitespace-nowrap">所定日数: カレンダーから自動取得</span>
          </div>
        )}
        {(!data?.hasCalendarData || data?.hasOldRulesWorkers) && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600 flex-wrap">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap" title={data?.hasCalendarData ? '新ルールのスタッフは現場カレンダーから自動取得。この欄は旧ルール継続者（フン等）の所定日数（日曜以外−祝日）' : undefined}>
              {data?.hasCalendarData ? '所定日数(旧ルール用):' : '所定日数:'}
            </label>
            {data?.hasOldRulesWorkers && (Number(prescribedDays) || 0) === 0 && (
              <span className="text-xs text-red-600 dark:text-red-400 font-bold whitespace-nowrap">未設定（フンさんの欠勤控除が計算できません）</span>
            )}
            <input
              type="number"
              value={prescribedDays}
              onChange={e => setPrescribedDays(e.target.value)}
              placeholder="—"
              min={0}
              max={31}
              step={1}
              className="w-16 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm text-center focus:ring-2 focus:ring-hibi-navy focus:outline-none"
            />
            <button
              onClick={handleSaveWorkDays}
              disabled={savingWorkDays}
              className="px-2 py-1 text-xs rounded bg-hibi-navy text-white hover:bg-blue-800 transition disabled:opacity-50"
            >
              {savingWorkDays ? '...' : '保存'}
            </button>
            {/* 2026-06-XX 追加: 日曜以外の基準値ヒント + クイックリセット */}
            {(() => {
              const baseDays = calcDefaultPrescribedDays(ym)
              const current = Number(prescribedDays) || 0
              const diff = current - baseDays
              return (
                <span
                  className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap cursor-pointer hover:text-hibi-navy"
                  title="クリックで基準値（日曜以外の日数）にリセット。特別休暇分はここから手動で減算してください"
                  onClick={() => setPrescribedDays(String(baseDays))}
                >
                  基準値: {baseDays}日 (日曜以外)
                  {diff < 0 && <span className="ml-1 text-amber-600">{diff}日</span>}
                </span>
              )
            })()}
          </div>
        )}

        {/* 2026-06-XX 追加 (UI #3): 異常スタッフのみフィルタ */}
        {validationOnTab.affectedWorkerIds.length > 0 && (
          <button
            onClick={() => setShowAnomalyOnly(s => !s)}
            className={`ml-4 pl-4 border-l border-gray-300 dark:border-gray-600 flex items-center gap-2 transition ${
              showAnomalyOnly
                ? 'text-red-700 dark:text-red-300 font-bold'
                : 'text-gray-500 dark:text-gray-400 hover:text-red-600'
            }`}
            title={showAnomalyOnly
              ? 'クリックして全員表示に戻す'
              : 'クリックして検算で違反のあるスタッフだけ表示'}
          >
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${showAnomalyOnly ? 'bg-red-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
            <span className="text-xs whitespace-nowrap">
              {showAnomalyOnly ? '異常者のみ表示中' : `異常者のみ (${validationOnTab.affectedWorkerIds.length}名)`}
            </span>
          </button>
        )}
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400 dark:text-gray-500">
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* 会社ごとの締めの準備（2026-10-01）: 人数・支給額の合計・締める前のチェック・締めるボタンを1枚に */}
      {!loading && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(['hibi', 'hfu'] as const).map(org => {
            const ws = data.workers.filter(w => w.org === org)
            // 本人確認の対象者と状態はサーバが決める（締めと同じ）。対象外の人は staffConfirms に入らない
            const confRows = Object.values(staffConfirms).filter(c => c.org === org)
            const confCount = (st: StaffConfirmInfo['state']) => confRows.filter(c => c.state === st).length
            const auditTargets = ws.filter(w => w.visa && w.visa !== 'none' && (w.hourlyRate || 0) > 0 && !(w.salary && w.salary > 0) && !w.useOldRules)
            const auditAll = ym >= '202605' ? summarizeOpenIssues(validatePayrolls(ws as unknown as PayrollSnapshot[]).issues, noteAcks) : null
            const diff = data.snapshotDiffs?.find(d => d.org === org)
            const ymLabel = `${Number(ym.slice(4, 6))}月分`
            return (
              <CloseCard
                key={org}
                org={org}
                label={org === 'hibi' ? '日比建設' : 'HFU'}
                ymLabel={ymLabel}
                people={ws.length}
                total={ws.reduce((sum, w) => sum + (w.salaryNetPay || 0), 0)}
                locked={org === 'hibi' ? data.lockedHibi : data.lockedHfu}
                approval={data.approvalStatus?.[org] ?? null}
                confirm={{
                  target: confRows.length, ok: confCount('ok'), none: confCount('none') + confCount('early'),
                  stale: confCount('stale'), issue: confCount('issue'), waiting: confCount('waiting'), outside: confCount('outside'),
                  failed: staffConfirmsFailed,
                }}
                audit={auditAll ? { target: auditTargets.length, affected: auditAll.affectedWorkerIds.length } : null}
                changedAfterLock={diff?.count || 0}
                canClose={canResolveConfirm}
                busy={lockToggling}
                onToggleLock={() => handleToggleLock(org)}
                onShowConfirm={() => { setTab(org); setView('list'); setListFilter('unconfirmed') }}
                onShowAudit={() => { setTab(org); setView('list'); setListFilter('attention') }}
              />
            )
          })}
        </div>
      )}

      {/* 本人確認の催促（2026-10-05）: 確認が出て3日たっても押していない人がいると警告と、名前入りの文面を作るボタン。両社まとめて */}
      {!loading && data && !staffConfirmsFailed && (
        <ConfirmReminder ym={ym} people={Object.entries(staffConfirms).map(([id, c]) => ({
          workerId: Number(id), name: c.name || `ID ${id}`, nameVi: c.nameVi, state: c.state, since: c.since,
        }))} />
      )}

      {/* 2026-06-12 (監査 Sprint2-D): 締め後に支給額が変わった場合の警告バナー。
          締め時に保存したスナップショットと現行計算を突合し、単価変更・出面修正等で
          「支払った金額」と画面の金額がズレたことを検知する */}
      {!loading && data && (data.snapshotDiffs?.length || 0) > 0 && (
        <div className="rounded-xl p-4 border bg-red-50 dark:bg-red-900/20 border-red-400 dark:border-red-700">
          <div className="flex items-start gap-3">
            <Icon name="alert" size={24} className="text-red-600 dark:text-red-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-red-800 dark:text-red-300">
                締め（給与確定）後に支給額が変わっています
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                締め時点のスナップショットと現在の計算結果が一致しません。締め後に単価・出面・有給等が変更された可能性があります。
                変更が誤りなら元に戻し、正当な修正なら「締め解除 → 内容確認 → 再締め」でスナップショットを更新してください。
              </div>
              {data.snapshotDiffs!.map(diff => (
                <div key={diff.org} className="mt-2">
                  <div className="text-xs font-bold text-red-700 dark:text-red-400">
                    {diff.org === 'hibi' ? '日比建設' : 'HFU'}（締め: {diff.lockedAt ? diff.lockedAt.slice(0, 16).replace('T', ' ') : '—'} / 差分 {diff.count}名）
                  </div>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {diff.items.map(item => (
                      <li key={item.id} className="text-gray-800 dark:text-gray-200">
                        <span className="font-semibold">{item.name}</span>:
                        <span className="font-mono ml-1">締め時 {fmtYen(item.snapshot)} → 現在 {fmtYen(item.current)}</span>
                        <span className={`ml-1 font-mono font-bold ${item.current > item.snapshot ? 'text-red-600' : 'text-blue-600'}`}>
                          ({item.current > item.snapshot ? '+' : ''}{fmtYen(item.current - item.snapshot)})
                        </span>
                      </li>
                    ))}
                    {diff.count > diff.items.length && (
                      <li className="text-xs text-gray-500">…他 {diff.count - diff.items.length} 名</li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 給与計算の自動検算バナー（2026-06-XX 追加） */}
      {!loading && data && validationResult.total > 0 && (
        <div className={`rounded-xl p-4 border ${
          validationResult.critical > 0
            ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'
            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-700'
        }`}>
          <div className="flex items-start gap-3">
            <Icon name={validationResult.critical > 0 ? 'alert' : 'bell'} size={24} className={validationResult.critical > 0 ? 'text-red-600 dark:text-red-400 shrink-0' : 'text-yellow-600 dark:text-yellow-400 shrink-0'} />
            <div className="flex-1 min-w-0">
              <div className={`font-bold ${
                validationResult.critical > 0
                  ? 'text-red-800 dark:text-red-300'
                  : 'text-yellow-800 dark:text-yellow-300'
              }`}>
                給与計算に{validationResult.critical > 0 ? '異常' : '注意点'}があります（{validationResult.affectedWorkerIds.length}名 / 検出{validationResult.total}件）
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                労基法・実労働時間ベースの自動検算で {validationResult.critical > 0 && <span className="font-semibold text-red-700 dark:text-red-400">critical {validationResult.critical}件</span>}
                {validationResult.critical > 0 && validationResult.warning > 0 && ' / '}
                {validationResult.warning > 0 && <span className="font-semibold text-yellow-700 dark:text-yellow-400">warning {validationResult.warning}件</span>}
                {' '}を検出しました。該当スタッフの行クリックで「計算根拠」モーダルを開いて詳細を確認してください。
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {validationResult.issues.slice(0, 20).map((iss, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={iss.severity === 'critical' ? 'text-red-600' : 'text-yellow-600'}>
                      <Icon name="alert" size={14} className="mt-0.5" />
                    </span>
                    <span className="text-gray-800 dark:text-gray-200">
                      <span className="font-semibold">{iss.workerName}</span>: {iss.message}
                      {iss.expected !== undefined && iss.actual !== undefined && (
                        <span className="text-gray-500"> (想定 {fmtYen(iss.expected)} / 実額 {fmtYen(iss.actual)})</span>
                      )}
                    </span>
                    {/* 注意点（warning）は、見て問題なければ「確認した」で帯から外せる。異常（critical）は直すまで消えない */}
                    {iss.severity === 'warning' && canResolveConfirm && (
                      <span className="shrink-0">
                        <RowButton tone="ghost" busy={ackBusy === `${iss.workerId}|${iss.field}`} busyLabel="記録しています"
                          disabled={ackBusy !== null} onClick={() => ackNote(iss)}>確認した</RowButton>
                      </span>
                    )}
                  </li>
                ))}
                {validationResult.issues.length > 20 && (
                  <li className="text-xs text-gray-500 dark:text-gray-400 pl-6">
                    …他 {validationResult.issues.length - 20} 件
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 確認済みの注意点（2026-10-05）: 消さずに灰色で残す。誰が・いつ・メモ。取り消すと未確認に戻る */}
      {!loading && data && validationResult.acked.length > 0 && (
        <details className="rounded-xl border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
          <summary className="cursor-pointer text-sm font-bold text-gray-700 dark:text-gray-200">
            確認済みの注意点 {validationResult.acked.length}件
            <span className="ml-2 text-xs font-normal text-hibi-sub dark:text-gray-400">押すと中身が開きます。金額や日数が変わると、未確認に戻ります</span>
          </summary>
          <ul className="mt-2 space-y-2 text-sm">
            {validationResult.acked.map((iss, i) => (
              <li key={i} className="flex items-start gap-2">
                <Icon name="check" size={14} className="mt-1 text-green-600 dark:text-green-400 shrink-0" />
                <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300">
                  <span className="font-semibold">{iss.workerName}</span>: {iss.message}
                  <span className="block text-xs text-hibi-sub dark:text-gray-400">
                    確認: {iss.ack.byName || iss.ack.by}・{new Date(iss.ack.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                    {iss.ack.note ? `・メモ「${iss.ack.note}」` : ''}
                  </span>
                </span>
                {canResolveConfirm && (
                  <span className="shrink-0">
                    <RowButton tone="ghost" busy={ackBusy === `${iss.workerId}|${iss.field}`} busyLabel="取り消しています"
                      disabled={ackBusy !== null} onClick={() => unackNote(iss)}>確認を取り消す</RowButton>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 2026-06-12 (監査 Sprint2-C): 異常0件でも検算の実施状況を常時表示。
          旧: 異常時のみバナー → 「検算対象外（日本人・フン・完全月給）も含めて全員OK」と
          誤認するリスクがあった。対象/対象外の人数を明示する */}
      {!loading && data && validationResult.total === 0 && view === 'table' && (() => {
        const targets = tabFilteredWorkers.filter(w =>
          w.visa && w.visa !== 'none' && (w.hourlyRate || 0) > 0 && !(w.salary && w.salary > 0) && !w.useOldRules)
        const exempt = tabFilteredWorkers.length - targets.length
        return (
          <div className="rounded-xl px-4 py-3 border bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700 flex items-center gap-3 text-sm">
            <Icon name="check" size={20} strokeWidth={2.4} className="text-green-600 dark:text-green-400 shrink-0" />
            <div className="text-green-800 dark:text-green-300">
              <span className="font-bold">自動検算OK</span>
              <span className="ml-2">対象 {targets.length}名（ベトナム人・新ルール時給制）に異常なし。</span>
              {exempt > 0 && (
                <span className="ml-1 text-green-700/80 dark:text-green-400/80">
                  対象外 {exempt}名（日本人・完全月給・旧ルール継続）は自動検算の対象外のため、計算根拠モーダルで目視確認してください。
                </span>
              )}
            </div>
          </div>
        )
      })()}

      {/* Worker Table (全体 / 日比建設 / HFU)

          2026-09-02: 縦スクロールでも見出し行・合計行が残るようにした。
          sticky は「スクロールする祖先」を基準に効くため、横スクロールだけの
          overflow-x-auto ではページ全体のスクロールに追随できない。高さ上限つきの
          スクロール領域にしたうえで、thead/tfoot のセルを sticky にしている。 */}
      {/* 見せ方の切り替え（2026-10-01）＋ 見やすい一覧の絞り込み */}
      {!loading && data && (
        <div className="flex flex-wrap items-center gap-3">
          <Segment value={view} onChange={setView} items={[['list', '見やすい一覧'], ['table', '全項目の表']]} />
          {view === 'list' && (
            <>
              <Segment value={listFilter} onChange={setListFilter} items={[
                  ['all', 'すべて'],
                  ['attention', `要確認だけ ${tabFilteredWorkers.filter(w => needsAttention(w, new Set(validationOnTab.affectedWorkerIds))).length}`],
                  // 数は「スマホに確認が出ているのにまだ」の人。承認待ち・期間外は別に出す（締めの準備カードと同じ分け方・2026-10-02 点検）
                  ['unconfirmed', (() => {
                    const pend = tabFilteredWorkers.filter(w => isConfirmPending(staffConfirms[w.id]))
                    const later = pend.filter(w => ['waiting', 'outside'].includes(staffConfirms[w.id]!.state)).length
                    return `本人確認まだ ${pend.length - later}${later > 0 ? `・承認待ちなど ${later}` : ''}`
                  })()],
                ]} />
              <SearchBox value={listQuery} onChange={setListQuery} />
            </>
          )}
        </div>
      )}

      {!loading && data && view === 'list' && (() => {
        const auditIds = new Set(validationOnTab.affectedWorkerIds)
        const q = listQuery.trim().replace(/\s/g, '')
        let list = tabFilteredWorkers
        if (q) list = list.filter(w => w.name.replace(/\s/g, '').includes(q))
        if (listFilter === 'attention') list = list.filter(w => needsAttention(w, auditIds))
        if (listFilter === 'unconfirmed') list = list.filter(w => isConfirmPending(staffConfirms[w.id]))
        // 要確認を上に、そのあと会社・名前の順
        const sorted = [...list].sort((a, b) =>
          Number(needsAttention(b, auditIds)) - Number(needsAttention(a, auditIds))
          || a.org.localeCompare(b.org) || a.name.localeCompare(b.name, 'ja'))
        return (
          <OverviewList
            workers={sorted.map(w => ({ ...w, otHours: displayOtHours(w) }))}
            ym={ym}
            auditIds={auditIds}
            staffConfirms={staffConfirms}
            password={password}
            canResolveConfirm={canResolveConfirm}
            onConfirmChanged={() => setConfirmsVersion(v => v + 1)}
            onOpen={id => { const w = data.workers.find(x => x.id === id); if (w) setAuditingWorker(w) }}
            siteNameOf={sid => (data.siteNames?.[sid] || sid)}
          />
        )
      })()}

      {!loading && data && view === 'table' && (
        <div
          className="isolate bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-auto"
          style={{ maxHeight: 'calc(100vh - 180px)' }}
        >
          <table className="w-full text-sm min-w-[1400px]">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap sticky left-0 top-0 z-30 bg-gray-50 dark:bg-gray-700 border-r border-gray-200 dark:border-gray-600 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]"
                  onClick={() => toggleWorkerSort('name')}
                >
                  名前{sortArrow(workerSortKey === 'name', workerSortAsc)}
                </th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleWorkerSort('org')}
                >
                  所属{sortArrow(workerSortKey === 'org', workerSortAsc)}
                </th>
                <th className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 whitespace-nowrap">現場</th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('workDays')}
                >
                  出勤日数{sortArrow(workerSortKey === 'workDays', workerSortAsc)}
                </th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('plDays')}
                >
                  有給{sortArrow(workerSortKey === 'plDays', workerSortAsc)}
                </th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('otHours')}
                  title="新ルール(ベトナム人): 所定外労働時間（所定7hを超えた実体の時間。法定外はこの内数で下段に表示）。日本人・旧ルール: 出面の残業欄合計"
                >
                  残業(h){sortArrow(workerSortKey === 'otHours', workerSortAsc)}
                </th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('rate')}
                  title="日給月給=日額 / 完全月給・固定月給=月給 / ベトナム人=時給ベース（行に応じて表示）"
                >
                  単価/月給{sortArrow(workerSortKey === 'rate', workerSortAsc)}
                </th>
                <th
                  className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('totalCost')}
                >
                  <span title="実際の支給額ベースの労務費（ベトナム人・完全月給は支給額、日本人日給月給は日額×日数）">労務費</span>{sortArrow(workerSortKey === 'totalCost', workerSortAsc)}
                </th>
                {showAbsenceColumns && (
                  <>
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">欠勤日数</th>
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">欠勤控除</th>
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">差引支給</th>
                  </>
                )}
                {showSalaryColumns && (
                  <>
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">基本給</th>
                    {/* 4月以前は「休業補償」、5月以降は「追加所定」 */}
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                      {ym >= '202605' ? '追加所定' : '休業補償'}
                    </th>
                    {/* 2026-09-02 追加: 有給手当列（ベトナム人=20日枠超の有給日給、日本人日給月給=有給×日額）。
                        従来は表に無く、可視列の合計が支給額と一致しなかった */}
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                      title="ベトナム人: 20日枠を超えた有給日数 × 時給 × 7h ／ 日本人日給月給: 有給日数 × 日額">有給手当</th>
                    {/* 2026-06-XX 追加 (I-2): 所定外労働手当列を新ルール時に表示 */}
                    {ym >= '202605' && (
                      <th
                        className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                        title="月所定140h超〜法定上限内の労働 × 通常賃金（労基法24条）"
                      >
                        所定外労働
                      </th>
                    )}
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                      {ym >= '202605' ? '法定外残業' : '残業手当'}
                    </th>
                    {ym >= '202605' && (
                      <>
                        <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="日曜出勤 1.35倍 (8h超は1.60倍)">法休手当</th>
                        <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="22:00-5:00 +0.25倍">深夜手当</th>
                        <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="補償日 60%">休業手当</th>
                      </>
                    )}
                    {showBreakShorten && (
                      <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="休憩短縮に伴う所定外労働（出勤日 × 短縮分 × 残業単価）。雇用契約書の所定超25%に合わせて割増">休憩短縮</th>
                    )}
                    {/* 遠方現場日当・運転手当（2026-10 施行、lib/allowance.ts） */}
                    {showAllowance && (
                      <>
                        <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="遠方現場日当（非課税・実費弁償）。いまは保留中で支給していません（再開したときの決まり: 判定値80分超500円/120分超1,500円・長期従事は逓減）">日当</th>
                        <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="運転手当（課税）。片道1,000円。同乗者を乗せた便だけ（1人だけの便は対象外）・「運転手当なし」の現場は除く">運転手当</th>
                      </>
                    )}
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">欠勤控除</th>
                    {showCompBaseDeduction && (
                      <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="会社都合休(補償日)の通常分。固定給は満額前提のため一旦控除し、60%を休業補償で還元（正味 日給の40%控除）">補償日控除</th>
                    )}
                    <th className="sticky top-0 z-20 px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">支給額合計</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedWorkers.length === 0 ? (
                <tr>
                  <td colSpan={workerColCount} className="px-3 py-8 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              ) : (
                sortedWorkers.map(w => {
                  const compDays = w.compDays || 0
                  const hasComp = compDays > 0
                  const absentDays = showAbsenceColumns ? calcAbsentDays(w) : 0
                  const absentDeduction = showAbsenceColumns ? calcAbsentDeduction(w) : 0
                  const netPay = showAbsenceColumns ? calcNetPay(w) : 0
                  return (
                    <tr key={w.id} className={`border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30 ${w.isDispatched ? 'bg-purple-50/30' : ''}`}>
                      {/*
                        名前列は横スクロール時に固定（sticky left-0）。
                        sticky cell は透過できないので solid な背景色が必要。
                        even/hover の交互色は失われるが、出向中(紫)はインライン badge も
                        あるため視認性は維持される。
                      */}
                      <td className={`px-3 py-2.5 font-medium whitespace-nowrap sticky left-0 z-10 border-r border-gray-200 dark:border-gray-700 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)] ${
                        w.isDispatched
                          ? 'bg-purple-50 dark:bg-purple-900/40'
                          : 'bg-white dark:bg-gray-800'
                      }`}>
                        <button
                          onClick={() => setAuditingWorker(w)}
                          className="hover:underline hover:text-hibi-navy text-left"
                          title={(() => {
                            // 2026-06-XX 追加 (UI #4): ホバーで支給額内訳を即表示
                            //   モーダルを開かなくても合計の構成が把握できる
                            const lines: string[] = ['給与内訳（クリックで詳細）']
                            lines.push('')
                            if ((w.fixedBasePay || w.basePay || 0) > 0)
                              lines.push(`基本給:        ¥${(w.fixedBasePay || w.basePay || 0).toLocaleString()}`)
                            if ((w.additionalAllowance || 0) > 0)
                              lines.push(`${w.useOldRules ? '休業補償' : '追加所定'}:      ¥${(w.additionalAllowance || 0).toLocaleString()}`)
                            if ((w.paidLeaveAllowance || 0) > 0)
                              lines.push(`有給手当:      ¥${(w.paidLeaveAllowance || 0).toLocaleString()}`)
                            if ((w.nonStatutoryOTAllowance || 0) > 0)
                              lines.push(`所定外労働:    ¥${(w.nonStatutoryOTAllowance || 0).toLocaleString()}`)
                            if ((w.otAllowance || 0) > 0)
                              lines.push(`法定外残業:    ¥${(w.otAllowance || 0).toLocaleString()}`)
                            if ((w.legalHolidayAllowance || 0) > 0)
                              lines.push(`法定休日:      ¥${(w.legalHolidayAllowance || 0).toLocaleString()}`)
                            if ((w.nightAllowance || 0) > 0)
                              lines.push(`深夜:          ¥${(w.nightAllowance || 0).toLocaleString()}`)
                            if ((w.compAllowance || 0) > 0)
                              lines.push(`休業手当:      ¥${(w.compAllowance || 0).toLocaleString()}`)
                            if ((w.breakShortenAllowance || 0) > 0)
                              lines.push(`休憩短縮手当:  ¥${(w.breakShortenAllowance || 0).toLocaleString()}（${w.breakShortenHours}h・25%割増）`)
                            if ((w.siteAllowance || 0) > 0)
                              lines.push(`遠方現場日当:  ¥${(w.siteAllowance || 0).toLocaleString()}（${w.allowanceDays || 0}日・非課税）`)
                            if ((w.driveAllowance || 0) > 0)
                              lines.push(`運転手当:      ¥${(w.driveAllowance || 0).toLocaleString()}（${w.driveLegs || 0}便）`)
                            if ((w.absentDeduction || 0) > 0)
                              lines.push(`欠勤控除:     −¥${(w.absentDeduction || 0).toLocaleString()}`)
                            if ((w.compBaseDeduction || 0) > 0)
                              lines.push(`補償日控除:   −¥${(w.compBaseDeduction || 0).toLocaleString()}（会社都合休の通常分・60%は休業手当で還元）`)
                            lines.push('─────────────')
                            lines.push(`支給額:        ¥${(w.salaryNetPay || 0).toLocaleString()}`)
                            return lines.join('\n')
                          })()}
                        >
                          {w.name}
                          <span className="ml-1 text-3xs text-blue-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 inline-flex align-middle"><Icon name="search" size={11} /></span>
                        </button>
                        {w.isDispatched && (
                          <span
                            className="ml-1.5 text-3xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`出向先: ${w.dispatchTo || ''}`}
                          >
                            出向中
                          </span>
                        )}
                        {(w.hkDays || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`当月 ${w.hkDays}日 帰国中（所定から除外・無給。欠勤ではありません）`}
                          >
                            帰国中{w.hkDays}日
                          </span>
                        )}
                        {/* 申請より早く復帰して出勤している。給与は打刻ベースで正しく計算されるが、
                            帰国申請の終了日が予定のまま残っているので直すべき（2026-08-20 追加）。 */}
                        {(w.hkEarlyReturnDays || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`帰国申請の期間内に出勤打刻が ${w.hkEarlyReturnDays}日 あります（${w.hkEarlyReturnFirstDate} から復帰済み）。給与は打刻どおり計算していますが、休暇管理の帰国申請の「最終帰国日」を実際の復帰前日に直してください。`}
                          >
                            早期復帰{w.hkEarlyReturnDays}日
                          </span>
                        )}
                        {/* 夜勤の 1.5人工 が法定割増を下回った場合の警告。
                            日曜（法定休日）の夜勤や長時間の通し勤務で発生する。 */}
                        {(w.legalShortfall || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`夜勤日の法定必要額 ¥${Math.ceil(w.legalRequiredPay || 0).toLocaleString()} に対し支給 ¥${(w.nightShiftPaid || 0).toLocaleString()}。¥${(w.legalShortfall || 0).toLocaleString()} 不足しています（日曜の夜勤 または 長時間の通し勤務）。1.5人工の慣例では法定割増を満たさないケースです。`}
                          >
                            法定不足 ¥{(w.legalShortfall || 0).toLocaleString()}
                          </span>
                        )}
                        {/* 2026-09-30: 日本人は日曜の割増なし（代表決定）。ただし週に休みが無いまま日曜に出た日は
                            法律上の割増が要るので知らせる（支給額は変えない） */}
                        {(w.sundayNoRestDays?.length || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`${(w.sundayNoRestDays || []).join('・')}日の日曜は、前の6日すべて出勤しています（その週に休みがありません）。この場合の日曜出勤は法定休日の労働になり、35%の割増が法律上必要です。日比では日本人の日曜割増を付けない運用のため、支給額には入れていません。振替休日を取らせるか、キャシュモ・社労士に扱いを確認してください。`}
                          >
                            休みなし週の日曜 {(w.sundayNoRestDays || []).join('・')}日
                          </span>
                        )}
                        {/* 2026-09-15: 旧ルール（固定月給）の人は計算の形が違うので、名前の横で分かるようにする */}
                        {w.useOldRules && w.visa !== 'none' && (
                          <span
                            className="ml-1.5 text-3xs bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`旧ルール（固定月給）で計算しています。\n・所定日数は会社の所定日数（${w.workerPrescribedDays ?? '—'}日）が基準（現場カレンダーではない）\n・現場都合休は一旦1日分を「補償日控除」し、60%を「休業補償」で戻す（正味40%減）\n・最低20日保証の対象外\n・フォン・タンは2026年12月頃に新ルールで契約更新予定、フンは2027年1月退職で旧ルールは終了`}
                          >
                            旧ルール
                          </span>
                        )}
                        {/* 「22時以降は必ず夜勤」の運用ルールから外れた日の検出。
                            残業欄だけに長時間が入っていると深夜割増も1.5人工も付かない。 */}
                        {(w.lateNightRiskDays || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`残業時間から逆算すると22時を超えている日が ${w.lateNightRiskDays}日 ありますが、夜勤として登録されていません。22時以降の労働は夜勤（1.5人工）で登録する運用です。出面画面で確認してください。`}
                          >
                            夜勤未登録{w.lateNightRiskDays}日
                          </span>
                        )}
                        {/* 2026-09-13: 配置現場カレンダーの稼働日に出面が無い日。閑散期に「現場都合休(0.6)」の
                              入れ忘れがそのまま100%の欠勤控除になる事故を防ぐための警告（計算は変えない） */}
                        {/* 2026-09-30: 「その他」の休みでメモが「60%」「現場」など＝会社の都合の休みの選び間違いの疑い */}
                        {(w.suspectCompRestDays?.length || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`${(w.suspectCompRestDays || []).join('・')}日は「その他」の休み（欠勤）で登録されていますが、メモが会社都合（60%・現場休みなど）を指しています。会社の都合の休みなら、出面を「0.6補」に直してください。このままだと欠勤として計算されます。`}
                          >
                            会社都合の休み？ {(w.suspectCompRestDays || []).join('・')}日
                          </span>
                        )}
                        {/* 2026-09-30: 自分の都合の休みの日に、同じ現場でほかの人が0.6補（人数調整）＝取り違えの疑い */}
                        {(w.restMismatchDays?.length || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs px-1.5 py-0.5 rounded-full font-bold align-middle bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                            title={`${(w.restMismatchDays || []).join('・')}日は「自分の都合の休み」ですが、同じ日に同じ現場でほかの人が現場休み（0.6補）です。人数調整で休ませたのなら、出面を「0.6補」に直してください。このままだと${w.useOldRules ? '欠勤として控除されます' : '欠勤として最低保証から引かれます'}。`}
                          >
                            休みの区別？ {(w.restMismatchDays || []).join('・')}日
                          </span>
                        )}
                        {/* 2026-09-30: 本人の出面確認（スタッフのスマホ）。連絡は押すと中身を見て対応済みにできる */}
                        {staffConfirms[w.id] && (
                          <StaffConfirmBadge info={staffConfirms[w.id]} workerId={w.id} workerName={w.name} ym={ym}
                            password={password} canResolve={canResolveConfirm} onChanged={() => setConfirmsVersion(v => v + 1)} />
                        )}
                        {(w.calendarBlankDays || 0) > 0 && (
                          <span
                            className="ml-1.5 text-3xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`配置現場のカレンダーでは稼働日なのに出面に何も記録が無い日が ${w.calendarBlankDays}日 あります。現場都合の休みなら「0.6補」、本人都合なら「欠」を入力してください。空欄のままだと欠勤（100%控除）として計算されます。`}
                          >
                            稼働日未入力{w.calendarBlankDays}日
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{orgBadge(w.org)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {w.sites.map((s, i) => {
                            const colors = [
                              'bg-blue-100 text-blue-700',
                              'bg-teal-100 text-teal-700',
                              'bg-indigo-100 text-indigo-700',
                              'bg-pink-100 text-pink-700',
                              'bg-amber-100 text-amber-700',
                            ]
                            return (
                              <span key={i} className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${colors[i % colors.length]}`}>
                                {(() => { const nm = data?.siteNames?.[s] || s; return nm.slice(0, 2) })()}
                              </span>
                            )
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <div>{w.workAll % 1 !== 0 ? w.workAll.toFixed(1) : w.workAll}</div>
                        {hasComp && (
                          <div className="text-3xs text-gray-400">うち補{(compDays * 0.6).toFixed(1)}</div>
                        )}
                        {/* 夜勤: 出勤日数と人工がズレるため人工を併記（夜勤1回=1.5人工） */}
                        {(w.nightShiftDays || 0) > 0 && (
                          <div
                            className="text-3xs text-indigo-600 font-bold leading-tight"
                            title={`夜勤 ${w.nightShiftDays}回（実労働 ${fmtNum(w.nightShiftHours || 0)}h）。人工 ${w.manDays} 人工で支給・元請け請求`}
                          >
                            夜勤{w.nightShiftDays} / {w.manDays}人工
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {w.plDays > 0 ? w.plDays : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {displayOtHours(w) > 0 ? (
                          <span title={displayLegalOtHours(w) > 0 ? `所定外 ${fmtNum(displayOtHours(w))}h のうち、法定外(割増対象) ${fmtNum(displayLegalOtHours(w))}h` : undefined}>
                            {fmtNum(displayOtHours(w))}
                            {displayLegalOtHours(w) > 0 && (
                              <span className="block text-3xs text-gray-400 leading-tight">法定外 {fmtNum(displayLegalOtHours(w))}</span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                        {(w.salary || 0) > 0 ? (
                          <span title="完全月給（出勤日数に関わらず固定）">
                            {fmtYen(w.salary || 0)}
                            <span className="ml-1 text-3xs text-purple-600 dark:text-purple-300">月給</span>
                          </span>
                        ) : (
                          fmtYen(w.rate)
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                        {w.isDispatched ? (
                          <div>
                            <div className="text-purple-600 line-through text-xs text-gray-400">{fmtYen(Math.round(w.totalCost))}</div>
                            <div className="text-purple-700 font-bold">出向控除</div>
                            <div className="text-3xs text-purple-500">-{fmtYen(Math.round(w.dispatchDeduction || w.totalCost))}</div>
                          </div>
                        ) : (
                          fmtYen(Math.round(w.totalCost))
                        )}
                      </td>
                      {showAbsenceColumns && (
                        <>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-red-50/50 ${absentDays > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}
                            title="欠勤控除の日数 = 保証枠（min(20日, カレンダー所定)）に対する不足日数。2026年8月分から、現場都合休（0.6補償）は保証枠に届くまで出勤と同じく100%支給し、枠を超えた補償日だけ休業手当60%を足します。控除されるのは本人都合の欠勤などで枠に届かなかった日数です。実労働時間明細の「欠勤日数」は「欠」の記録だけを数えます">
                            {absentDays > 0 ? absentDays : '—'}
                            {/* 2026-09-11: 奥寺さん質問対応。実労働時間明細の「欠勤日数」（欠の記録のみ）と
                                  ここの日数（20日枠の不足＝欠＋補償日＋その他不足）が食い違って見えるため内訳を併記 */}
                            {w.useOldRules && w.visa !== 'none' && (
                              <div className="text-3xs text-gray-400 font-normal whitespace-nowrap">所定{w.workerPrescribedDays ?? '—'}日基準</div>
                            )}
                            {!w.useOldRules && absentDays > 0 && ((w.restDays || 0) > 0 || compDays > 0) && (
                              <div className="text-3xs text-gray-400 font-normal whitespace-nowrap">
                                欠{w.restDays || 0}{compDays > 0 ? `・補${compDays}` : ''}
                                {absentDays - (w.restDays || 0) - compDays > 0 ? `・他${absentDays - (w.restDays || 0) - compDays}` : ''}
                              </div>
                            )}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-red-50/50 ${absentDeduction > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {absentDeduction > 0 ? `-${fmtYen(absentDeduction)}` : '—'}
                            {/* 旧ルール: 本人欠勤の控除と補償日控除の合計なので内訳を出す（2026-09-15） */}
                            {w.useOldRules && w.visa !== 'none' && absentDeduction > 0 && (
                              <div className="text-3xs text-gray-400 font-normal whitespace-nowrap">
                                欠勤{fmtYen(w.absentDeduction || 0)}＋補償日{fmtYen(w.compBaseDeduction || 0)}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums bg-red-50/50 font-medium">
                            {fmtYen(netPay)}
                          </td>
                        </>
                      )}
                      {showSalaryColumns && (
                        <>
                          <td className="px-3 py-2.5 text-right tabular-nums bg-green-50/50 text-gray-600">
                            {w.fixedBasePay != null && w.fixedBasePay > 0 ? fmtYen(w.fixedBasePay) : w.basePay != null && w.basePay > 0 ? fmtYen(w.basePay) : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.additionalAllowance || 0) > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                            {w.visa !== 'none' && (w.additionalAllowance || 0) > 0 ? fmtYen(w.additionalAllowance!) : '—'}
                            {/* 旧ルールの行はこの列に休業補償（補償日×日給×60%）が入る（2026-09-15 表示の明確化） */}
                            {w.useOldRules && w.visa !== 'none' && (w.additionalAllowance || 0) > 0 && (
                              <div className="text-3xs text-gray-400 font-normal whitespace-nowrap">休業補償（補償日×60%）</div>
                            )}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.paidLeaveAllowance || 0) > 0 ? 'text-violet-600' : 'text-gray-400'}`}
                            title={(w.paidLeaveDays || 0) > 0 ? `有給 ${w.paidLeaveDays}日分` : ''}>
                            {(w.paidLeaveAllowance || 0) > 0 ? fmtYen(w.paidLeaveAllowance!) : '—'}
                          </td>
                          {/* 2026-06-XX 追加 (I-2): 所定外労働手当 列（新ルール時のみ） */}
                          {ym >= '202605' && (
                            <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.nonStatutoryOTAllowance || 0) > 0 ? 'text-cyan-600' : 'text-gray-400'}`}
                              title={`所定外労働 ${w.nonStatutoryOTHours || 0}h × 通常賃金（割増なし）`}>
                              {w.visa !== 'none' && (w.nonStatutoryOTAllowance || 0) > 0 ? fmtYen(w.nonStatutoryOTAllowance!) : '—'}
                            </td>
                          )}
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.otAllowance || 0) > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                            {(w.otAllowance || 0) > 0 ? fmtYen(w.otAllowance!) : '—'}
                          </td>
                          {ym >= '202605' && (
                            <>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.legalHolidayAllowance || 0) > 0 ? 'text-pink-600' : 'text-gray-400'}`}>
                                {/* 2026-08-13: 日本人にも法定休日割増を実装したので visa のゲートを外した */}
                                {(w.legalHolidayAllowance || 0) > 0 ? fmtYen(w.legalHolidayAllowance!) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.nightAllowance || 0) > 0 ? 'text-purple-600' : 'text-gray-400'}`}>
                                {w.visa !== 'none' && (w.nightAllowance || 0) > 0 ? fmtYen(w.nightAllowance!) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.compAllowance || 0) > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                                {w.visa !== 'none' && (w.compAllowance || 0) > 0 ? fmtYen(w.compAllowance!) : '—'}
                              </td>
                            </>
                          )}
                          {showBreakShorten && (
                            <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.breakShortenAllowance || 0) > 0 ? 'text-cyan-600' : 'text-gray-400'}`}
                              title={(w.breakShortenAllowance || 0) > 0 ? `休憩短縮 ${w.breakShortenHours}h ぶんの所定外労働（残業単価・25%割増）` : undefined}>
                              {(w.breakShortenAllowance || 0) > 0 ? fmtYen(w.breakShortenAllowance!) : '—'}
                            </td>
                          )}
                          {showAllowance && (
                            <>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.siteAllowance || 0) > 0 ? 'text-teal-600' : 'text-gray-400'}`}
                                title={(w.siteAllowance || 0) > 0 ? `遠方現場日当 対象 ${w.allowanceDays || 0}日` : undefined}>
                                {(w.siteAllowance || 0) > 0 ? fmtYen(w.siteAllowance!) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.driveAllowance || 0) > 0 ? 'text-teal-600' : 'text-gray-400'}`}
                                title={(w.driveAllowance || 0) > 0 ? `運転 ${w.driveLegs || 0}便（行き・帰り合計）` : undefined}>
                                {(w.driveAllowance || 0) > 0 ? fmtYen(w.driveAllowance!) : '—'}
                              </td>
                            </>
                          )}
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.absentDeduction || 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {w.visa !== 'none' && (w.absentDeduction || 0) > 0 ? `-${fmtYen(w.absentDeduction!)}` : '—'}
                            {w.useOldRules && w.visa !== 'none' && (w.absentDeduction || 0) > 0 && (
                              <div className="text-3xs text-gray-400 font-normal whitespace-nowrap">本人欠勤{w.absence}日分</div>
                            )}
                          </td>
                          {showCompBaseDeduction && (
                            <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.compBaseDeduction || 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}
                              title="補償日の通常分控除。60%は休業補償で還元（正味 日給の40%控除＝60%支給）">
                              {(w.compBaseDeduction || 0) > 0 ? `-${fmtYen(w.compBaseDeduction!)}` : '—'}
                            </td>
                          )}
                          <td className="px-3 py-2.5 text-right tabular-nums bg-green-50/50 font-medium">
                            {w.salaryNetPay != null && w.salaryNetPay > 0 ? fmtYen(w.salaryNetPay) : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })
              )}
            </tbody>
            {sortedWorkers.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold text-hibi-navy dark:text-white">
                  <td className="px-3 py-3 sticky left-0 bottom-0 z-30 bg-gray-50 dark:bg-gray-700 border-r border-gray-200 dark:border-gray-600 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]">合計 ({filteredWorkers.length}名)</td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3"></td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3"></td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums">{workerTotals.workAll % 1 !== 0 ? workerTotals.workAll.toFixed(1) : workerTotals.workAll}</td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums">{fmtNum(workerTotals.plDays)}</td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums">{fmtNum(workerTotals.otHours)}</td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right">—</td>
                  <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums">
                    {workerTotals.dispatchDeduction > 0 ? (
                      <div>
                        <div>{fmtYen(Math.round(workerTotals.totalCost))}</div>
                        <div className="text-3xs text-purple-600 font-normal">
                          出向控除 -{fmtYen(Math.round(workerTotals.dispatchDeduction))}
                        </div>
                      </div>
                    ) : (
                      fmtYen(Math.round(workerTotals.totalCost))
                    )}
                  </td>
                  {showAbsenceColumns && (
                    <>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-red-50/50">
                        {(() => {
                          const totalAbsent = filteredWorkers.reduce((s, w) => s + calcAbsentDays(w), 0)
                          return totalAbsent > 0 ? Math.round(totalAbsent * 10) / 10 : '—'
                        })()}
                      </td>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-red-50/50 text-red-600">
                        {(() => {
                          const totalDeduction = filteredWorkers.reduce((s, w) => s + calcAbsentDeduction(w), 0)
                          return totalDeduction > 0 ? `-${fmtYen(totalDeduction)}` : '—'
                        })()}
                      </td>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-red-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + calcNetPay(w), 0))}
                      </td>
                    </>
                  )}
                  {showSalaryColumns && (
                    <>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0))}
                      </td>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalAddAllow = filteredWorkers.reduce((s, w) => s + (w.additionalAllowance || 0), 0)
                          return totalAddAllow > 0 ? fmtYen(totalAddAllow) : '—'
                        })()}
                      </td>
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalPl = filteredWorkers.reduce((s, w) => s + (w.paidLeaveAllowance || 0), 0)
                          return totalPl > 0 ? fmtYen(totalPl) : '—'
                        })()}
                      </td>
                      {/* 2026-06-XX 追加 (I-2): 所定外労働手当 合計列 */}
                      {ym >= '202605' && (
                        <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                          {(() => {
                            const total = filteredWorkers.reduce((s, w) => s + (w.nonStatutoryOTAllowance || 0), 0)
                            return total > 0 ? fmtYen(total) : '—'
                          })()}
                        </td>
                      )}
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalOtAllow = filteredWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0)
                          return totalOtAllow > 0 ? fmtYen(totalOtAllow) : '—'
                        })()}
                      </td>
                      {ym >= '202605' && (
                        <>
                          <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.legalHolidayAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                          <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.nightAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                          <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.compAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                        </>
                      )}
                      {showBreakShorten && (
                        <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                          {(() => {
                            const total = filteredWorkers.reduce((s, w) => s + (w.breakShortenAllowance || 0), 0)
                            return total > 0 ? fmtYen(total) : '—'
                          })()}
                        </td>
                      )}
                      {showAllowance && (
                        <>
                          <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.siteAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                          <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.driveAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                        </>
                      )}
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50 text-red-600">
                        {(() => {
                          const totalAbsDed = filteredWorkers.reduce((s, w) => s + (w.absentDeduction || 0), 0)
                          return totalAbsDed > 0 ? `-${fmtYen(totalAbsDed)}` : '—'
                        })()}
                      </td>
                      {showCompBaseDeduction && (
                        <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50 text-red-600">
                          {(() => {
                            const total = filteredWorkers.reduce((s, w) => s + (w.compBaseDeduction || 0), 0)
                            return total > 0 ? `-${fmtYen(total)}` : '—'
                          })()}
                        </td>
                      )}
                      <td className="sticky bottom-0 z-20 bg-gray-50 dark:bg-gray-700 px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0))}
                      </td>
                    </>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      </>}

      {/* 給与計算根拠モーダル（透明化・監査用） */}
      {auditingWorker && (
        <PayrollAuditModal
          worker={auditingWorker}
          ym={ym}
          prescribedDays={data?.prescribedDays ?? (Number(prescribedDays) || 0)}
          baseDays={data?.baseDays ?? 20}
          onClose={() => setAuditingWorker(null)}
        />
      )}
    </div>
  )
}

