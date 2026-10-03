'use client'

// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams } from 'next/navigation'
import { confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { AttendanceEntry, AttendanceStatus, isTimeBasedMobile, isTimeBasedEntry } from '@/types'
import CalendarApprovalModal, { type PendingCalendarData } from '@/components/attendance/CalendarApprovalModal'
import LeaveRequestModal from '@/components/attendance/LeaveRequestModal'
import HomeLongLeaveModal from '@/components/attendance/HomeLongLeaveModal'
import RestReportModal, { COMPANY_REST } from '@/components/attendance/RestReportModal'
import MonthConfirmCard from '@/components/attendance/MonthConfirmCard'
import { leaveRequestEarliestDate } from '@/lib/leave-rules'
import { todayJstIso } from '@/lib/date-utils'
import { STAFF_STATUS_BI, STAFF_TEXT, biLine, staffBreakShortenTag } from '@/lib/labels'
import StaffHeader from '@/components/StaffHeader'
import { Icon, type IconName } from '@/components/ui/Icon'
import { Modal, CancelButton } from '@/components/ui/Modal'

interface SiteBreakConfig {
  enabled: boolean
  minutes: number
  mandatory: boolean
}
interface SiteWorkScheduleConfig {
  startTime: string
  endTime: string
  morningBreak: SiteBreakConfig
  lunchBreak: SiteBreakConfig
  afternoonBreak: SiteBreakConfig
}
/** 失敗の帯の文面（スタッフ向けは日越並記。lib/notify.ts の定型は日本語だけなのでここで並記にする） */
const BI_SERVER_REFUSED = 'サーバが受け付けませんでした / Máy chủ không chấp nhận'
const BI_NET_FAILED = '通信がとぎれました。電波のよい所でもう一度お試しください。\nMất kết nối. Hãy thử lại ở nơi có sóng tốt.'
const BI_CANCEL_FAILED = '取り消しできませんでした / Không hủy được'
const BI_SAVE_FAILED = '保存できませんでした / Không lưu được'

const DEFAULT_WORK_SCHEDULE: SiteWorkScheduleConfig = {
  startTime: '08:00',
  endTime: '17:00',
  morningBreak:   { enabled: true, minutes: 30, mandatory: false },
  lunchBreak:     { enabled: true, minutes: 60, mandatory: true },
  afternoonBreak: { enabled: true, minutes: 30, mandatory: false },
}

interface SiteInfo { id: string; name: string; workSchedule?: SiteWorkScheduleConfig | null }
interface AvailableSite { id: string; name: string; primary: boolean }

interface StaffData {
  worker: { id: number; name: string; nameVi?: string; visaType?: string }
  site: SiteInfo
  allSites: SiteInfo[]
  availableSites?: AvailableSite[]
  unassigned?: boolean  // 2026-07-22: 現場未配置（新入社員が配置前）。現場選択を促す
  today: { year: number; month: number; day: number; ym: string; dateLabel: string }
  currentEntry: AttendanceEntry | null
  currentStatus: AttendanceStatus
  todayLocked: boolean
  toolBudgetRemaining: number | null
  toolBudgetPeriodStart?: string | null
  /** 前の期間からの繰越（マイナスは使いすぎの持ち越し） */
  toolBudgetCarry?: number
  toolBudgetPeriodEnd: string | null
  plRemaining: number | null
  /** 期が終わって次の付与がまだ（申請は止まる・2026-10-02） */
  plPeriodOver?: boolean
  /** 自分の都合で1日休むと減る給料の目安（円・新ルールの時給制のみ） */
  absenceDayPay?: number | null
  /** 休憩短縮（旧契約の毎日20分など）。出面には記録せず給与計算で足す分（2026-09-30） */
  breakShorten?: { min: number; from: string } | null
  plExpiryDate: string | null
  // Phase 8: FIFO内訳
  plCarryOverRemaining?: number | null
  plCarryOverExpiryDate?: string | null
  plCarryOverExpiryStatus?: 'ok' | 'warning' | 'expired' | null
  plGrantRemaining?: number | null
  plGrantExpiryDate?: string | null
  pastDays: {
    date: string; year: number; month: number; day: number
    entry: AttendanceEntry | null; status: AttendanceStatus
    locked: boolean; dayOffset: number
    siteName?: string
  }[]
  /** 過去14日の未入力稼働日（督促バナー用・2026-08-28 追加） */
  missingDays: {
    date: string; year: number; month: number; day: number
    entry: null; status: 'none'; locked: boolean; dayOffset: number; siteName: string
  }[]
}

// 状態の文言は日越並記（2026-10-02 総合点検。旧: 日本語だけの STATUS_LABELS がここにあり、最近5日と承認済みの今日が日本語のみだった）
//   文言は lib/labels.ts の STAFF_STATUS_BI
// 絵文字はやめて線のアイコン（2026-10-01 UI改修・PCの画面とそろえる）
const STATUS_ICON: Record<AttendanceStatus, IconName | null> = {
  work: 'site', overtime: 'site', rest: 'home', leave: 'umbrella', site_off: 'calendar',
  home_leave: 'plane', exam: 'pen', comp: 'calendar', none: null,
}
function StatusLabel({ s, size = 13 }: { s: AttendanceStatus; size?: number }) {
  const icon = STATUS_ICON[s]
  return <span className="inline-flex items-center gap-1">{icon && <Icon name={icon} size={size} strokeWidth={2} />}{biLine(STAFF_STATUS_BI[s])}</span>
}

/**
 * 押した場所の近くに出す保存の結果（2026-10-02 総合点検）。
 * 旧: 成功の「✓」は画面の一番上に1.5秒、失敗の赤帯も一番上に3秒だけで、ボタンまでスクロールした人には見えず、
 *     過去の日の修正モーダル（黒幕の z-50）では赤帯が幕の裏に隠れていた。
 * 新: where='today' は出勤登録ボタンの直上、where='past' は修正モーダルの中（成功で閉じたあとは最近5日の上）に出す。
 *     失敗は自動で消さず、次の操作の開始か成功で消す。
 */
interface ActionMsg { kind: 'ok' | 'err'; text: string; where: 'today' | 'past' }
const STATUS_COLORS: Record<AttendanceStatus, string> = {
  work: 'bg-blue-100 text-blue-700', overtime: 'bg-orange-100 text-orange-700',
  rest: 'bg-gray-200 text-gray-600', leave: 'bg-green-100 text-green-700',
  site_off: 'bg-yellow-100 text-yellow-700',
  home_leave: 'bg-cyan-100 text-cyan-700', exam: 'bg-purple-100 text-purple-700',
  comp: 'bg-yellow-100 text-yellow-700',
  none: 'bg-red-50 text-red-400',
}

// REST_REASONS は components/attendance/RestReportModal.tsx に集約

interface LeaveRequestData {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled' | 'revoked'
  reason: string
  rejectedReason?: string
  requestedAt: string
}

export default function StaffAttendancePage() {
  const params = useParams()
  const token = params.token as string

  const [data, setData] = useState<StaffData | null>(null)
  // 表示中の現場。state ではなく ref（2026-10-02 総合点検）。
  //   旧: 1回目の応答で setSiteId すると fetchData が作り直されて useEffect がもう一度走り、開くたびに同じ重い GET が2回走っていた。
  //   2回目の応答が入力中の始業・終業・休憩を初期値に戻す競合もあった。
  const siteIdRef = useRef<string | null>(null)
  // 取得の連番。古い応答（現場を切り替えた直後など）は捨てる
  const fetchSeqRef = useRef(0)
  const dataRef = useRef<StaffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOT, setShowOT] = useState(false)
  const [otHours, setOtHours] = useState(1.0)
  const [editingPast, setEditingPast] = useState<number | null>(null)
  const [actionMsg, setActionMsg] = useState<ActionMsg | null>(null)
  const actionMsgSeqRef = useRef(0)
  /** 成功の印は押した場所の近くに数秒、失敗は消さない */
  const showActionMsg = (m: ActionMsg) => {
    const seq = ++actionMsgSeqRef.current
    setActionMsg(m)
    if (m.kind === 'ok') setTimeout(() => { if (actionMsgSeqRef.current === seq) setActionMsg(null) }, 3000)
  }
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [leaveDateFrom, setLeaveDateFrom] = useState('')
  const [leaveDateTo, setLeaveDateTo] = useState('')
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestData[]>([])
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [leaveSuccess, setLeaveSuccess] = useState<string | null>(null)

  // Home long leave modal state
  const [showHomeLongLeaveModal, setShowHomeLongLeaveModal] = useState(false)
  const [hlStartDate, setHlStartDate] = useState('')
  const [hlEndDate, setHlEndDate] = useState('')
  const [hlReason, setHlReason] = useState('一時帰国')
  const [hlNote, setHlNote] = useState('')
  const [hlRequests, setHlRequests] = useState<{id:string;startDate:string;endDate:string;reason:string;status:string;rejectedReason?:string}[]>([])
  const [hlSubmitting, setHlSubmitting] = useState(false)
  const [hlError, setHlError] = useState<string | null>(null)
  const [hlSuccess, setHlSuccess] = useState<string | null>(null)

  // Absence report modal state
  const [showRestModal, setShowRestModal] = useState(false)
  const [restReason, setRestReason] = useState('sick')
  const [restNote, setRestNote] = useState('')
  // 欠勤届の対象日 (YYYY-MM-DD)。デフォルトは今日、未来の日付も選択可
  const [restDate, setRestDate] = useState('')
  // 過去の日から開いた欠勤届（日付を固定・最小日をその日に）
  const [restLockDate, setRestLockDate] = useState(false)
  // 欠勤届から「有給を申請する」を選んだときの日付（有給モーダルの初期値）
  const leavePresetDate = useRef<string | null>(null)

  // ── 翌月カレンダー承認用 state（2026-05-27 追加） ──
  // 旧 /calendar/public は「名前を選んで」方式で他人になりすませる脆弱性があったため、
  // 本人のトークン認証ページで承認できる新フローを実装。
  // 型は components/attendance/CalendarApprovalModal に集約
  // 今月と翌月の両方をチェックする（typhoon 等で当月カレンダー修正後の再署名にも対応）
  const [pendingCalendars, setPendingCalendars] = useState<PendingCalendarData[]>([])
  // モーダルで表示中のカレンダー（複数月ある場合の選択用）
  const [activePendingCalendar, setActivePendingCalendar] = useState<PendingCalendarData | null>(null)
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [calendarReviewed, setCalendarReviewed] = useState(false)  // 「確認した」チェック
  const [signingCalendar, setSigningCalendar] = useState(false)
  const [calendarSuccessMsg, setCalendarSuccessMsg] = useState<string | null>(null)
  const [calendarErrorMsg, setCalendarErrorMsg] = useState<string | null>(null)

  // 現場の勤務時間設定（API経由で取得、未設定なら DEFAULT_WORK_SCHEDULE）
  const workSchedule: SiteWorkScheduleConfig = data?.site?.workSchedule || DEFAULT_WORK_SCHEDULE

  // Time-based input state (202605~)
  const [startTime, setStartTime] = useState(workSchedule.startTime)
  const [endTime, setEndTime] = useState(workSchedule.endTime)
  // 休憩のチェック状態（mandatory:true の場合は常にtrue扱い）
  const [break1, setBreak1] = useState(true)  // 午前休憩
  const [break2, setBreak2] = useState(true)  // 昼休憩
  const [break3, setBreak3] = useState(true)  // 午後休憩

  // Time-based input for past day editing
  const [pastStartTime, setPastStartTime] = useState(workSchedule.startTime)
  const [pastEndTime, setPastEndTime] = useState(workSchedule.endTime)
  const [pastBreak1, setPastBreak1] = useState(true)
  const [pastBreak2, setPastBreak2] = useState(true)
  const [pastBreak3, setPastBreak3] = useState(true)

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    try {
      const siteId = siteIdRef.current
      const url = siteId
        ? `/api/attendance/staff?token=${token}&siteId=${siteId}`
        : `/api/attendance/staff?token=${token}`
      const res = await fetch(url)
      if (seq !== fetchSeqRef.current) return  // もっと新しい取得が走っている
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || biLine(STAFF_TEXT.error))
        return
      }
      const d: StaffData = await res.json()
      if (seq !== fetchSeqRef.current) return
      setData(d)
      dataRef.current = d
      siteIdRef.current = d.site.id
      // 取れたら前の失敗の帯は消す（旧: 一度出た「つうしん エラー」が成功後も残った）
      setError(null)

      // Restore OT state from current entry
      if (d.currentEntry?.w === 1 && d.currentEntry.o && d.currentEntry.o > 0) {
        setShowOT(true)
        setOtHours(d.currentEntry.o)
      } else {
        setShowOT(false)
        setOtHours(1.0)
      }

      // Restore time-based state from current entry
      // 現場の勤務時間設定をデフォルトとして使用（未設定ならDEFAULT_WORK_SCHEDULE）
      const ws: SiteWorkScheduleConfig = d.site?.workSchedule || DEFAULT_WORK_SCHEDULE
      if (d.currentEntry && isTimeBasedEntry(d.currentEntry)) {
        setStartTime(d.currentEntry.st || ws.startTime)
        setEndTime(d.currentEntry.et || ws.endTime)
        // 午前・午後は既存エントリのチェック状態を復元（無効な現場ならfalse）
        setBreak1(ws.morningBreak.enabled ? d.currentEntry.b1 === 1 : false)
        setBreak3(ws.afternoonBreak.enabled ? d.currentEntry.b3 === 1 : false)
        // 昼休憩はUIに表示しない: enabledなら必ず取得扱い
        setBreak2(ws.lunchBreak.enabled)
      } else {
        setStartTime(ws.startTime)
        setEndTime(ws.endTime)
        // 初期値: 有効な休憩はチェック済み
        setBreak1(ws.morningBreak.enabled)
        setBreak2(ws.lunchBreak.enabled)
        setBreak3(ws.afternoonBreak.enabled)
      }
    } catch {
      if (seq === fetchSeqRef.current) setError(biLine(STAFF_TEXT.connError))
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchData() }, [fetchData])

  // 画面に戻ってきたとき、日本時間の今日が表示中の「今日」と違えば取り直す（2026-10-02 総合点検）。
  //   旧: ホーム画面に入れたアプリを前日から開きっぱなしにして翌朝「出勤登録」を押すと、
  //       読み込み時の data.today（前日）で保存され、前日が上書き・今日は未入力のままになった。
  const todayIsoOf = (d: StaffData | null) =>
    d ? `${d.today.year}-${String(d.today.month).padStart(2, '0')}-${String(d.today.day).padStart(2, '0')}` : null
  useEffect(() => {
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const cur = dataRef.current
      if (cur && todayIsoOf(cur) !== todayJstIso()) fetchData()
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
    }
  }, [fetchData])

  // ── カレンダー承認状況を取得（2026-05-27 追加 / 2026-06-XX 拡張） ──
  // 今月＋翌月の 2 ヶ月分を取得して、承認が必要な月を全て表示する。
  // - 翌月: 通常の月次承認フロー（既存）
  // - 今月: 台風等で承認後にカレンダーが修正された場合の再署名フロー
  // 注意: 日本人スタッフは API 側で 400 を返す→無駄な fetch を防ぐためクライアント側でガード
  const fetchPendingCalendar = useCallback(async () => {
    if (!token) return
    if (!data?.worker?.visaType || data.worker.visaType === 'none') {
      setPendingCalendars([])
      return
    }
    // 今月と翌月の ym (YYYY-MM)
    const now = new Date()
    const thisYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const nextYm = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}`
    try {
      const [thisRes, nextRes] = await Promise.all([
        fetch(`/api/calendar/my-pending?token=${token}&ym=${thisYm}`),
        fetch(`/api/calendar/my-pending?token=${token}&ym=${nextYm}`),
      ])
      const results: PendingCalendarData[] = []
      if (thisRes.ok) results.push(await thisRes.json())
      if (nextRes.ok) results.push(await nextRes.json())
      setPendingCalendars(results)
    } catch {
      setPendingCalendars([])
    }
  }, [token, data?.worker?.visaType])

  useEffect(() => { fetchPendingCalendar() }, [fetchPendingCalendar])

  // カレンダー承認のサブミット（本人のトークンで自分自身としてサイン）
  // モーダルで開いている月の「未署名 OR 再署名要」の現場を一括サイン
  //   consentName: 同意セレモニーで本人が入力した氏名（本人同意の証跡）
  const submitCalendarSign = useCallback(async (consentName: string): Promise<boolean> => {
    if (!activePendingCalendar || signingCalendar) return false
    const ym = activePendingCalendar.ym
    // 未署名と「再署名要 (needsResign)」の両方を対象に
    const targetSiteIds = activePendingCalendar.sites
      .filter(s => s.status === 'approved' && (!s.signed || s.needsResign))
      .map(s => s.siteId)
    if (targetSiteIds.length === 0) return false
    setSigningCalendar(true)
    setCalendarErrorMsg(null)
    try {
      const res = await fetch('/api/calendar/sign-self', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ym, siteIds: targetSiteIds, consentName }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setCalendarErrorMsg(json.error || 'サインに失敗しました / Lỗi khi ký')
        setSigningCalendar(false)
        return false
      }
      setCalendarSuccessMsg(`✓ ${json.signedCount}件のカレンダーを承認しました / Đã ký ${json.signedCount} lịch`)
      setShowCalendarModal(false)
      setActivePendingCalendar(null)
      setCalendarReviewed(false)
      await fetchPendingCalendar()
      setTimeout(() => setCalendarSuccessMsg(null), 4000)
      return true
    } catch {
      setCalendarErrorMsg('通信エラー / Lỗi kết nối')
      return false
    } finally {
      setSigningCalendar(false)
    }
  }, [token, activePendingCalendar, signingCalendar, fetchPendingCalendar])

  // カレンダーへの質問・異議を送信（承認とは独立）
  const submitCalendarQuestion = useCallback(async (message: string): Promise<boolean> => {
    if (!activePendingCalendar) return false
    try {
      const res = await fetch('/api/calendar/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ym: activePendingCalendar.ym, message }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [token, activePendingCalendar])

  // Fetch leave requests when modal opens
  const fetchLeaveRequests = useCallback(async () => {
    try {
      const res = await fetch(`/api/leave-request?token=${token}`)
      if (res.ok) {
        const d = await res.json()
        setLeaveRequests(d.requests || [])
      }
    } catch { /* ignore */ }
  }, [token])
  // 申請の状況は開いたときにも1回取る（2026-10-02 総合点検）。
  //   旧: 有給モーダルを開くまで取らなかったので、画面の「有給申請の状況」は開き直すたびに空で、却下にも気づけなかった。
  //   重い出面の GET を1回に減らした分で相殺する（この GET は本人の申請だけの小さな読み）
  useEffect(() => { fetchLeaveRequests() }, [fetchLeaveRequests])

  // 有給申請の取り消し（pendingのみ可能）
  const cancelLeaveRequest = async (requestId: string) => {
    if (!(await confirmDanger({
      title: 'この申請を取り消しますか？',
      confirmLabel: '取り消す',
      cancelLabel: 'やめる',
      vi: {
        title: 'Bạn có chắc muốn hủy đơn này không?',
        description: 'Không thể hoàn tác.',
        confirmLabel: 'Hủy đơn',
        cancelLabel: 'Không',
      },
    }))) return
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId, token }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        notify.error(BI_CANCEL_FAILED, errData.error || BI_SERVER_REFUSED)
        return
      }
      fetchLeaveRequests()
    } catch {
      notify.error(biLine(STAFF_TEXT.connError), BI_NET_FAILED)
    }
  }

  // 過去日編集モーダルの対象一覧。
  //   先頭5件は「最近5日」リストと同じ index。6件目以降は督促バナー専用
  //   （5日より前の未入力日をチップから直接開くため・2026-08-28 追加）
  const allPastDays = useMemo(() => data
    ? [...data.pastDays, ...(data.missingDays || []).filter(md => md.dayOffset > 5)]
    : [], [data])

  // Initialize past day time state when edit modal opens
  useEffect(() => {
    if (editingPast !== null && allPastDays[editingPast]) {
      const pd = allPastDays[editingPast]
      const ws: SiteWorkScheduleConfig = data?.site?.workSchedule || DEFAULT_WORK_SCHEDULE
      if (pd.entry && isTimeBasedEntry(pd.entry)) {
        setPastStartTime(pd.entry.st || ws.startTime)
        setPastEndTime(pd.entry.et || ws.endTime)
        setPastBreak1(ws.morningBreak.enabled ? pd.entry.b1 === 1 : false)
        setPastBreak3(ws.afternoonBreak.enabled ? pd.entry.b3 === 1 : false)
        // 昼休憩はUIに表示しない: enabledなら必ず取得扱い
        setPastBreak2(ws.lunchBreak.enabled)
      } else {
        setPastStartTime(ws.startTime)
        setPastEndTime(ws.endTime)
        setPastBreak1(ws.morningBreak.enabled)
        setPastBreak2(ws.lunchBreak.enabled)
        setPastBreak3(ws.afternoonBreak.enabled)
      }
    }
  }, [editingPast, data, allPastDays])

  useEffect(() => {
    if (showLeaveModal) {
      fetchLeaveRequests()
      // 既定は明日（欠勤届から来たときはその日）
      // 有給は前日まで（2026-09-30。旧: 5日後から）。端末の時差に左右されないよう日本時間で求める
      const [y, m, d] = leaveRequestEarliestDate(todayJstIso()).split('-')
      const preset = leavePresetDate.current
      leavePresetDate.current = null
      setLeaveDateFrom(preset || `${y}-${m}-${d}`)
      setLeaveDateTo(preset || `${y}-${m}-${d}`)
      setLeaveReason('')
      setLeaveError(null)
      setLeaveSuccess(null)
    }
  }, [showLeaveModal, fetchLeaveRequests])

  // Fetch home long leave requests when modal opens
  const fetchHlRequests = useCallback(async () => {
    try {
      const res = await fetch(`/api/home-long-leave?token=${token}`)
      if (res.ok) {
        const d = await res.json()
        setHlRequests(d.requests || [])
      }
    } catch { /* ignore */ }
  }, [token])

  // 帰国申請の取り消し（pendingのみ可能）
  const cancelHomeLongLeave = async (requestId: string) => {
    if (!(await confirmDanger({
      title: 'この帰国申請を取り消しますか？',
      confirmLabel: '取り消す',
      cancelLabel: 'やめる',
      vi: {
        title: 'Bạn có chắc muốn hủy đơn xin về nước này không?',
        description: 'Không thể hoàn tác.',
        confirmLabel: 'Hủy đơn',
        cancelLabel: 'Không',
      },
    }))) return
    try {
      const res = await fetch('/api/home-long-leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId, token }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        notify.error(BI_CANCEL_FAILED, errData.error || BI_SERVER_REFUSED)
        return
      }
      fetchHlRequests()
    } catch {
      notify.error(biLine(STAFF_TEXT.connError), BI_NET_FAILED)
    }
  }

  useEffect(() => {
    if (showHomeLongLeaveModal) {
      fetchHlRequests()
      // 出発日 = 最短申請日 (今日 + 90日)
      const min = getHlMinDate()
      setHlStartDate(min)
      // 帰国日 = 出発日 + 7日（1週間後）
      const endD = new Date(min + 'T00:00:00')
      endD.setDate(endD.getDate() + 7)
      setHlEndDate(`${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`)
      setHlReason('一時帰国')
      setHlNote('')
      setHlError(null)
      setHlSuccess(null)
    }
  }, [showHomeLongLeaveModal, fetchHlRequests])

  const submitHomeLongLeave = async (): Promise<boolean> => {
    if (!data || hlSubmitting || !hlStartDate || !hlEndDate) return false
    setHlSubmitting(true)
    setHlError(null)
    setHlSuccess(null)
    try {
      const res = await fetch('/api/home-long-leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          token,
          startDate: hlStartDate,
          endDate: hlEndDate,
          reason: hlReason,
          note: hlNote || undefined,
        }),
      })
      if (res.ok) {
        setHlSuccess('申請完了 / Đã gửi đơn')
        // 送ったあとは次の最短日に戻す（旧: 空にしていたので、画面は先頭の日付を見せるのに送信ボタンは押せないままだった）
        const min = getHlMinDate()
        setHlStartDate(min)
        setHlEndDate(addDaysLocal(min, 7))
        setHlReason('一時帰国')
        setHlNote('')
        fetchHlRequests()
        setTimeout(() => setHlSuccess(null), 3000)
        return true
      } else {
        const d = await res.json().catch(() => ({}))
        const msg = d.error === 'Already requested' ? '申請済みです / Đã gửi rồi'
          : d.error === 'Start date must be at least 90 days ahead' ? '原則3ヶ月以上先の日付を選んでください / Chọn ngày ít nhất 3 tháng sau'
          : d.error === 'Start date must be before end date' ? '帰国日は出発日より後にしてください / Ngày về phải sau ngày đi'
          : d.error || biLine(STAFF_TEXT.error)
        // 失敗の文は消さない（旧: 日越の長い文を3秒で消していた）。次に送るときに消える
        setHlError(msg)
        return false
      }
    } catch {
      setHlError(biLine(STAFF_TEXT.connError))
      return false
    } finally {
      setHlSubmitting(false)
    }
  }

  const getHlMinDate = () => {
    const minD = new Date()
    minD.setDate(minD.getDate() + 90)
    return `${minD.getFullYear()}-${String(minD.getMonth() + 1).padStart(2, '0')}-${String(minD.getDate()).padStart(2, '0')}`
  }
  /** 'YYYY-MM-DD' を端末のローカル日付で n 日ずらす（帰国日の既定 = 出発日 + 7日） */
  const addDaysLocal = (iso: string, n: number) => {
    const d = new Date(iso + 'T00:00:00')
    d.setDate(d.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  // 帰国申請用の日付選択肢を生成（minDateから180日間）
  const getHlDateOptions = (minDateStr?: string) => {
    const min = minDateStr || getHlMinDate()
    const start = new Date(min + 'T00:00:00')
    const options: { value: string; label: string }[] = []
    const dowLabel = ['日', '月', '火', '水', '木', '金', '土']
    for (let i = 0; i < 180; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${dowLabel[d.getDay()]}）`
      options.push({ value: val, label })
    }
    return options
  }

  // true=全部送れた・false=送れなかった（文は leaveError）・null=日付の不備で止めた（ボタンはふだんの顔に戻る）
  const submitLeaveRequest = async (): Promise<boolean | null> => {
    if (!data || leaveSubmitting || !leaveDateFrom) return false
    setLeaveSubmitting(true)
    setLeaveError(null)
    setLeaveSuccess(null)
    // 途中で通信が切れても、送れた日数は表示して一覧を取り直す（2026-10-02 総合点検。旧: 'Error' だけ出て送れた分が分からなかった）
    let successCount = 0
    try {
      // Build list of dates (from ~ to)
      const dates: string[] = []
      const from = new Date(leaveDateFrom + 'T00:00:00')
      const to = leaveDateTo ? new Date(leaveDateTo + 'T00:00:00') : from
      const current = new Date(from)
      while (current <= to) {
        const dow = current.getDay()
        if (dow !== 0) { // 日曜を除く
          dates.push(`${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`)
        }
        current.setDate(current.getDate() + 1)
      }
      if (dates.length === 0) { setLeaveError(biLine(STAFF_TEXT.chooseDate)); setLeaveSubmitting(false); return null }

      // Submit each date
      let lastError = ''
      for (const date of dates) {
        const res = await fetch('/api/leave-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'request',
            token,
            date,
            siteId: data.site.id,
            reason: leaveReason,
          }),
        })
        if (res.ok) {
          successCount++
        } else {
          const d = await res.json().catch(() => ({}))
          lastError = d.error || biLine(STAFF_TEXT.error)
        }
      }

      if (successCount > 0) {
        setLeaveSuccess(`${successCount}日分の申請完了 / Đã gửi ${successCount} ngày`)
        setLeaveDateFrom('')
        setLeaveDateTo('')
        setLeaveReason('')
        fetchLeaveRequests()
        setTimeout(() => setLeaveSuccess(null), 3000)
      }
      if (lastError && successCount < dates.length) {
        const msg = lastError === 'Already requested' ? '一部は申請済みです / Một số đã gửi rồi'
          : lastError === 'No remaining leave' ? '有給の残りがありません / Không còn ngày phép'
          : lastError
        // 失敗の文は消さない（旧: 3秒で消えて読めなかった）。次に送るときに消える
        setLeaveError(msg)
      }
      // 全部送れたときだけ「申請しました」（一部でも送れなかったら、ボタンはもう一度押せる形に戻す）
      return successCount === dates.length
    } catch {
      setLeaveError(successCount > 0
        ? `${successCount}日分は送れました。残りは ${biLine(STAFF_TEXT.connError)}`
        : biLine(STAFF_TEXT.connError))
      if (successCount > 0) fetchLeaveRequests()
      return false
    } finally {
      setLeaveSubmitting(false)
    }
  }

  const getMinDate = () => {
    // 有給は前日まで（2026-09-30。旧: 5日後から）。日本時間で求める
    const [y, m, d] = leaveRequestEarliestDate(todayJstIso()).split('-')
    return `${y}-${m}-${d}`
  }

  const formatLeaveDate = (dateStr: string) => {
    const [, m, d] = dateStr.split('-')
    return `${parseInt(m)}/${parseInt(d)}`
  }

  const submitEntry = async (
    choice: string,
    ot: number = 0,
    year?: number,
    month?: number,
    day?: number
  ) => {
    if (!data || saving) return
    const where: ActionMsg['where'] = year ? 'past' : 'today'
    setSaving(true)
    setActionMsg(null)
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          siteId: data.site.id,
          year: year || data.today.year,
          month: month || data.today.month,
          day: day || data.today.day,
          choice,
          overtimeHours: ot,
        }),
      })
      if (res.ok) {
        showActionMsg({ kind: 'ok', text: biLine(STAFF_TEXT.saved), where })
        setEditingPast(null)
        fetchData()
      } else {
        const d = await res.json().catch(() => ({}))
        showActionMsg({ kind: 'err', text: d.error || biLine(STAFF_TEXT.error), where })
      }
    } catch {
      showActionMsg({ kind: 'err', text: biLine(STAFF_TEXT.connError), where })
    } finally {
      setSaving(false)
    }
  }

  const handleTimeBasedSubmit = async (
    choice: string,
    year?: number,
    month?: number,
    day?: number,
    overrideStartTime?: string,
    overrideEndTime?: string,
    overrideBreak1?: boolean,
    overrideBreak2?: boolean,
    overrideBreak3?: boolean,
  ) => {
    if (!data || saving) return
    const where: ActionMsg['where'] = year ? 'past' : 'today'
    setSaving(true)
    setActionMsg(null)
    const body: Record<string, unknown> = {
      token,
      siteId: data.site.id,
      year: year || data.today.year,
      month: month || data.today.month,
      day: day || data.today.day,
      choice,
    }
    if (choice === 'work') {
      body.startTime = overrideStartTime ?? startTime
      body.endTime = overrideEndTime ?? endTime
      body.break1 = (overrideBreak1 ?? break1) ? 1 : 0
      body.break2 = (overrideBreak2 ?? break2) ? 1 : 0
      body.break3 = (overrideBreak3 ?? break3) ? 1 : 0
    }
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        showActionMsg({ kind: 'ok', text: biLine(STAFF_TEXT.saved), where })
        setEditingPast(null)
        fetchData()
      } else {
        const d = await res.json().catch(() => ({}))
        showActionMsg({ kind: 'err', text: d.error || biLine(STAFF_TEXT.error), where })
      }
    } catch {
      showActionMsg({ kind: 'err', text: biLine(STAFF_TEXT.connError), where })
    } finally {
      setSaving(false)
    }
  }

  const handleChoice = (choice: string) => {
    if (choice === 'work') {
      submitEntry('work', showOT ? otHours : 0)
    } else if (choice === 'leave') {
      // 有給は申請モーダルを開く
      setShowOT(false)
      setShowLeaveModal(true)
    } else if (choice === 'rest') {
      // 欠勤届モーダルを開く
      setShowOT(false)
      setRestDate(todayDateStr())
      setRestLockDate(false)
      setShowRestModal(true)
    } else {
      setShowOT(false)
      submitEntry(choice)
    }
  }

  // 過去の日（または今日）の「休み」から欠勤届を開く。日付は固定（2026-09-30）
  const openRestModalForDay = (yy: number, mm: number, dd: number) => {
    setShowOT(false)
    setRestReason('personal')
    setRestNote('')
    setRestDate(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`)
    setRestLockDate(true)
    setShowRestModal(true)
  }

  // 休憩短縮（分/日）がその月に付くか（旧契約の毎日20分など・2026-09-30）
  const bsMinForYm = (ym: string) => (data?.breakShorten && ym >= data.breakShorten.from ? data.breakShorten.min : 0)
  const bsMinForDate = (y: number, m: number) => bsMinForYm(`${y}${String(m).padStart(2, '0')}`)
  /** 「＋20分（休憩短縮）」の小さな印（日越並記・12px。2026-10-02 総合点検。旧: 10px・日本語のみ） */
  const BsTag = ({ min }: { min: number }) => min > 0
    ? <span className="text-xs leading-tight px-1.5 py-0.5 rounded-lg bg-sky-100 text-sky-800 font-bold text-center">
        <span className="block">{staffBreakShortenTag(min).ja}</span>
        <span className="block font-normal">{staffBreakShortenTag(min).vi}</span>
      </span>
    : null

  // 有給申請ができる最初の日（明日。LeaveRequestModal・サーバの lib/leave-rules.ts と同じ）
  const leaveMinDateStr = () => leaveRequestEarliestDate(todayJstIso())

  // 今日の日付を YYYY-MM-DD で返す（欠勤届モーダルの初期値・最小日）
  const todayDateStr = () => {
    if (!data) return ''
    const t = data.today
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`
  }

  const handleRestSubmit = async (): Promise<boolean> => {
    if (!data || saving) return false
    setSaving(true)
    setActionMsg(null)
    // 対象日: モーダルで選択した日（未指定・不正なら今日にフォールバック）
    const parts = restDate.split('-').map(n => parseInt(n, 10))
    const validDate = parts.length === 3 && parts.every(n => Number.isFinite(n) && n > 0)
    const [ry, rm, rd] = validDate ? parts : [data.today.year, data.today.month, data.today.day]
    // 「現場が休み（会社の都合）」は欠勤ではなく 0.6補（choice: 'comp'）として登録する（2026-09-30）
    const isCompany = restReason === COMPANY_REST
    const body: Record<string, unknown> = isCompany ? {
      token, siteId: data.site.id, year: ry, month: rm, day: rd, choice: 'comp',
    } : {
      token,
      siteId: data.site.id,
      year: ry,
      month: rm,
      day: rd,
      choice: 'rest',
      restReason,
      restNote: restReason === 'other' ? restNote : undefined,
    }
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setShowRestModal(false)
        setRestLockDate(false)
        setEditingPast(null)
        setRestReason('sick')
        setRestNote('')
        showActionMsg({ kind: 'ok', text: biLine(STAFF_TEXT.saved), where: restLockDate ? 'past' : 'today' })
        fetchData()
        return true
      } else {
        const d = await res.json().catch(() => ({}))
        // 2026-08-27 修正: setError のバナーはモーダル(z-50)の裏に隠れて3秒で消え、
        //   スタッフに失敗が伝わらなかった → モーダルより前（z-[100]）の帯で、閉じるまで残す
        notify.error(BI_SAVE_FAILED, d.error || BI_SERVER_REFUSED)
        return false
      }
    } catch {
      notify.error(biLine(STAFF_TEXT.connError), BI_NET_FAILED)
      return false
    } finally {
      setSaving(false)
    }
  }

  const toggleOT = () => {
    if (!data?.currentEntry || data.currentEntry.w !== 1) return
    if (showOT) {
      setShowOT(false)
      submitEntry('work', 0)
    } else {
      setShowOT(true)
      setOtHours(1.0)
      submitEntry('work', 1.0)
    }
  }

  const stepOT = (delta: number) => {
    const newVal = Math.max(0.5, Math.min(8, otHours + delta))
    setOtHours(newVal)
    submitEntry('work', newVal)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-hibi-bg">
        <div className="text-hibi-charcoal text-lg font-bold">よみこみちゅう... / Đang tải...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-hibi-bg p-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 text-center max-w-sm w-full">
          <div className="text-red-500 text-lg font-bold mb-2">{biLine(STAFF_TEXT.error)}</div>
          <div className="text-gray-700">{error}</div>
          {/* ホーム画面のアプリには再読込ボタンがないので、画面に「もう一度」を置く（2026-10-02 総合点検） */}
          <button type="button"
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="mt-4 w-full min-h-[48px] bg-hibi-amber text-hibi-charcoal rounded-xl py-3 text-base font-extrabold active:bg-hibi-amberDark">
            {biLine(STAFF_TEXT.retry)}
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const currentStatus = data.currentStatus
  const currentYm = data.today.ym
  const useTimeBased = isTimeBasedMobile(currentYm)

  /** 保存の結果（押した場所の近く）。where ごとに1つ */
  const ActionMsgBox = ({ where }: { where: ActionMsg['where'] }) => {
    if (!actionMsg || actionMsg.where !== where) return null
    return actionMsg.kind === 'ok'
      ? <div role="status" className="bg-green-100 text-green-800 rounded-xl p-3 text-center font-bold">✓ {actionMsg.text}</div>
      : <div role="alert" className="bg-red-100 text-red-700 rounded-xl p-3 text-center text-sm font-bold">{actionMsg.text}</div>
  }

  /**
   * 今日の登録状況（出勤登録ボタンの直上に常時・2026-10-02 総合点検）。
   * 旧: 時刻入力モードでは承認前の「今日は登録済み」表示がどこにもなく、押した本人が登録できたか確かめられなかった。
   * 色は docs/ui-design.md の「登録済み表示」（出勤=緑ベタ／休み=灰ベタ）。未登録は点線の白。
   */
  const TodayStatusBar = () => {
    if (currentStatus === 'none') {
      return (
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl px-4 py-3 text-center">
          <div className="text-base font-bold text-hibi-charcoal">{STAFF_TEXT.notRegistered.ja}</div>
          <div className="text-sm text-hibi-sub">{STAFF_TEXT.notRegistered.vi}</div>
        </div>
      )
    }
    const isWork = currentStatus === 'work' || currentStatus === 'overtime'
    const e = data.currentEntry
    const time = isWork && e?.st && e?.et ? ` ${e.st}〜${e.et}` : ''
    const bs = isWork ? bsMinForYm(data.today.ym) : 0
    return (
      <div className={`${isWork ? 'bg-[#1E9E52]' : 'bg-gray-500'} text-white rounded-xl px-4 py-3 text-center`}>
        <div className="text-base font-bold inline-flex items-center gap-1.5 tabular-nums">
          <Icon name="check" size={18} strokeWidth={2.4} />
          {STAFF_TEXT.today.ja}: {STAFF_STATUS_BI[currentStatus].ja}{time} {STAFF_TEXT.registered.ja}
        </div>
        <div className="text-sm text-white/90 tabular-nums">
          {STAFF_TEXT.today.vi}: {STAFF_STATUS_BI[currentStatus].vi}{time} · {STAFF_TEXT.registered.vi}
        </div>
        {bs > 0 && <div className="text-xs text-white/90 mt-0.5">{biLine(staffBreakShortenTag(bs))}</div>}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-hibi-bg">
      {/* Header */}
      <StaffHeader name={`${data.worker.name} さん`} sub={data.worker.nameVi} note={data.today.dateLabel} />

      {/* Site selector dropdown */}
      <div className="bg-white border-b px-4 py-3">
        <div className="max-w-lg mx-auto">
          {data.unassigned && (
            <div className="mb-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs font-medium leading-relaxed">
              げんばが まだ わりあてられていません。<br />
              じぶんの げんばを えらんでください。<br />
              <span className="text-amber-600">Chưa được phân công công trường. Vui lòng chọn công trường của bạn.</span>
            </div>
          )}
          <label className="text-xs text-gray-500 block mb-1">げんば / Công trường</label>
          <select
            value={data.site.id}
            onChange={(e) => { siteIdRef.current = e.target.value; setLoading(true); fetchData() }}
            className="w-full bg-gray-50 border border-gray-300 rounded-lg px-3 py-2.5 text-base text-hibi-charcoal font-bold appearance-none"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23666' stroke-width='2'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
          >
            {(data.availableSites || data.allSites.map(s => ({ ...s, primary: true }))).map(s => (
              <option key={s.id} value={s.id}>
                {s.primary ? '\u2605 ' : ''}{s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* 読み込みの失敗（保存の結果は押した場所の近くに出す。2026-10-02 総合点検） */}
        {error && data && (
          <div role="alert" className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm font-bold">
            {biLine(STAFF_TEXT.loadFailed)}: {error}
            <button type="button" onClick={() => fetchData()}
              className="mt-2 w-full min-h-[44px] bg-white border-2 border-red-300 text-red-700 rounded-xl py-2 font-bold active:bg-red-50">
              {biLine(STAFF_TEXT.retry)}
            </button>
          </div>
        )}
        {calendarSuccessMsg && (
          <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold animate-pulse">
            {calendarSuccessMsg}
          </div>
        )}

        {/* ── 本人の出面確認（2026-09-30）── 前の月の職長承認・最終承認がそろってから締めるまで出る */}
        <MonthConfirmCard token={token} />

        {/* ── 未入力の督促バナー（2026-08-28 追加）──
            過去14日の未入力稼働日をチップで並べ、タップでその日の入力モーダルへ直行。
            未入力=欠勤扱いになることを日越で明記する */}
        {data.missingDays && data.missingDays.length > 0 && (
          <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4">
            <div className="text-base font-bold text-red-700">
              <span className="inline-flex items-center gap-1.5"><Icon name="alert" size={18} strokeWidth={2.2} />未入力が {data.missingDays.length}日 あります</span>
            </div>
            <div className="text-sm font-bold text-red-700 mb-1">
              Bạn còn {data.missingDays.length} ngày chưa nhập
            </div>
            <div className="text-xs text-red-600 mb-3">
              入力しないと<b>欠勤</b>になります。日付を押して入力してください。<br />
              Nếu không nhập sẽ bị tính là <b>nghỉ không phép</b>. Hãy bấm vào ngày để nhập.
            </div>
            <div className="flex flex-wrap gap-2">
              {data.missingDays.map(md => {
                if (md.locked) {
                  return (
                    <span key={`${md.year}-${md.month}-${md.day}`}
                      className="px-3 py-2 rounded-lg bg-gray-100 text-gray-500 text-sm font-bold">
                      <span className="inline-flex items-center gap-1">{md.month}/{md.day}<Icon name="lock" size={13} />職長に相談 / Hỏi đốc công</span>
                    </span>
                  )
                }
                const idx = allPastDays.findIndex(
                  pd => pd.year === md.year && pd.month === md.month && pd.day === md.day)
                return (
                  <button key={`${md.year}-${md.month}-${md.day}`}
                    onClick={() => idx >= 0 && setEditingPast(idx)}
                    className="px-3 py-2 rounded-lg bg-white border-2 border-red-400 text-red-700 text-sm font-extrabold active:scale-95">
                    <span className="inline-flex items-center gap-1">{md.month}/{md.day}<Icon name="pen" size={13} strokeWidth={2.2} /></span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 署名ずみのカレンダーを見る（2026-09-30）── 承認後もいつでも現場の休みを確認できるように */}
        {(() => {
          const viewable = pendingCalendars.filter(pc => !pc.fullMonthHomeLeave
            && pc.sites.some(s => s.status === 'approved')
            && !pc.sites.some(s => s.status === 'approved' && (!s.signed || s.needsResign)))
          if (viewable.length === 0) return null
          return (
            <div className="flex gap-2 mb-3">
              {viewable.map(pc => {
                const mm = parseInt(pc.ym.split('-')[1])
                return (
                  <button key={`view-${pc.ym}`} type="button"
                    onClick={() => { setActivePendingCalendar(pc); setShowCalendarModal(true); setCalendarReviewed(false); setCalendarErrorMsg(null) }}
                    className="flex-1 bg-white border-2 border-gray-200 rounded-xl py-2.5 px-3 text-left active:scale-[0.98]">
                    <div className="text-sm font-bold text-hibi-charcoal inline-flex items-center gap-1.5"><Icon name="calendar" size={15} />{mm}月のカレンダー</div>
                    <div className="text-xs text-hibi-sub">Xem lịch tháng {mm}</div>
                  </button>
                )
              })}
            </div>
          )
        })()}

        {/* ── カレンダー承認バナー（2026-05-27 追加 / 2026-06-XX 改) ── */}
        {/* 今月＋翌月の両方をチェックし、未署名 or 再署名要の月ごとにバナーを表示。
            - 未署名: 通常の承認バナー（オレンジ）
            - 再署名要: 「更新あり」バナー（黄色） */}
        {pendingCalendars.map(pc => {
          if (pc.fullMonthHomeLeave) return null
          // 承認済みの中で「アクション要 = 未署名 OR 再署名要」の現場数をカウント
          const sitesNeedAction = pc.sites.filter(s => s.status === 'approved' && (!s.signed || s.needsResign))
          if (sitesNeedAction.length === 0) return null
          const hasResign = sitesNeedAction.some(s => s.needsResign)
          const hasFirstSign = sitesNeedAction.some(s => !s.signed)
          const [y, m] = pc.ym.split('-')
          // 表示モード判定: 再署名 only / 初回署名 only / 混在
          const isResignOnly = hasResign && !hasFirstSign
          const containerCls = isResignOnly
            ? 'bg-gradient-to-r from-yellow-50 to-amber-50 border-amber-400'
            : 'bg-gradient-to-r from-amber-50 to-orange-50 border-orange-400'
          const headingCls = isResignOnly ? 'text-amber-900' : 'text-orange-800'
          const subCls = isResignOnly ? 'text-amber-800' : 'text-orange-700'
          const bannerIcon: IconName = isResignOnly ? 'alert' : 'calendar'
          const headlineJa = isResignOnly
            ? `${parseInt(y)}年${parseInt(m)}月 カレンダー更新あり`
            : `${parseInt(y)}年${parseInt(m)}月のカレンダー承認`
          const headlineVi = isResignOnly
            ? `Lịch tháng ${parseInt(m)}/${parseInt(y)} đã cập nhật`
            : `Xác nhận lịch tháng ${parseInt(m)}/${parseInt(y)}`
          const bodyJa = isResignOnly
            ? `${sitesNeedAction.length}件の現場で変更がありました。再確認してください`
            : `${sitesNeedAction.length}件の現場カレンダーを確認・承認してください`
          const bodyVi = isResignOnly
            ? `Có ${sitesNeedAction.length} công trường đã thay đổi. Hãy xem lại`
            : `Vui lòng xem và xác nhận ${sitesNeedAction.length} lịch công trường`

          return (
            <button
              key={pc.ym}
              onClick={() => {
                setActivePendingCalendar(pc)
                setShowCalendarModal(true)
                setCalendarReviewed(false)
                setCalendarErrorMsg(null)
              }}
              className={`w-full ${containerCls} border-2 rounded-xl p-4 text-left active:scale-[0.98] transition shadow-md`}
            >
              <div className="flex items-start gap-3">
                <div className={headingCls}><Icon name={bannerIcon} size={30} strokeWidth={2} /></div>
                <div className="flex-1">
                  <div className={`font-bold ${headingCls} text-base leading-tight`}>
                    {headlineJa}
                  </div>
                  <div className={`text-xs ${subCls} mt-0.5`}>
                    {headlineVi}
                  </div>
                  <div className="text-sm text-gray-900 mt-2 font-medium">
                    {bodyJa}
                  </div>
                  <div className={`text-xs ${subCls} mt-0.5`}>
                    {bodyVi}
                  </div>
                </div>
                <div className={`text-2xl ${headingCls} self-center`}>›</div>
              </div>
            </button>
          )
        })}

        {/* Today's status */}
        {data.todayLocked ? (
          <div className={`${currentStatus === 'rest' ? 'bg-gray-500' : 'bg-[#1E9E52]'} rounded-xl p-4 text-center`}>
            <div className="text-white font-bold text-lg inline-flex items-center gap-1.5"><Icon name="lock" size={18} strokeWidth={2.2} />かくにんずみ / Đã xác nhận</div>
            <div className="text-white/90 text-sm mt-1 font-bold">
              <StatusLabel s={currentStatus} />
              {currentStatus === 'overtime' && data.currentEntry?.o ? ` +${data.currentEntry.o}h` : ''}
              {data.currentEntry?.st && data.currentEntry?.et && (
                <span className="block text-xs mt-0.5 tabular-nums">{data.currentEntry.st}〜{data.currentEntry.et}</span>
              )}
              {(currentStatus === 'work' || currentStatus === 'overtime') && bsMinForYm(data.today.ym) > 0 && (
                <span className="block text-xs mt-0.5">{biLine(staffBreakShortenTag(bsMinForYm(data.today.ym)))}</span>
              )}
            </div>
          </div>
        ) : useTimeBased ? (
          /* Time-based input (202605~) */
          <div className="space-y-4">
            {/* Start/End time pickers */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">始業 / Bắt đầu</p>
                <select value={startTime} onChange={e => setStartTime(e.target.value)}
                  className="text-2xl font-bold text-hibi-charcoal tabular-nums text-center w-full border-none bg-transparent">
                  {/* 5:00〜13:00 30分刻み (現場ごとの始業時刻に対応) */}
                  {Array.from({length: 17}, (_, i) => {
                    const h = 5 + Math.floor(i / 2)
                    const m = i % 2 === 0 ? '00' : '30'
                    const val = `${String(h).padStart(2,'0')}:${m}`
                    return <option key={val} value={val}>{val}</option>
                  })}
                </select>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">終業 / Kết thúc</p>
                <select value={endTime} onChange={e => setEndTime(e.target.value)}
                  className="text-2xl font-bold text-hibi-charcoal tabular-nums text-center w-full border-none bg-transparent">
                  {Array.from({length: 17}, (_, i) => {
                    const h = 15 + Math.floor(i / 2)
                    const m = i % 2 === 0 ? '00' : '30'
                    const val = `${String(h).padStart(2,'0')}:${m}`
                    return <option key={val} value={val}>{val}</option>
                  })}
                </select>
              </div>
            </div>

            {/* Break checkboxes (午前・午後のみ表示。昼休憩は内部的に処理) */}
            {(workSchedule.morningBreak.enabled || workSchedule.afternoonBreak.enabled) && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <p className="text-xs text-gray-500 mb-2">休憩 / Nghỉ giải lao</p>
                <div className="space-y-2">
                  {[
                    { id: 'b1', cfg: workSchedule.morningBreak,   label: '午前休憩', labelVi: 'Nghỉ sáng',  checked: break1, set: setBreak1 },
                    { id: 'b3', cfg: workSchedule.afternoonBreak, label: '午後休憩', labelVi: 'Nghỉ chiều', checked: break3, set: setBreak3 },
                  ].filter(b => b.cfg.enabled).map(b => (
                    /* 行ごと押せる 44px 以上（2026-10-02 総合点検。旧: 20px のチェックと1行の文字だけで押しにくかった） */
                    <label key={b.id} className="flex items-center gap-3 cursor-pointer min-h-[44px] -mx-2 px-2 rounded-lg active:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={b.checked}
                        onChange={e => b.set(e.target.checked)}
                        className="w-6 h-6 rounded text-hibi-navy shrink-0"
                      />
                      <span className={`text-base ${b.checked ? 'text-gray-700' : 'text-red-600 font-bold'}`}>
                        {b.label}（{b.cfg.minutes}分）/ {b.labelVi} ({b.cfg.minutes} phút)
                        {!b.checked && ` ← ${biLine(STAFF_TEXT.breakNotTaken)}`}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Actual hours display */}
            <div className="bg-[#FFF6E3] border border-[#F2D9A0] rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">実労働時間 / Giờ làm thực tế</p>
              <p className="text-3xl font-extrabold text-[#8A5A00] tabular-nums">
                {(() => {
                  const start = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1])
                  const end = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1])
                  let mins = end - start
                  // 午前・午後はチェック状態に応じて、昼はenabledなら必ず差し引く
                  if (workSchedule.morningBreak.enabled   && break1) mins -= workSchedule.morningBreak.minutes
                  if (workSchedule.lunchBreak.enabled)               mins -= workSchedule.lunchBreak.minutes
                  if (workSchedule.afternoonBreak.enabled && break3) mins -= workSchedule.afternoonBreak.minutes
                  const hours = Math.max(0, mins / 60)
                  return `${Math.floor(hours)}時間${Math.round((hours % 1) * 60)}分`
                })()}
              </p>
              {(() => {
                const start = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1])
                const end = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1])
                let mins = end - start
                if (workSchedule.morningBreak.enabled   && (workSchedule.morningBreak.mandatory   || break1)) mins -= workSchedule.morningBreak.minutes
                if (workSchedule.lunchBreak.enabled     && (workSchedule.lunchBreak.mandatory     || break2)) mins -= workSchedule.lunchBreak.minutes
                if (workSchedule.afternoonBreak.enabled && (workSchedule.afternoonBreak.mandatory || break3)) mins -= workSchedule.afternoonBreak.minutes
                const ot = Math.max(0, mins / 60 - 7)
                return ot > 0 ? <p className="text-sm text-orange-600 font-bold tabular-nums mt-1">{biLine(STAFF_TEXT.nonScheduled)}: {ot.toFixed(1)}h</p> : null
              })()}
              {bsMinForYm(data.today.ym) > 0 && (
                <p className="text-xs text-sky-800 font-bold mt-1.5">
                  {staffBreakShortenTag(bsMinForYm(data.today.ym)).ja}（出勤した日は毎日。残業と同じ単価で給料に入ります）<br />
                  <span className="font-normal">{staffBreakShortenTag(bsMinForYm(data.today.ym)).vi} (mỗi ngày đi làm, trả như làm thêm giờ)</span>
                </p>
              )}
            </div>

            {/* 今日の登録状況 ＋ 保存の結果（ボタンの直上・2026-10-02 総合点検） */}
            <TodayStatusBar />
            <ActionMsgBox where="today" />

            {/* Submit button */}
            <button
              onClick={() => handleTimeBasedSubmit('work')}
              disabled={saving}
              className="w-full bg-hibi-amber text-hibi-charcoal rounded-xl py-4 text-lg font-extrabold shadow-[0_4px_12px_rgba(245,166,35,0.4)] active:bg-hibi-amberDark transition disabled:opacity-50"
            >
              出勤登録 / Xác nhận đi làm
            </button>

            {/* Rest / Leave buttons */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setRestDate(todayDateStr()); setRestLockDate(false); setShowRestModal(true) }}
                disabled={saving}
                className="bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl py-3 text-base font-bold active:bg-gray-100 transition disabled:opacity-50">
                欠勤届 / Xin nghỉ
              </button>
              <button onClick={() => setShowLeaveModal(true)}
                disabled={saving}
                className="bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl py-3 text-base font-bold active:bg-gray-100 transition disabled:opacity-50">
                有給申請 / Xin phép
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 保存の結果（押した場所の近く・2026-10-02 総合点検） */}
            <ActionMsgBox where="today" />
            {/* 4 Buttons (legacy: ~202604) */}
            <div className="grid grid-cols-3 gap-3">
              {([
                { choice: 'work', icon: 'site', label: '出勤 / Đi làm', color: 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' },
                { choice: 'rest', icon: 'home', label: '欠勤届\nXin nghỉ', color: 'bg-gray-400 hover:bg-gray-500 active:bg-gray-600' },
                { choice: 'leave', icon: 'umbrella', label: 'ゆうきゅう\nしんせい', color: 'bg-green-500 hover:bg-green-600 active:bg-green-700' },
                // site_off（げんばやすみ）は変形労働時間制導入により非表示
                // 過去データの表示・集計には影響なし
              ] as const).map(btn => {
                const isActive = (
                  (btn.choice === 'work' && (currentStatus === 'work' || currentStatus === 'overtime')) ||
                  (btn.choice === 'rest' && currentStatus === 'rest') ||
                  (btn.choice === 'leave' && currentStatus === 'leave')
                )
                return (
                  <button
                    key={btn.choice}
                    onClick={() => handleChoice(btn.choice)}
                    disabled={saving}
                    className={`${btn.color} text-white rounded-xl py-5 text-center transition active:scale-95 disabled:opacity-50 ${
                      isActive ? 'ring-4 ring-offset-2 ring-hibi-navy' : ''
                    }`}
                  >
                    <div className="flex justify-center mb-1.5"><Icon name={btn.icon} size={30} strokeWidth={2} /></div>
                    <div className="text-sm font-bold whitespace-pre-line leading-tight">{btn.label}</div>
                  </button>
                )
              })}
            </div>

            {/* Overtime section */}
            {(currentStatus === 'work' || currentStatus === 'overtime') && (
              <div className="bg-white rounded-xl shadow p-4">
                <div className="text-sm text-gray-600 mb-2 text-center">ざんぎょう ある？</div>
                <div className="flex items-center justify-center gap-4">
                  <button
                    onClick={toggleOT}
                    className={`px-6 py-2 rounded-lg font-bold text-sm transition ${
                      showOT ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-600'
                    }`}
                  >
                    {showOT ? 'あり' : 'なし'}
                  </button>
                  {showOT && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => stepOT(-0.5)}
                        className="w-14 h-14 bg-gray-200 rounded-lg text-2xl font-bold active:bg-gray-300"
                      >
                        −
                      </button>
                      <span className="text-xl font-bold text-orange-600 w-16 text-center">
                        {otHours.toFixed(1)}h
                      </span>
                      <button
                        onClick={() => stepOT(0.5)}
                        className="w-14 h-14 bg-gray-200 rounded-lg text-2xl font-bold active:bg-gray-300"
                      >
                        ＋
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Leave request status (visible on main screen)
            承認待ち・職長済みに加えて、これからの日の却下も理由つきで出す（2026-10-02 総合点検。
            旧: 却下は title 属性だけでスマホでは見えず、本人に理由が伝わらなかった） */}
        {(() => {
          const todayIso = todayIsoOf(data) || ''
          const shown = leaveRequests.filter(r => r.status === 'pending' || r.status === 'foreman_approved'
            || (r.status === 'rejected' && r.date >= todayIso))
          if (shown.length === 0) return null
          return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="text-sm text-gray-500 mb-2 font-bold">有給申請の状況 / Trạng thái nghỉ phép</div>
            <div className="space-y-1.5">
              {shown.map(req => (
                <div key={req.id} className={`py-2 px-3 rounded-lg ${req.status === 'pending' ? 'bg-yellow-50' : req.status === 'rejected' ? 'bg-red-50' : 'bg-blue-50'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-700">{formatLeaveDate(req.date)}</span>
                    <div className="flex items-center gap-2">
                      {req.status === 'pending' && (
                        <>
                          <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                            承認待ち / Đang chờ
                          </span>
                          <button
                            onClick={() => cancelLeaveRequest(req.id)}
                            className="text-sm min-h-[44px] px-3 rounded-xl bg-red-50 border-2 border-red-200 text-red-600 font-bold active:bg-red-100"
                          >
                            取り消し / Hủy
                          </button>
                        </>
                      )}
                      {req.status === 'foreman_approved' && (
                        <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                          職長済 / Đốc công đã duyệt
                        </span>
                      )}
                      {req.status === 'rejected' && (
                        <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-bold">
                          {biLine(STAFF_TEXT.rejected)}
                        </span>
                      )}
                    </div>
                  </div>
                  {req.status === 'rejected' && (
                    <div className="text-sm text-red-800 mt-1">
                      {biLine(STAFF_TEXT.rejectedReason)}: {req.rejectedReason || '—'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          )
        })()}

        {/* Info cards: PL remaining + Tool budget */}
        {(data.plRemaining !== null || data.toolBudgetRemaining !== null) && (
          <div className="grid grid-cols-2 gap-3">
            {data.plRemaining !== null && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
                <div className="text-xs text-gray-500 mb-1 inline-flex items-center gap-1"><Icon name="umbrella" size={13} />有給残り / Nghỉ phép còn</div>
                <div className="text-2xl font-bold text-green-600 tabular-nums">{data.plRemaining}<span className="text-sm font-normal text-gray-400 ml-1">日</span></div>
                {data.plPeriodOver && (
                  <div className="text-xs text-orange-700 mt-1">次の付与の手続き待ち / Đang chờ cấp phép năm mới</div>
                )}
                {/* Phase 8: FIFO内訳表示（繰越分と当期付与分） */}
                {/* 内訳・期限は 12px 以上（2026-10-02 総合点検。旧: 10px / 9px） */}
                {((data.plCarryOverRemaining ?? 0) > 0 || (data.plGrantRemaining ?? 0) > 0) ? (
                  <div className="text-xs text-hibi-sub mt-1 space-y-0.5">
                    {(data.plCarryOverRemaining ?? 0) > 0 && (
                      <div className={data.plCarryOverExpiryStatus === 'warning' ? 'text-orange-600 font-bold' : ''}>
                        {data.plCarryOverExpiryStatus === 'warning' && '⏰ '}
                        繰越 / Chuyển sang: <strong>{data.plCarryOverRemaining}日</strong>
                        {data.plCarryOverExpiryDate && (
                          <div className="text-xs tabular-nums">
                            {biLine(STAFF_TEXT.expiry)}: {data.plCarryOverExpiryDate.replace(/-/g, '/')}
                          </div>
                        )}
                      </div>
                    )}
                    {(data.plGrantRemaining ?? 0) > 0 && (
                      <div>
                        当期 / Hiện tại: <strong>{data.plGrantRemaining}日</strong>
                        {data.plGrantExpiryDate && (
                          <div className="text-xs tabular-nums">
                            {biLine(STAFF_TEXT.expiry)}: {data.plGrantExpiryDate.replace(/-/g, '/')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : data.plExpiryDate ? (
                  <div className="text-xs text-hibi-sub mt-1 tabular-nums">
                    {biLine(STAFF_TEXT.expiry)}: {data.plExpiryDate.replace(/-/g, '/')}
                  </div>
                ) : (
                  <div className="text-xs text-hibi-sub">{data.plRemaining} ngày</div>
                )}
              </div>
            )}
            {data.toolBudgetRemaining !== null && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
                <div className="text-xs text-gray-500 mb-1 inline-flex items-center gap-1"><Icon name="wrench" size={13} />道具代残り / Tiền dụng cụ còn</div>
                <div className="text-2xl font-bold text-blue-600 tabular-nums">¥{Math.max(0, data.toolBudgetRemaining).toLocaleString()}</div>
                {(data.toolBudgetCarry ?? 0) !== 0 && (
                  <div className={`text-xs font-bold ${(data.toolBudgetCarry ?? 0) > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                    前の期間から {(data.toolBudgetCarry ?? 0) > 0 ? '+' : '−'}¥{Math.abs(data.toolBudgetCarry ?? 0).toLocaleString()} / Chuyển từ kỳ trước
                  </div>
                )}
                {data.toolBudgetRemaining < 0 && (
                  <div className="text-xs text-red-600 font-bold">¥{(-data.toolBudgetRemaining).toLocaleString()} 超過 / Vượt</div>
                )}
                {(data.toolBudgetPeriodStart || data.toolBudgetPeriodEnd) && (
                  <div className="text-xs text-hibi-sub mt-1 leading-tight">
                    <div className="text-gray-400">期間 / Kỳ</div>
                    {data.toolBudgetPeriodStart && data.toolBudgetPeriodEnd ? (
                      <div className="text-gray-700 font-medium">
                        {data.toolBudgetPeriodStart.replace(/-0?/g, '/')}
                        <span className="text-gray-400"> 〜 </span>
                        {data.toolBudgetPeriodEnd.replace(/-0?/g, '/')}
                      </div>
                    ) : data.toolBudgetPeriodEnd && (
                      <div>〜 {data.toolBudgetPeriodEnd.replace(/-0?/g, '/')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Past 5 days */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-3 font-bold">最近5日 / 5 ngày gần đây</div>
          {/* 過去の日の保存が成功したあとの印（モーダルは閉じるのでここに出す） */}
          <div className="mb-2 empty:hidden"><ActionMsgBox where="past" /></div>
          <div className="space-y-1.5">
            {data.pastDays.map((pd, i) => (
              <div
                key={i}
                className={`flex items-center justify-between min-h-[44px] py-2 px-3 rounded-lg ${
                  pd.locked ? 'bg-gray-50' : 'hover:bg-gray-50 cursor-pointer active:bg-gray-100'
                }`}
                onClick={() => !pd.locked && setEditingPast(i)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-gray-600 whitespace-nowrap">{pd.date}</span>
                  {pd.siteName && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-hibi-sub truncate">{pd.siteName}</span>
                  )}
                </div>
                <div className="flex items-center justify-end flex-wrap gap-1.5 flex-shrink-0 max-w-[60%]">
                  {/* ⚠️ 2026-05-09: 出勤系のステータス (work/overtime) のみ時刻バッジ表示。
                      休み/有給/帰国中などで残骸の st/et が残っていても時刻を出さない */}
                  {pd.entry?.st && pd.entry?.et && (pd.status === 'work' || pd.status === 'overtime') ? (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      {pd.entry.st}〜{pd.entry.et}
                      {(() => {
                        const s = parseInt(pd.entry.st.split(':')[0]) * 60 + parseInt(pd.entry.st.split(':')[1] || '0')
                        const e = parseInt(pd.entry.et.split(':')[0]) * 60 + parseInt(pd.entry.et.split(':')[1] || '0')
                        let m = e - s - 60
                        if (pd.entry.b1) m -= 30
                        if (pd.entry.b3) m -= 30
                        const h = Math.max(0, Math.round(m / 6) / 10)
                        return ` (${h}h)`
                      })()}
                    </span>
                  ) : pd.status === 'none' ? (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      — {biLine(STAFF_STATUS_BI.none)}
                    </span>
                  ) : (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      <StatusLabel s={pd.status} size={12} />
                      {(pd.status === 'work' || pd.status === 'overtime') && pd.entry?.o ? ` +${pd.entry.o}h` : ''}
                    </span>
                  )}
                  {(pd.status === 'work' || pd.status === 'overtime') && (pd.entry?.w ?? 0) > 0 && <BsTag min={bsMinForDate(pd.year, pd.month)} />}
                  {pd.locked && <span className="text-gray-400" title="締めた日 / Đã khóa"><Icon name="lock" size={14} /></span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Home long leave button */}
        <div className="text-center py-3">
          <button onClick={() => setShowHomeLongLeaveModal(true)}
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl text-sm font-bold active:bg-gray-100 transition">
            <Icon name="plane" size={16} />帰国申請 / Xin về nước
          </button>
        </div>

        {/* Guide link */}
        <div className="text-center py-3">
          <a href="/briefing-20260419.html" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 bg-blue-50 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-100 transition">
            <Icon name="book" size={16} />給与・勤怠ガイド / Hướng dẫn lương & chấm công
          </a>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-gray-400 py-2">
          毎日入力してください / Hãy nhập mỗi ngày
        </div>
      </div>

      {/* Past day edit modal */}
      {editingPast !== null && allPastDays[editingPast] && (() => {
        const pd = allPastDays[editingPast]
        const pastYm = `${pd.year}${String(pd.month).padStart(2, '0')}`
        const pastTimeBased = isTimeBasedMobile(pastYm)
        // 閉じるときは、この中に出した失敗の文も消す（成功の印は最近5日の上に残す）
        const closePast = () => {
          setEditingPast(null)
          if (actionMsg?.where === 'past' && actionMsg.kind === 'err') setActionMsg(null)
        }
        return (
          /* 文言は日越並記（2026-10-02 総合点検。旧: このモーダルは見出しから登録ボタンまで日本語だけだった） */
          <Modal
            open
            onClose={closePast}
            title={pd.date}
            sub={biLine(STAFF_TEXT.edit)}
            bilingual
            footer={<CancelButton onClick={closePast} size="lg">やめる / Hủy</CancelButton>}
          >
              {pastTimeBased ? (
                <div className="space-y-4">
                  {/* Start/End time pickers */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-gray-500 mb-1">{biLine(STAFF_TEXT.start)}</p>
                      <select value={pastStartTime} onChange={e => setPastStartTime(e.target.value)}
                        className="text-xl font-bold text-hibi-charcoal tabular-nums text-center w-full border-none bg-transparent">
                        {Array.from({length: 17}, (_, i) => {
                          const h = 5 + Math.floor(i / 2)
                          const m = i % 2 === 0 ? '00' : '30'
                          const val = `${String(h).padStart(2,'0')}:${m}`
                          return <option key={val} value={val}>{val}</option>
                        })}
                      </select>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-gray-500 mb-1">{biLine(STAFF_TEXT.end)}</p>
                      <select value={pastEndTime} onChange={e => setPastEndTime(e.target.value)}
                        className="text-xl font-bold text-hibi-charcoal tabular-nums text-center w-full border-none bg-transparent">
                        {Array.from({length: 17}, (_, i) => {
                          const h = 15 + Math.floor(i / 2)
                          const m = i % 2 === 0 ? '00' : '30'
                          const val = `${String(h).padStart(2,'0')}:${m}`
                          return <option key={val} value={val}>{val}</option>
                        })}
                      </select>
                    </div>
                  </div>

                  {/* Break checkboxes (午前・午後のみ表示。昼休憩は内部的に処理) */}
                  {(workSchedule.morningBreak.enabled || workSchedule.afternoonBreak.enabled) && (
                    <div className="bg-gray-50 rounded-xl p-3">
                      <p className="text-xs text-gray-500 mb-2">{biLine(STAFF_TEXT.breakTime)}</p>
                      <div className="space-y-1">
                        {[
                          { id: 'pb1', cfg: workSchedule.morningBreak,   label: STAFF_TEXT.breakAm, checked: pastBreak1, set: setPastBreak1 },
                          { id: 'pb3', cfg: workSchedule.afternoonBreak, label: STAFF_TEXT.breakPm, checked: pastBreak3, set: setPastBreak3 },
                        ].filter(b => b.cfg.enabled).map(b => (
                          <label key={b.id} className="flex items-center gap-3 cursor-pointer min-h-[44px] -mx-1 px-1 rounded-lg active:bg-gray-100">
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

                  {/* 保存の失敗はこの中に出す（旧: 黒幕の裏の赤帯で見えなかった） */}
                  <ActionMsgBox where="past" />

                  {/* Submit work with times */}
                  <button
                    onClick={() => handleTimeBasedSubmit('work', pd.year, pd.month, pd.day, pastStartTime, pastEndTime, pastBreak1, pastBreak2, pastBreak3)}
                    disabled={saving}
                    className="w-full bg-hibi-amber text-hibi-charcoal rounded-xl py-3 font-extrabold shadow-[0_4px_12px_rgba(245,166,35,0.4)] active:scale-95 disabled:opacity-50"
                  >
                    {biLine(STAFF_TEXT.registerWork)}
                  </button>

                  {/* Rest button — 理由（会社の都合／自分の都合）を選ぶ画面を通す（2026-09-30） */}
                  <button
                    onClick={() => openRestModalForDay(pd.year, pd.month, pd.day)}
                    disabled={saving}
                    className="w-full bg-white border-2 border-gray-300 text-hibi-charcoal rounded-xl py-3 font-bold active:bg-gray-100 active:scale-95 disabled:opacity-50"
                  >
                    休み / Nghỉ
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 empty:hidden"><ActionMsgBox where="past" /></div>
                  {([
                    { choice: 'work', icon: 'site', label: '出勤 / Đi làm', color: 'bg-blue-500' },
                    { choice: 'rest', icon: 'home', label: 'やすみ / Nghỉ', color: 'bg-gray-400' },
                    // 有給は申請フロー経由のため過去日の直接入力は不可
                    // 管理者がPC出面入力画面から修正する
                  ] as const).map(btn => (
                    <button
                      key={btn.choice}
                      onClick={async () => {
                        if (btn.choice === 'rest') {
                          // 過去日の休みも理由（会社の都合／自分の都合）を選ぶ画面を通す（2026-09-30）
                          openRestModalForDay(pd.year, pd.month, pd.day)
                        } else {
                          submitEntry(btn.choice, 0, pd.year, pd.month, pd.day)
                        }
                      }}
                      className={`${btn.color} text-white rounded-xl py-4 text-center active:scale-95`}
                    >
                      <div className="flex justify-center mb-1"><Icon name={btn.icon} size={26} strokeWidth={2} /></div>
                      <div className="text-sm font-bold">{btn.label}</div>
                    </button>
                  ))}
                </div>
              )}
          </Modal>
        )
      })()}

      {/* 欠勤届モーダル（components/attendance/RestReportModal.tsx に集約） */}
      <RestReportModal
        isOpen={showRestModal}
        onClose={() => { setShowRestModal(false); setRestLockDate(false) }}
        reason={restReason}
        setReason={setRestReason}
        note={restNote}
        setNote={setRestNote}
        date={restDate}
        setDate={setRestDate}
        minDate={restLockDate ? restDate : todayDateStr()}
        lockDate={restLockDate}
        saving={saving}
        onSubmit={handleRestSubmit}
        dayPay={data?.absenceDayPay ?? null}
        plRemaining={data?.plRemaining ?? null}
        leaveMinDate={leaveMinDateStr()}
        onChooseLeave={(dt) => {
          leavePresetDate.current = dt
          setShowRestModal(false)
          setRestLockDate(false)
          setShowLeaveModal(true)
        }}
      />

      {/* 有給申請モーダル（components/attendance/LeaveRequestModal.tsx に集約） */}
      <LeaveRequestModal
        isOpen={showLeaveModal}
        onClose={() => setShowLeaveModal(false)}
        dateFrom={leaveDateFrom}
        setDateFrom={setLeaveDateFrom}
        dateTo={leaveDateTo}
        setDateTo={setLeaveDateTo}
        reason={leaveReason}
        setReason={setLeaveReason}
        successMsg={leaveSuccess}
        errorMsg={leaveError}
        submitting={leaveSubmitting}
        requests={leaveRequests}
        onSubmit={submitLeaveRequest}
        onCancelRequest={cancelLeaveRequest}
        // 2026-06-XX 追加: 残数表示 + ボタン disable (監査 finding #26)
        plRemaining={data?.plRemaining ?? null}
      />

      {/* 帰国申請モーダル（components/attendance/HomeLongLeaveModal.tsx に集約） */}
      <HomeLongLeaveModal
        isOpen={showHomeLongLeaveModal}
        onClose={() => setShowHomeLongLeaveModal(false)}
        startDate={hlStartDate}
        setStartDate={setHlStartDate}
        endDate={hlEndDate}
        setEndDate={setHlEndDate}
        reason={hlReason}
        setReason={setHlReason}
        note={hlNote}
        setNote={setHlNote}
        successMsg={hlSuccess}
        errorMsg={hlError}
        setErrorMsg={setHlError}
        submitting={hlSubmitting}
        requests={hlRequests}
        onSubmit={submitHomeLongLeave}
        onCancelRequest={cancelHomeLongLeave}
      />

      {/* カレンダー承認モーダル（components/attendance/CalendarApprovalModal.tsx に集約） */}
      {showCalendarModal && activePendingCalendar && (
        <CalendarApprovalModal
          pendingCalendar={activePendingCalendar}
          reviewed={calendarReviewed}
          onReviewedChange={setCalendarReviewed}
          signing={signingCalendar}
          onSubmit={submitCalendarSign}
          onQuestion={submitCalendarQuestion}
          onClose={() => { setShowCalendarModal(false); setActivePendingCalendar(null) }}
          errorMsg={calendarErrorMsg}
        />
      )}
    </div>
  )
}
