'use client'
// 2026-10-03: 飾りの絵文字を外した（線のアイコンか文字に）

/**
 * 職長スマホ画面（ログイン版・2026-09-02 追加）
 *
 * 職長がスマホだけで日常業務を完結できるようにするページ。タブ構成:
 *   出面           … 日別の出面入力（日本人・ベトナム人・外注人数）＋職長確認（承認/取り消し）
 *   承認           … 有給申請・帰国申請の職長承認（第1段階。最終承認は政仁さん）
 *   就業カレンダー … 休日設定 → 保存 → 政仁さんへ提出
 *   自分           … 自分の有給残・道具代残（詳細と申請はマイページへ）
 *
 * データと権限は既存 API をそのまま使う（このページ専用のAPIは作らない）:
 *   /api/attendance/grid      … 出面の取得・保存・職長承認（月次ロック/有給残/多現場ガード込み）
 *   /api/leave-request        … 有給申請の一覧・職長承認・却下
 *   /api/home-long-leave      … 帰国申請の一覧・職長承認・却下
 *   /api/calendar/status      … 就業カレンダーの取得
 *   /api/calendar/save-days   … 休日設定の保存（承認後修正の再確認フローもサーバ側で処理）
 *   /api/calendar/submit      … 政仁さんへ提出
 *   /api/mypage, /api/tool-budget … 自分の有給・道具代（token）
 *
 * ベトナム人の新規入力は本人スマホが原則（サーバ側 canAdminEditEntry が強制）。
 * この画面では PC グリッドと同じく「有給・欠勤・0.6補の後付け」と「既存エントリの修正」だけ許す。
 * 2026-10-03: 確認と失敗の知らせを共通部品（confirmDialog / confirmDanger / confirmWithReason / notify）に置き換え。
 */

import RestMismatchBanner from '../components/RestMismatchBanner'
import { confirmDialog, confirmWithReason } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { siteLeaderLabel } from '@/lib/companies'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AttendanceEntry, DayType, SiteWorkSchedule,
  calcDayShiftHours, calcOvertimeHours, isTimeBasedMonth,
  DAY_START_OPTIONS, DAY_END_OPTIONS,
} from '@/types'
import { getWorkValue, getTimeStatusValue, DOW_JA } from '@/lib/attendance-grid'
import { generateDefaultDays } from '@/lib/calendar'
import { resolveWorkTypeSiteId } from '@/lib/site-hierarchy'
import { canDriveDefault } from '@/lib/allowance'
import { getEntryStatus } from '@/lib/attendance'
import { isEmployedOn } from '@/lib/workers'
import { orgKeyOf } from '@/lib/locks'
import { evaluateDayInputs, isWorkDayOf } from '@/lib/attendance-missing'
import DriverModal from '../components/DriverModal'
import { Icon } from '@/components/ui/Icon'

// ── 型 ──

interface GridWorker {
  id: number
  name: string
  org: string
  visa?: string
  job?: string
  useOldRules?: boolean
  retired?: string
  hireDate?: string
  /** 配置に入っていないが、この現場に入力がある人（2026-10-02） */
  offRoster?: boolean
}
interface GridSubcon { id: string; name: string }
interface GridData {
  /** 応援現場か（取りまとめ役を「責任者」と呼ぶ・2026-09-30） */
  isSupportSite?: boolean
  /** 職長承認を政仁さんが代行する現場（2026-10-01） */
  proxyApproval?: boolean
  site: { id: string; name: string; workType?: string; noDriveAllowance?: boolean; workSchedule?: SiteWorkSchedule }
  /** 便ごとの運転者（day → {am,pm}・運転手当の元データ） */
  drivers?: Record<number, { am: number[]; pm: number[] }>
  /** 両社とも締めた月 */
  locked?: boolean
  year: number
  month: number
  daysInMonth: number
  ym: string
  workers: GridWorker[]
  subcons: GridSubcon[]
  workerEntries: Record<string, Record<number, AttendanceEntry>>
  subconEntries: Record<string, Record<number, { n: number; on: number }>>
  lockedHibi: boolean
  lockedHfu: boolean
  foremanApprovals: Record<number, unknown>
  finalApprovals: Record<number, unknown>
  calendarDays: Record<string, DayType> | null
  sites: { id: string; name: string; archived?: boolean }[]
  homeLeaves: { workerId: number; startDate: string; endDate: string }[]
  /** 日 → 別の現場に入力がある人（配置に残っているが移動・掛け持ち。未入力に数えない・2026-10-02） */
  elsewhereByDay?: Record<number, number[]>
  /** 休みの区別の取り違えの疑い（lib/rest-mismatch.ts・2026-09-30） */
  restMismatch?: { workerId: number; day: number; comp: number; worked: number }[]

  // ── 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25）。空=この現場には工種が無い ──
  workTypeSites?: { id: string; name: string; workType: string }[]
  /** その月の日ごとの工種指定（day（文字列）→ 工種サイト id）。作業員の既定より優先 */
  dayWorkType?: Record<string, string>
  defaultWorkType?: Record<string, string>
  defaultWorkTypeSubcon?: Record<string, string>
  entrySiteByWorkerDay?: Record<string, Record<number, string>>
  entrySiteBySubconDay?: Record<string, Record<number, string>>
  workTypeDuplicates?: { kind: 'worker' | 'subcon'; id: string; day: number; siteIds: string[] }[]
}

interface LeaveReq {
  id: string
  workerId: number
  workerName: string
  date: string
  ym: string
  siteId: string
  reason: string
  status: string
  requestedAt: string
}
interface HomeReq {
  id: string
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  note?: string
  status: string
}

type CalDays = Record<string, DayType>
interface CalInfo {
  days: CalDays | null
  status: string | null
  rejectedReason: string | null
  /** この月は就業カレンダーを作らない現場（スポット・工期外。PC のカレンダー画面と同じ判定 siteNeedsCalendar） */
  notNeeded?: boolean
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export default function ForemanMobilePage() {
  // ── 認証 ──
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState('')
  const [userId, setUserId] = useState(0)
  const [userToken, setUserToken] = useState('')
  const [foremanSites, setForemanSites] = useState<string[]>([])

  // ── 表示状態 ──
  const [tab, setTab] = useState<'day' | 'requests' | 'calendar' | 'me'>('day')
  const [siteId, setSiteId] = useState('')
  const [today] = useState(() => new Date())
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()))
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(0)   // 進行中の保存数

  const y = viewDate.getFullYear()
  const m = viewDate.getMonth() + 1
  const day = viewDate.getDate()
  const ym = `${y}${pad2(m)}`
  const dateIso = `${y}-${pad2(m)}-${pad2(day)}`
  const source = userRole === 'foreman' ? 'foreman' : 'admin'

  // ── 認証読み込み ──
  useEffect(() => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { password: pw, user } = JSON.parse(stored)
        setPassword(pw)
        if (user) {
          setUserRole(user.role || '')
          setUserId(user.workerId || 0)
          setUserToken(user.token || '')
          setForemanSites(user.foremanSites || [])
          const saved = localStorage.getItem('hibi_mobile_site')
          const fs: string[] = user.foremanSites || []
          if (saved && (fs.includes(saved) || fs.length === 0)) setSiteId(saved)
          else if (fs.length > 0) setSiteId(fs[0])
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 工種サイト（鉄骨など）が選ばれていたら親現場へ（選択欄には親だけ出す・2026-09-30）
  useEffect(() => {
    const cur = (data?.sites || []).find(x => x.id === siteId) as { parentId?: string } | undefined
    if (cur?.parentId) setSiteId(cur.parentId)
  }, [data, siteId])

  // 管理者で担当現場が無い場合: カレンダーAPIから現場一覧を取って先頭を選ぶ
  useEffect(() => {
    if (!password || siteId || foremanSites.length > 0) return
    fetch(`/api/calendar/status?ym=${y}-${pad2(m)}`, { headers: { 'x-admin-password': password } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const first = d?.sites?.[0]?.siteId
        if (first) setSiteId(first)
      })
      .catch(() => {})
  }, [password, siteId, foremanSites, y, m])

  // ── 出面データ取得 ──
  const fetchGrid = useCallback(async () => {
    if (!password || !siteId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/attendance/grid?siteId=${siteId}&ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) { setError(await res.text().catch(() => '') || 'データ取得に失敗しました'); return }
      setData(await res.json())
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, siteId, ym])

  useEffect(() => { fetchGrid() }, [fetchGrid])

  // ── 出面保存（楽観更新 + 失敗時に再取得で復元） ──
  const postGrid = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(s => s + 1)
    try {
      let res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym, ...body }),
      })
      if (res.status === 409) {
        const errData = await res.clone().json().catch(() => null)
        if (errData?.code === 'LEAVE_OVERDRAFT') {
          const b = errData.balance
          // 2026-09-14: 職長には残数超過の上書きを認めない（PC 出面画面・職長トークン画面と同じ）
          if (userRole === 'foreman') {
            notify.error(
              b?.noGrant
                ? `${errData.workerName} さんには有給が付与されていません`
                : `${errData.workerName} さんの有給残は 0 日です`,
              (b?.noGrant ? '' : `付与枠 ${b?.total}日 ／ 消化済み ${b?.used}日。`)
                + '残数を超える有給は登録できません。事務か政仁さんに頼んでください。',
            )
            fetchGrid(); return false
          }
          const okOverdraft = b?.noGrant
            ? await confirmDialog({
                title: `${errData.workerName} さんを有給として登録しますか？`,
                description: `${errData.workerName} さんには有給が付与されていません。\n登録すると記録に残ります。`,
                confirmLabel: '登録する',
              })
            : await confirmDialog({
                title: `残数を超えて ${errData.workerName} さんの有給を登録しますか？`,
                description: `有給残は 0 日です。\n付与枠 ${b?.total} 日 ／ 消化済み ${b?.used} 日\n登録すると記録に残ります。`,
                confirmLabel: '登録する',
              })
          if (!okOverdraft) { fetchGrid(); return false }
          res = await fetch('/api/attendance/grid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
            body: JSON.stringify({ siteId, ym, ...body, allowOverdraft: true }),
          })
        }
      }
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        notify.failed('保存', d?.error || 'サーバが受け付けませんでした')
        fetchGrid()
        return false
      }
      return true
    } catch (e) {
      notify.failed('保存', e)
      fetchGrid()
      return false
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, siteId, ym, fetchGrid, userRole])

  const applyLocal = useCallback((workerId: number, entry: AttendanceEntry | null) => {
    setData(prev => {
      if (!prev) return prev
      const we = { ...prev.workerEntries }
      const mine = { ...(we[workerId] || {}) }
      if (entry) mine[day] = entry
      else delete mine[day]
      we[workerId] = mine
      return { ...prev, workerEntries: we }
    })
  }, [day])

  // ── 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25） ──
  //
  // 「まだその日の入力が無い作業員／外注先」について、次に入力する内容をどの工種に
  // 保存するかだけを覚えておく（選んだだけでは何も保存しない・入力して初めて保存される）。
  // 日付や現場を切り替えたら選択はリセットする（別の日に前の選択が残らないように）。
  const [pendingWorkType, setPendingWorkType] = useState<Record<number, string>>({})
  const [pendingWorkTypeSubcon, setPendingWorkTypeSubcon] = useState<Record<string, string>>({})
  useEffect(() => { setPendingWorkType({}); setPendingWorkTypeSubcon({}) }, [day, siteId])

  /**
   * その作業員の「今」の入力先。
   * 注意: 既にその日のエントリがあれば、必ずそのエントリが実際にある現場を返す
   *   （工種セレクタで新しい選択をしていても、既存分への書き込み先は変えない。
   *   変えてしまうと別の id に新しいエントリができ、古いエントリが取り残されて
   *   二重入力になる）。まだ入力が無い日だけ、選んだ既定・工種の既定・親現場の順で決まる。
   */
  //   優先順位は PC 画面と同じ lib/site-hierarchy.ts resolveWorkTypeSiteId:
  //   既にある現場 > （この画面で選んだ保存先） > その日の工種指定 > 本人の既定 > 親現場
  const workTypeSiteFor = useCallback((workerId: number): string => {
    return resolveWorkTypeSiteId(siteId, {
      existingSite: data?.entrySiteByWorkerDay?.[String(workerId)]?.[day],
      dayWorkType: pendingWorkType[workerId] || data?.dayWorkType?.[String(day)],
      workerDefault: data?.defaultWorkType?.[String(workerId)],
    })
  }, [data, day, pendingWorkType, siteId])

  const workTypeSiteForSubcon = useCallback((subconId: string): string => {
    return resolveWorkTypeSiteId(siteId, {
      existingSite: data?.entrySiteBySubconDay?.[subconId]?.[day],
      dayWorkType: pendingWorkTypeSubcon[subconId] || data?.dayWorkType?.[String(day)],
      workerDefault: data?.defaultWorkTypeSubcon?.[subconId],
    })
  }, [data, day, pendingWorkTypeSubcon, siteId])

  /** 工種タグの選択肢（親現場を含む）。工種の無い現場では空 */
  const workTypeOptions = useMemo(() => {
    if (!data?.workTypeSites?.length) return []
    return [{ id: siteId, label: data.site?.workType || '親現場' }, ...data.workTypeSites.map(s => ({ id: s.id, label: s.workType }))]
  }, [data, siteId])

  /** 工種セレクタの変更。既に入力済みの日は移動、未入力の日は次回保存先を覚えるだけ */
  const handleWorkTypeChange = useCallback(async (workerId: number, toSiteId: string) => {
    const existingSite = data?.entrySiteByWorkerDay?.[String(workerId)]?.[day]
    if (!existingSite) {
      setPendingWorkType(prev => ({ ...prev, [workerId]: toSiteId }))
      return
    }
    if (existingSite === toSiteId) return
    setData(prev => {
      if (!prev) return prev
      const outer = { ...(prev.entrySiteByWorkerDay || {}) }
      outer[String(workerId)] = { ...(outer[String(workerId)] || {}), [day]: toSiteId }
      return { ...prev, entrySiteByWorkerDay: outer }
    })
    // 失敗時（重複ガード等）は postGrid が内部で再取得して画面を合わせる
    await postGrid({ action: 'moveWorkType', day, workerId, toSiteId })
  }, [data, day, postGrid])

  const handleWorkTypeChangeSubcon = useCallback(async (subconId: string, toSiteId: string) => {
    const existingSite = data?.entrySiteBySubconDay?.[subconId]?.[day]
    if (!existingSite) {
      setPendingWorkTypeSubcon(prev => ({ ...prev, [subconId]: toSiteId }))
      return
    }
    if (existingSite === toSiteId) return
    setData(prev => {
      if (!prev) return prev
      const outer = { ...(prev.entrySiteBySubconDay || {}) }
      outer[subconId] = { ...(outer[subconId] || {}), [day]: toSiteId }
      return { ...prev, entrySiteBySubconDay: outer }
    })
    await postGrid({ action: 'moveWorkType', day, subconId, toSiteId })
  }, [data, day, postGrid])

  const saveEntry = useCallback((workerId: number, entry: AttendanceEntry | null) => {
    applyLocal(workerId, entry)
    postGrid({ day, workerId, entry, siteId: workTypeSiteFor(workerId) })
  }, [applyLocal, postGrid, day, workTypeSiteFor])

  // ── エントリ構築（PCグリッドと同じ規則） ──
  const buildTimeStatus = useCallback((value: string): AttendanceEntry | null => {
    if (value === 'P') return { w: 0, p: 1, s: source }
    if (value === 'E') return { w: 0, exam: 1, s: source }
    if (value === 'R') return { w: 0, r: 1, s: source }
    if (value === 'H') return { w: 0, h: 1, s: source }
    if (value === 'C') return { w: 0.6, s: source }
    if (value === 'W') return { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: source }
    return null
  }, [source])

  // 残業h は calcOvertimeHours だけで数える（現場の休憩設定・夜勤ブロックは含めない。保存時と同じ決まり）
  const siteWs = data?.site.workSchedule
  const withRecalcOt = useCallback((e: AttendanceEntry): AttendanceEntry => {
    const ot = calcOvertimeHours(e, siteWs)
    return { ...e, o: ot > 0 ? ot : undefined }
  }, [siteWs])

  const changeTimeField = useCallback((workerId: number, patch: Partial<AttendanceEntry>) => {
    const existing = data?.workerEntries[workerId]?.[day]
    if (!existing) return
    const updated = withRecalcOt({ ...existing, ...patch, s: source })
    saveEntry(workerId, updated)
  }, [data, day, source, saveEntry, withRecalcOt])

  const buildLegacyWork = useCallback((value: string, existing: AttendanceEntry | undefined): AttendanceEntry | null => {
    let entry: AttendanceEntry | null = null
    if (value === '1') entry = { w: 1, s: source }
    else if (value === '0.5') entry = { w: 0.5, s: source }
    else if (value === '0.6') entry = { w: 0.6, s: source }
    else if (value === 'P') entry = { w: 0, p: 1, s: source }
    else if (value === 'E') entry = { w: 0, exam: 1, s: source }
    else if (value === 'R') entry = { w: 0, r: 1, s: source }
    if (entry && entry.w > 0 && entry.w !== 0.6 && existing?.o) entry.o = existing.o
    return entry
  }, [source])

  // ── 外注 ──
  const saveSubcon = useCallback((subconId: string, n: number, on: number) => {
    setData(prev => {
      if (!prev) return prev
      const se = { ...prev.subconEntries }
      const mine = { ...(se[subconId] || {}) }
      if (n > 0 || on > 0) mine[day] = { n, on }
      else delete mine[day]
      se[subconId] = mine
      return { ...prev, subconEntries: se }
    })
    postGrid({ day, subconId, subconEntry: n > 0 || on > 0 ? { n, on } : null, siteId: workTypeSiteForSubcon(subconId) })
  }, [postGrid, day, workTypeSiteForSubcon])

  // ── 日別の派生情報 ──
  const dayType: DayType | null = data?.calendarDays ? (data.calendarDays[String(day)] || 'work') : null
  const isRestDay = dayType !== null && dayType !== 'work'
  const [driverOpen, setDriverOpen] = useState(false)
  const finalApproved = !!data?.finalApprovals?.[day]
  const foremanApproved = !!data?.foremanApprovals?.[day]
  const timeBasedMonth = isTimeBasedMonth(ym)

  const isHomeLeave = useCallback((wid: number) => {
    return (data?.homeLeaves || []).some(hl =>
      hl.workerId === wid && hl.startDate <= dateIso && dateIso <= hl.endDate)
  }, [data, dateIso])

  const lockedFor = useCallback((w: GridWorker) => {
    if (finalApproved) return true
    return orgKeyOf(w.org) === 'hfu' ? !!data?.lockedHfu : !!data?.lockedHibi   // 会社の判定は共通（lib/locks.ts）
  }, [finalApproved, data])

  /**
   * その日に入力があるはずの人か（未入力に数える対象）。日の画面と月の俯瞰で同じ判定を使う（2026-10-02 点検で一本化）。
   * 配置外の人（この現場に入力がある日のために出している行）・入社前／退職後の日（lib/workers.ts isEmployedOn と同じ）・帰国中は数えない
   */
  const expectedOn = useCallback((w: GridWorker, iso: string) => {
    if (w.offRoster) return false
    if (!isEmployedOn(w, iso)) return false   // 在籍の判定は共通（lib/workers.ts）。旧: ここで手書きしていた
    return !(data?.homeLeaves || []).some(hl => hl.workerId === w.id && hl.startDate <= iso && iso <= hl.endDate)
  }, [data])

  /**
   * 1日ぶんの「未入力」。数え方は共通（lib/attendance-missing.ts evaluateDayInputs・2026-10-02 総合点検）:
   *   入力済み＝getEntryStatus が none でない（残骸だけは未入力）／別の現場に入力がある人（grid GET の elsewhereByDay）は
   *   未入力に数えない（マイページ・トークン版と同じ）。旧: エントリが有れば入力済み・別現場を見ず、移動した人を毎日「未入力」と出していた
   */
  const dayInputsOf = useCallback((d: number) => {
    if (!data) return null
    const iso = `${y}-${pad2(m)}-${pad2(d)}`
    const elsewhere = new Set(data.elsewhereByDay?.[d] || [])
    return evaluateDayInputs({
      workers: data.workers.filter(w => !w.offRoster),
      isWorkDay: isWorkDayOf(data.calendarDays, y, m, d),
      placeOf: w => getEntryStatus(data.workerEntries[w.id]?.[d]) !== 'none' ? 'here' : elsewhere.has(w.id) ? 'elsewhere' : 'none',
      expectedOn: w => expectedOn(w, iso),
    })
  }, [data, y, m, expectedOn])

  const missingWorkers = useMemo(() => dayInputsOf(day)?.missing || [], [dayInputsOf, day])

  // ── 職長確認（承認 / 取り消し） ──
  const handleApprove = useCallback(async () => {
    if (!data) return
    if (missingWorkers.length === data.workers.length && data.workers.length > 0) {
      notify.error('この日はまだ誰も入力していません', '入力してから確認してください。')
      return
    }
    if (missingWorkers.length > 0 && !(await confirmDialog({
      title: `まだ ${missingWorkers.length}名 が未入力のまま、確認済みにしますか？`,
      description: `未入力: ${missingWorkers.map(w => w.name).join('・')}\n`
        + '確認するとこの日はロックされ、スタッフは入力できなくなります。',
      confirmLabel: '確認済みにする',
    }))) return
    const ok = await postGrid({ action: 'approve_foreman', day, approvedBy: userId })
    if (ok) fetchGrid()
  }, [data, missingWorkers, postGrid, day, userId, fetchGrid])

  const handleUnapprove = useCallback(async () => {
    if (finalApproved) {
      notify.error('この日は取り消せません', '政仁さんの最終承認がついています。直すときは政仁さんか代表に頼んでください。')
      return
    }
    if (!(await confirmDialog({
      tone: 'danger',
      title: `この日の${siteLeaderLabel(data?.isSupportSite)}確認を取り消しますか？`,
      description: 'スタッフが再び入力できるようになります。あとでもう一度、確認済みにできます。',
      confirmLabel: '取り消す',
    }))) return
    const ok = await postGrid({ action: 'unapprove_foreman', day })
    if (ok) fetchGrid()
  }, [finalApproved, postGrid, day, fetchGrid, data?.isSupportSite])

  // ── 月の俯瞰（確認状況） ──
  const monthOverview = useMemo(() => {
    if (!data) return []
    const isCurMonth = today.getFullYear() === y && today.getMonth() + 1 === m
    const lastDay = isCurMonth ? today.getDate() : (new Date(y, m - 1, 1) < today ? data.daysInMonth : 0)
    const out: { d: number; isWork: boolean; approved: boolean; missing: number }[] = []
    for (let d = 1; d <= lastDay; d++) {
      const isWork = isWorkDayOf(data.calendarDays, y, m, d)   // 「仕事の日か」は共通（lib/attendance-missing.ts）
      // 今日はスタッフが作業後に打刻するので、まだ数えない（「職長承認がまだ」と同じ・2026-10-02 点検）
      const isTodayD = isCurMonth && d === today.getDate()
      const missing = isWork && !isTodayD ? (dayInputsOf(d)?.missing.length || 0) : 0
      out.push({ d, isWork, approved: !!data.foremanApprovals?.[d], missing })
    }
    return out
  }, [data, y, m, today, dayInputsOf])

  // ══════════ 申請タブ ══════════
  const [leaveReqs, setLeaveReqs] = useState<LeaveReq[]>([])
  const [homeReqs, setHomeReqs] = useState<HomeReq[]>([])
  const [reqLoading, setReqLoading] = useState(false)

  const fetchRequests = useCallback(async () => {
    if (!password || !siteId) return
    setReqLoading(true)
    try {
      // 2026-09-02 修正: 表示月＋翌月だけでなく全件を取り、承認待ちで絞る
      //   （2ヶ月より先の申請が職長画面に出ず放置されていた）
      const [lr, hr] = await Promise.all([
        fetch('/api/leave-request', { headers: { 'x-admin-password': password } }).then(r => r.ok ? r.json() : null),
        fetch('/api/home-long-leave', { headers: { 'x-admin-password': password } }).then(r => r.ok ? r.json() : null),
      ])
      const all: LeaveReq[] = lr?.requests || []
      setLeaveReqs(all
        .filter(r => r.siteId === siteId && (r.status === 'pending' || r.status === 'foreman_approved'))
        .sort((a, b) => a.date.localeCompare(b.date)))
      const siteWids = new Set((data?.workers || []).map(w => w.id))
      setHomeReqs(((hr?.requests || []) as HomeReq[])
        .filter(r => (r.status === 'pending' || r.status === 'foreman_approved') && siteWids.has(r.workerId))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)))
    } catch { /* ignore */ } finally {
      setReqLoading(false)
    }
  }, [password, siteId, data])

  useEffect(() => { if (tab === 'requests') fetchRequests() }, [tab, fetchRequests])

  const pendingCount = leaveReqs.filter(r => r.status === 'pending').length
    + homeReqs.filter(r => r.status === 'pending').length

  const actOnRequest = useCallback(async (
    api: string, action: string, requestId: string, extra: Record<string, unknown> = {},
  ) => {
    setSaving(s => s + 1)
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action, requestId, ...extra }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        notify.failed(action === 'reject' ? '却下' : '職長承認', d?.error || 'サーバが受け付けませんでした')
      }
      fetchRequests()
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, fetchRequests])

  // ══════════ 休日カレンダータブ ══════════
  const [calYmDate, setCalYmDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const calY = calYmDate.getFullYear()
  const calM = calYmDate.getMonth() + 1
  const calYm7 = `${calY}-${pad2(calM)}`
  const [calInfo, setCalInfo] = useState<CalInfo | null>(null)
  const [calDaysLocal, setCalDaysLocal] = useState<CalDays>({})
  const [calDirty, setCalDirty] = useState(false)
  const [calLoading, setCalLoading] = useState(false)
  const approvedEditWarned = useRef(false)

  const fetchCal = useCallback(async () => {
    if (!password || !siteId) return
    setCalLoading(true)
    try {
      const res = await fetch(`/api/calendar/status?ym=${calYm7}`, { headers: { 'x-admin-password': password } })
      const d = res.ok ? await res.json() : null
      const mine = d?.sites?.find((s: { siteId: string }) => s.siteId === siteId)
      const info: CalInfo = mine
        ? { days: mine.days, status: mine.status, rejectedReason: mine.rejectedReason }
        : { days: null, status: null, rejectedReason: null, notNeeded: true }
      setCalInfo(info)
      // 未作成の月は PC 画面と同じ既定値（日曜=off・祝日=holiday・それ以外=work）
      const defaults = generateDefaultDays(calY, calM)
      const init: CalDays = { ...defaults, ...(info.days || {}) }
      setCalDaysLocal(init)
      setCalDirty(false)
      approvedEditWarned.current = false
    } catch { /* ignore */ } finally {
      setCalLoading(false)
    }
  }, [password, siteId, calYm7, calY, calM])

  useEffect(() => { if (tab === 'calendar') fetchCal() }, [tab, fetchCal])

  const toggleCalDay = useCallback(async (d: number) => {
    if (calInfo?.status === 'approved' && !approvedEditWarned.current) {
      if (!(await confirmDialog({
        title: '承認済みのカレンダーを変えますか？',
        description: '変更して保存すると「承認後修正」となり、スタッフの再確認（再署名）が必要になります。',
        confirmLabel: '変える',
      }))) return
      approvedEditWarned.current = true
    }
    setCalDaysLocal(prev => ({ ...prev, [String(d)]: prev[String(d)] === 'work' ? 'off' : 'work' }))
    setCalDirty(true)
  }, [calInfo])

  const saveCal = useCallback(async (): Promise<boolean> => {
    setSaving(s => s + 1)
    try {
      const res = await fetch('/api/calendar/save-days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym: calYm7, days: calDaysLocal, updatedBy: userId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        notify.failed('保存', d?.error || 'サーバが受け付けませんでした')
        return false
      }
      setCalDirty(false)
      return true
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, siteId, calYm7, calDaysLocal, userId])

  const submitCal = useCallback(async () => {
    if (!(await confirmDialog({
      title: `${calY}年${calM}月の休日設定を政仁さんへ提出しますか？`,
      description: '提出すると政仁さんの承認待ちになります。',
      confirmLabel: '提出する',
    }))) return
    if (!(await saveCal())) return
    setSaving(s => s + 1)
    try {
      const res = await fetch('/api/calendar/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym: calYm7, submittedBy: userId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        notify.failed('提出', d?.error || 'サーバが受け付けませんでした')
      } else {
        notify.success(`${calY}年${calM}月の休日設定を政仁さんへ提出しました`)
      }
      fetchCal()
    } finally {
      setSaving(s => s - 1)
    }
  }, [calY, calM, saveCal, password, siteId, calYm7, userId, fetchCal])

  // ══════════ 自分タブ ══════════
  const [myData, setMyData] = useState<{
    leave?: { noGrant: boolean; grantDate: string | null; periodEnd: string; total: number; used: number; remaining: number; fiveDayShortfall: number }
    tool?: { budget: number; carry?: number; used: number; remaining: number; period?: { start: string } | null; notStarted?: boolean }
  } | null>(null)

  useEffect(() => {
    if (tab !== 'me' || !userToken || myData) return
    Promise.all([
      fetch(`/api/mypage?token=${userToken}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/tool-budget?token=${userToken}`).then(r => r.ok ? r.json() : null),
    ]).then(([mp, tb]) => {
      setMyData({ leave: mp?.leave, tool: tb || undefined })
    }).catch(() => setMyData({}))
  }, [tab, userToken, myData])

  // ══════════ 描画 ══════════

  if (!password) {
    return <div className="p-6 text-center text-gray-500">ログイン情報が見つかりません。再ログインしてください。</div>
  }

  // 工種サイト（鉄骨など）は出さない。親現場の画面で工種を切り替える（2026-09-30 代表）
  const siteOptions = (data?.sites || [])
    .filter(s => !s.archived && !(s as { parentId?: string }).parentId && (foremanSites.length === 0 || foremanSites.includes(s.id)))

  const dow = new Date(y, m - 1, day).getDay()

  const navDay = (diff: number) => {
    const nd = new Date(y, m - 1, day + diff)
    if (nd > today) return
    setViewDate(nd)
  }

  const tabBtn = (key: typeof tab, label: string, badge?: number) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`relative flex-1 py-2.5 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
        tab === key ? 'bg-hibi-navy text-white' : 'bg-white text-gray-500 border border-gray-200'
      }`}
    >
      {label}
      {!!badge && (
        <span className="absolute -top-1.5 -right-1 bg-red-500 text-white text-3xs font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  )

  return (
    <div className="max-w-md mx-auto px-3 pb-24">
      {/* 現場切替 */}
      {siteOptions.length > 1 && (
        <select
          value={siteId}
          onChange={e => { setSiteId(e.target.value); localStorage.setItem('hibi_mobile_site', e.target.value) }}
          className="w-full mt-3 rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold bg-white"
        >
          {siteOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <div className="flex items-center justify-between mt-3">
        {siteOptions.length <= 1 && data
          ? <div className="text-sm font-bold text-gray-700">{data.site.name}</div>
          : <div />}
        <a href="/attendance" className="text-xs font-bold text-blue-600 border border-blue-200 rounded-lg px-2 py-1 bg-white">PC版画面へ</a>
      </div>

      {/* タブバー */}
      <div className="flex gap-1.5 mt-3 sticky top-0 z-20 bg-gray-50 py-1.5">
        {tabBtn('day', '出面')}
        {tabBtn('requests', '承認', pendingCount)}
        {tabBtn('calendar', '就業カレ')}
        {tabBtn('me', '自分')}
      </div>

      {saving > 0 && (
        <div className="fixed top-2 right-2 z-50 bg-amber-500 text-white text-xs font-bold px-2 py-1 rounded shadow">保存中…</div>
      )}
      {error && <div className="mt-3 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

      {/* ═══ 出面タブ ═══ */}
      {tab === 'day' && (
        <>
          {/* 休みの区別の取り違えの疑い（承認の前に気づけるように・2026-09-30） */}
          {data && (data.restMismatch?.length || 0) > 0 && (
            <div className="mt-3">
              <RestMismatchBanner items={data.restMismatch} workers={data.workers} month={m} />
            </div>
          )}
          {/* 日付ナビ */}
          <div className="flex items-center justify-between mt-3 bg-white rounded-xl border border-gray-200 px-2 py-2">
            <button onClick={() => navDay(-1)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">◀ 前日</button>
            <div className="text-center">
              <div className="font-bold">
                {m}月{day}日（{DOW_JA[dow]}）
                {isRestDay && <span className="ml-1 text-xs text-orange-600 font-bold">休日</span>}
              </div>
              {dateIso !== `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}` && (
                <button onClick={() => setViewDate(new Date(today.getFullYear(), today.getMonth(), today.getDate()))} className="text-2xs text-blue-600 underline">今日へ</button>
              )}
            </div>
            <button
              onClick={() => navDay(1)}
              disabled={dateIso >= `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold disabled:opacity-30"
            >翌日 ▶</button>
          </div>

          {loading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}

          {!loading && data && (
            <>
              {/* 運転者の記録（運転手当・2026-10-02 点検: スマホ版に無く、職長がスマホだけでは記録できなかった）。PC の「運」ボタンと同じ保存 */}
              {!data.site.noDriveAllowance && !data.locked && (() => {
                const dr = data.drivers?.[day]
                const cnt = (dr?.am.length || 0) + (dr?.pm.length || 0)
                return (
                  <button type="button" onClick={() => setDriverOpen(true)}
                    className={`mt-3 w-full py-2 rounded-lg text-sm font-bold border ${cnt > 0
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-emerald-300 text-emerald-700'}`}>
                    {cnt > 0 ? `運転者 行き${dr!.am.length}・帰り${dr!.pm.length}（押して直す）` : 'この日の運転者を記録'}
                  </button>
                )
              })()}

              <DriverModal
                isOpen={driverOpen}
                day={day}
                siteName={data.site.name}
                workers={data.workers
                  .filter(w => canDriveDefault(w))   // 運転しうる人だけ（未設定なら日本人のみ・PC と同じ）
                  .filter(w => {
                    // その日に出面のある人だけ（実働・夜勤。0.6補や休みは出ない・PC と同じ）
                    const e = data.workerEntries[w.id]?.[day] as (AttendanceEntry & { ns?: unknown }) | undefined
                    if (!e) return false
                    const wv = e.w || 0
                    return (wv > 0 && wv !== 0.6) || !!e.ns
                  })
                  .map(w => ({ id: w.id, name: w.name }))}
                current={data.drivers?.[day]}
                onSave={async (am, pm) => {
                  setDriverOpen(false)
                  const ok = await postGrid({ action: 'saveDrivers', day, am, pm })
                  if (ok) fetchGrid()
                }}
                onClose={() => setDriverOpen(false)}
              />

              {/* 確認状態バナー */}
              {finalApproved ? (
                <div className="mt-3 p-2.5 rounded-lg bg-gray-100 text-gray-600 text-sm font-bold text-center"><span className="inline-flex items-center gap-1"><Icon name="lock" size={14} />最終承認済み（編集できません）</span></div>
              ) : foremanApproved ? (
                <div className="mt-3 p-2.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-bold text-center"><span className="inline-flex items-center gap-1"><Icon name="check" size={14} strokeWidth={2.4} />{siteLeaderLabel(data?.isSupportSite)}確認済み</span></div>
              ) : missingWorkers.length > 0 && !isRestDay && dateIso === `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}` ? (
                // 今日はスタッフが作業後に打刻するので、赤い警告にしない（2026-10-02 点検）
                <div className="mt-3 p-2.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-600 text-xs">
                  今日まだ入力していない人 {missingWorkers.length}名（作業後に打刻します）: {missingWorkers.map(w => w.name).join('・')}
                </div>
              ) : missingWorkers.length > 0 && !isRestDay ? (
                <div className="mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                  <b>{missingWorkers.length}名が未入力</b>: {missingWorkers.map(w => w.name).join('・')}
                </div>
              ) : null}

              {/* スタッフ一覧 */}
              <div className="mt-3 space-y-2">
                {data.workers.map(w => {
                  const entry = data.workerEntries[w.id]?.[day]
                  const locked = lockedFor(w)
                  const isVn = !!w.visa && w.visa !== 'none' && w.visa !== ''
                  const isTime = timeBasedMonth && isVn && !w.useOldRules
                  if (isHomeLeave(w.id)) {
                    return (
                      <div key={w.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 flex items-center justify-between">
                        <span className="font-bold text-sm">{w.name}</span>
                        <span className="text-xs font-bold text-cyan-700 bg-cyan-50 px-2 py-1 rounded-md">帰国中</span>
                      </div>
                    )
                  }
                  return (
                    <div key={w.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">
                          {w.name}
                          {w.offRoster && <span className="ml-1.5 text-3xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold align-middle" title="この現場の配置に入っていない人の入力です。現場の選び間違いなら、正しい現場へ移してください">配置外</span>}
                          {entry?.s === 'staff' &&<span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-blue-400" title="スタッフ入力" />}
                          {entry?.s === 'foreman' && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-orange-400" title="職長入力" />}
                        </span>
                        {isTime ? (
                          entry ? (
                            <select
                              value={getTimeStatusValue(entry)}
                              disabled={locked}
                              onChange={e => saveEntry(w.id, buildTimeStatus(e.target.value))}
                              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-bold bg-white"
                            >
                              <option value="">−（削除）</option>
                              <option value="W">出勤</option>
                              <option value="P">有給</option>
                              <option value="E">試験</option>
                              <option value="R">欠勤</option>
                              <option value="H">現場休</option>
                              <option value="C">0.6補</option>
                            </select>
                          ) : (
                            <span className="text-xs text-gray-400">スマホ入力待ち</span>
                          )
                        ) : (
                          <select
                            value={getWorkValue(entry || null)}
                            disabled={locked}
                            onChange={e => saveEntry(w.id, buildLegacyWork(e.target.value, entry))}
                            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-bold bg-white"
                          >
                            <option value="">−</option>
                            <option value="1">出勤 1</option>
                            <option value="0.5">半日 0.5</option>
                            <option value="0.6">0.6補</option>
                            <option value="P">有給</option>
                            <option value="E">試験</option>
                            <option value="R">欠勤</option>
                          </select>
                        )}
                      </div>

                      {/* 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25）。工種の無い現場では出ない */}
                      {workTypeOptions.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <select
                            value={workTypeSiteFor(w.id)}
                            disabled={locked}
                            onChange={e => handleWorkTypeChange(w.id, e.target.value)}
                            title="この日の工種（新規入力の保存先／既存日は選ぶと移動）"
                            className="rounded-lg border border-slate-300 px-1.5 py-1 text-2xs bg-slate-50 text-slate-600"
                          >
                            {workTypeOptions.map(o => <option key={o.id} value={o.id}>工種: {o.label}</option>)}
                          </select>
                          {data.workTypeDuplicates?.some(d => d.kind === 'worker' && d.id === String(w.id) && d.day === day) && (
                            <span className="text-3xs font-bold text-red-600">2つの工種に入力あり</span>
                          )}
                        </div>
                      )}

                      {/* ベトナム人・未入力: 後付けできるステータスだけボタンで出す */}
                      {isTime && !entry && !locked && (
                        <div className="flex gap-1.5 mt-2">
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('C'))} className="flex-1 py-1.5 rounded-lg border border-orange-300 text-orange-600 text-xs font-bold">0.6補</button>
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('P'))} className="flex-1 py-1.5 rounded-lg border border-violet-300 text-violet-600 text-xs font-bold">有給</button>
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('R'))} className="flex-1 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-bold">欠勤</button>
                        </div>
                      )}

                      {/* 時間ベース・出勤: 時刻と休憩 */}
                      {isTime && entry && getTimeStatusValue(entry) === 'W' && !entry.nonly && (
                        <div className="flex items-center gap-2 mt-2">
                          <select value={entry.st || '08:00'} disabled={locked} onChange={e => changeTimeField(w.id, { st: e.target.value })} className="rounded-lg border border-gray-300 px-1.5 py-1 text-sm tabular-nums bg-white">
                            {DAY_START_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <span className="text-gray-400">〜</span>
                          <select value={entry.et || '17:00'} disabled={locked} onChange={e => changeTimeField(w.id, { et: e.target.value })} className="rounded-lg border border-gray-300 px-1.5 py-1 text-sm tabular-nums bg-white">
                            {DAY_END_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <label className="flex items-center gap-0.5 text-2xs text-gray-500">
                            <input type="checkbox" checked={(entry.b1 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b1: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午前
                          </label>
                          <label className="flex items-center gap-0.5 text-2xs text-gray-500">
                            <input type="checkbox" checked={(entry.b3 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b3: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午後
                          </label>
                          <span className="ml-auto text-xs font-bold tabular-nums text-gray-600">{calcDayShiftHours(entry, siteWs).toFixed(1)}h</span>
                        </div>
                      )}
                      {isTime && entry && !!entry.nonly && (
                        <div className="mt-2 text-xs font-bold text-indigo-700 bg-indigo-50 rounded-md px-2 py-1 inline-block">夜勤のみ（編集はPC画面から）</div>
                      )}

                      {/* レガシー・出勤: 残業h */}
                      {!isTime && entry && entry.w > 0 && entry.w !== 0.6 && (
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-gray-500">残業</span>
                          <select
                            value={String(entry.o || 0)}
                            disabled={locked}
                            onChange={e => {
                              const v = parseFloat(e.target.value)
                              saveEntry(w.id, { ...entry, o: v > 0 ? v : undefined, s: source })
                            }}
                            className="rounded-lg border border-gray-300 px-2 py-1 text-sm tabular-nums bg-white"
                          >
                            {[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8].map(v => (
                              <option key={v} value={v}>{v === 0 ? 'なし' : `${v}h`}</option>
                            ))}
                          </select>
                          {!!entry.ns && <span className="text-2xs font-bold text-indigo-600">夜勤あり（編集はPC）</span>}
                        </div>
                      )}
                      {/* 旧契約継続者（外国人）: スマホ打刻の時刻と午前・午後の休憩も表示（PC出面と同じ・2026-09-15）。
                          休憩の変更は時間ベースと同じく時刻から残業hを再計算する */}
                      {!isTime && isVn && w.useOldRules && entry && entry.w > 0 && entry.w !== 0.6 && entry.st && entry.et && !entry.nonly && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-sm tabular-nums text-gray-700">{entry.st}〜{entry.et}</span>
                          <label className="flex items-center gap-0.5 text-2xs text-gray-500">
                            <input type="checkbox" checked={(entry.b1 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b1: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午前
                          </label>
                          <label className="flex items-center gap-0.5 text-2xs text-gray-500">
                            <input type="checkbox" checked={(entry.b3 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b3: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午後
                          </label>
                          <span className="ml-auto text-xs font-bold tabular-nums text-gray-600">{calcDayShiftHours(entry, siteWs).toFixed(1)}h</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* 外注（応援）人数 */}
              {data.subcons.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-bold text-gray-500 mb-1.5">外注（応援）</div>
                  <div className="space-y-2">
                    {data.subcons.map(sc => {
                      const se = data.subconEntries[sc.id]?.[day]
                      const n = se?.n || 0
                      const on = se?.on || 0
                      const locked = finalApproved || (data.lockedHibi && data.lockedHfu)
                      return (
                        <div key={sc.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-sm truncate">{sc.name}</span>
                            <div className="flex items-center gap-1.5">
                              <button disabled={locked || n <= 0} onClick={() => saveSubcon(sc.id, n - 1, on)} className="w-9 h-9 rounded-lg border border-gray-300 font-bold text-lg disabled:opacity-30">−</button>
                              <span className="w-8 text-center font-bold tabular-nums">{n}<span className="text-3xs text-gray-400">人</span></span>
                              <button disabled={locked} onClick={() => saveSubcon(sc.id, n + 1, on)} className="w-9 h-9 rounded-lg border border-gray-300 font-bold text-lg disabled:opacity-30">＋</button>
                              <select
                                value={String(on)}
                                disabled={locked || n <= 0}
                                onChange={e => saveSubcon(sc.id, n, parseFloat(e.target.value))}
                                className="rounded-lg border border-gray-300 px-1 py-1.5 text-xs tabular-nums bg-white"
                                title="残業h"
                              >
                                {[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map(v => (
                                  <option key={v} value={v}>{v === 0 ? '残業なし' : `残業${v}h`}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          {/* 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25） */}
                          {workTypeOptions.length > 0 && (
                            <div className="flex items-center gap-1.5 mt-1.5">
                              <select
                                value={workTypeSiteForSubcon(sc.id)}
                                disabled={locked}
                                onChange={e => handleWorkTypeChangeSubcon(sc.id, e.target.value)}
                                title="この日の工種（新規入力の保存先／既存日は選ぶと移動）"
                                className="rounded-lg border border-slate-300 px-1.5 py-1 text-2xs bg-slate-50 text-slate-600"
                              >
                                {workTypeOptions.map(o => <option key={o.id} value={o.id}>工種: {o.label}</option>)}
                              </select>
                              {data.workTypeDuplicates?.some(d => d.kind === 'subcon' && d.id === sc.id && d.day === day) && (
                                <span className="text-3xs font-bold text-red-600">2つの工種に入力あり</span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 職長確認（職長でない人が職長に登録されている現場は政仁さんが代行・2026-10-01 代表） */}
              {!finalApproved && userRole === 'foreman' && data?.proxyApproval && (
                <div className="mt-4 p-2.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-600 text-sm text-center">この現場の確認（職長承認）は政仁さんが行います</div>
              )}
              {!finalApproved && !(userRole === 'foreman' && data?.proxyApproval) && (
                <div className="mt-4">
                  {foremanApproved ? (
                    <button onClick={handleUnapprove} className="w-full rounded-xl py-3 text-sm font-bold bg-white border-2 border-red-300 text-red-600">この日の確認を取り消す</button>
                  ) : (
                    <button onClick={handleApprove} className="w-full rounded-xl py-3 text-sm font-bold bg-amber-500 text-white shadow">この日を確認する（{siteLeaderLabel(data?.isSupportSite)}承認）</button>
                  )}
                </div>
              )}

              {/* 月の確認状況 */}
              <div className="mt-6">
                <div className="text-xs font-bold text-gray-500 mb-1.5">{m}月の確認状況</div>
                <div className="grid grid-cols-7 gap-1">
                  {monthOverview.map(o => (
                    <button
                      key={o.d}
                      onClick={() => setViewDate(new Date(y, m - 1, o.d))}
                      className={`rounded-lg py-1.5 text-center border ${
                        o.d === day ? 'ring-2 ring-hibi-navy ' : ''
                      }${
                        !o.isWork ? 'bg-gray-100 text-gray-400 border-gray-200'
                        : o.approved ? 'bg-green-50 text-green-700 border-green-200'
                        : o.missing > 0 ? 'bg-red-50 text-red-600 border-red-200'
                        : 'bg-white text-gray-700 border-gray-200'
                      }`}
                    >
                      <div className="text-xs font-bold tabular-nums">{o.d}</div>
                      <div className="text-3xs leading-none">
                        {!o.isWork ? '休' : o.approved ? '済' : o.missing > 0 ? `未${o.missing}` : '—'}
                      </div>
                    </button>
                  ))}
                </div>
                <div className="text-3xs text-gray-400 mt-1">済=確認済み ／ 未N=未入力N名 ／ タップでその日へ</div>
              </div>
            </>
          )}
        </>
      )}

      {/* ═══ 申請タブ ═══ */}
      {tab === 'requests' && (
        <div className="mt-3">
          {reqLoading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}
          {!reqLoading && (
            <>
              <div className="text-xs font-bold text-gray-500 mb-1.5">有給申請</div>
              {leaveReqs.length === 0 && <div className="bg-white rounded-xl border border-gray-200 p-3 text-sm text-gray-400 text-center">承認待ちの有給申請はありません</div>}
              <div className="space-y-2">
                {leaveReqs.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm">{r.workerName}</span>
                      <span className="text-sm font-bold tabular-nums">{r.date.slice(5).replace('-', '/')}</span>
                    </div>
                    {r.reason && <div className="text-xs text-gray-500 mt-0.5">{r.reason}</div>}
                    <div className="flex gap-2 mt-2">
                      {r.status === 'pending' ? (
                        <>
                          <button
                            onClick={() => actOnRequest('/api/leave-request', 'foreman_approve', r.id)}
                            className="flex-1 py-2 rounded-lg bg-hibi-navy text-white text-xs font-bold"
                          >職長承認する</button>
                          <button
                            onClick={async () => {
                              const reason = await confirmWithReason({
                                title: `${r.workerName} さんの有給申請を却下しますか？`,
                                description: '理由は本人に伝わります。',
                                confirmLabel: '却下する',
                                reason: { label: '却下の理由', placeholder: '例: その日は人が足りないため' },
                              })
                              if (reason !== null) actOnRequest('/api/leave-request', 'reject', r.id, { reason, rejectedBy: userId })
                            }}
                            className="py-2 px-3 rounded-lg border border-red-300 text-red-600 text-xs font-bold"
                          >却下</button>
                        </>
                      ) : (
                        <span className="text-xs font-bold text-blue-600 bg-blue-50 rounded-md px-2 py-1">職長承認済み → 政仁さんの最終承認待ち</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-xs font-bold text-gray-500 mb-1.5 mt-5">帰国申請</div>
              {homeReqs.length === 0 && <div className="bg-white rounded-xl border border-gray-200 p-3 text-sm text-gray-400 text-center">承認待ちの帰国申請はありません</div>}
              <div className="space-y-2">
                {homeReqs.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm">{r.workerName}</span>
                      <span className="text-xs font-bold tabular-nums">{r.startDate.slice(5).replace('-', '/')} 〜 {r.endDate.slice(5).replace('-', '/')}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{r.reason}{r.note ? `（${r.note}）` : ''}</div>
                    <div className="flex gap-2 mt-2">
                      {r.status === 'pending' ? (
                        <>
                          <button
                            onClick={() => actOnRequest('/api/home-long-leave', 'foreman_approve', r.id)}
                            className="flex-1 py-2 rounded-lg bg-hibi-navy text-white text-xs font-bold"
                          >職長承認する</button>
                          <button
                            onClick={async () => {
                              const reason = await confirmWithReason({
                                title: `${r.workerName} さんの帰国申請を却下しますか？`,
                                description: '理由は本人に伝わります。',
                                confirmLabel: '却下する',
                                reason: { label: '却下の理由', placeholder: '例: その期間は人が足りないため' },
                              })
                              if (reason !== null) actOnRequest('/api/home-long-leave', 'reject', r.id, { reason })
                            }}
                            className="py-2 px-3 rounded-lg border border-red-300 text-red-600 text-xs font-bold"
                          >却下</button>
                        </>
                      ) : (
                        <span className="text-xs font-bold text-blue-600 bg-blue-50 rounded-md px-2 py-1">職長承認済み → 政仁さんの最終承認待ち</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-3xs text-gray-400 mt-4">
                欠勤の届はスタッフが出面に直接「欠勤」で記録します（承認手続きはありません）。出面タブで確認してください。
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══ 休日カレンダータブ ═══ */}
      {tab === 'calendar' && (
        <div className="mt-3">
          <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-2 py-2">
            <button onClick={() => setCalYmDate(new Date(calY, calM - 2, 1))} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">◀</button>
            <div className="font-bold">{calY}年{calM}月</div>
            <button onClick={() => setCalYmDate(new Date(calY, calM, 1))} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">▶</button>
          </div>

          {calLoading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}

          {/* スポット現場など、この月はカレンダーを作らない（PC のカレンダー画面と揃える・2026-09-30 点検） */}
          {!calLoading && calInfo?.notNeeded && (
            <div className="mt-3 p-3 rounded-lg bg-gray-50 text-gray-600 text-sm">
              この現場は、この月の就業カレンダーを作りません（スポット現場・工期外）。<br />
              常駐が決まったら、現場マスタで「この月から作る」に変えると作れるようになります。
            </div>
          )}
          {!calLoading && calInfo && !calInfo.notNeeded && (
            <>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-bold rounded-md px-2 py-1 ${
                  calInfo.status === 'approved' ? 'bg-green-50 text-green-700'
                  : calInfo.status === 'submitted' ? 'bg-blue-50 text-blue-700'
                  : calInfo.status === 'rejected' ? 'bg-red-50 text-red-700'
                  : calInfo.status === 'draft' ? 'bg-amber-50 text-amber-700'
                  : 'bg-gray-100 text-gray-500'
                }`}>
                  {calInfo.status === 'approved' ? '承認済み'
                    : calInfo.status === 'submitted' ? '提出済み（承認待ち）'
                    : calInfo.status === 'rejected' ? '差し戻し'
                    : calInfo.status === 'draft' ? '下書き'
                    : '未作成'}
                </span>
                <span className="text-xs text-gray-500">
                  休日 {Object.values(calDaysLocal).filter(v => v !== 'work').length}日
                </span>
              </div>
              {calInfo.status === 'rejected' && calInfo.rejectedReason && (
                <div className="mt-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs">差し戻し理由: {calInfo.rejectedReason}</div>
              )}

              {/* 月グリッド（タップで 稼働⇄休み 切替） */}
              <div className="mt-3 grid grid-cols-7 gap-1">
                {DOW_JA.map((d, i) => (
                  <div key={d} className={`text-center text-3xs font-bold ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-400'}`}>{d}</div>
                ))}
                {Array.from({ length: new Date(calY, calM - 1, 1).getDay() }).map((_, i) => <div key={`sp${i}`} />)}
                {Array.from({ length: new Date(calY, calM, 0).getDate() }, (_, i) => i + 1).map(d => {
                  const rest = calDaysLocal[String(d)] !== 'work'
                  return (
                    <button
                      key={d}
                      onClick={() => toggleCalDay(d)}
                      className={`rounded-lg py-2 text-center border font-bold text-sm tabular-nums ${
                        rest ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-gray-700 border-gray-200'
                      }`}
                    >
                      {d}
                      <div className="text-3xs leading-none font-normal">{rest ? '休' : ''}</div>
                    </button>
                  )
                })}
              </div>
              <div className="text-3xs text-gray-400 mt-1.5">日付をタップすると 稼働 ⇄ 休み が切り替わります</div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={saveCal}
                  disabled={!calDirty}
                  className="flex-1 rounded-xl py-3 text-sm font-bold bg-white border-2 border-hibi-navy text-hibi-navy disabled:opacity-30"
                >保存する</button>
                {calInfo.status !== 'approved' && calInfo.status !== 'submitted' && (
                  <button
                    onClick={submitCal}
                    className="flex-1 rounded-xl py-3 text-sm font-bold bg-hibi-navy text-white"
                  >政仁さんへ提出</button>
                )}
              </div>
              {calInfo.status === 'approved' && (
                <div className="text-3xs text-gray-400 mt-2">
                  承認済みのカレンダーを変更して保存すると「承認後修正」となり、スタッフの再確認が必要になります。
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ 自分タブ ═══ */}
      {tab === 'me' && (
        <div className="mt-3 space-y-3">
          {!userToken ? (
            userRole !== 'foreman' ? (
              /* 全体管理者パスワードのログインはワーカー情報（token）を持たない。
                 また役員・管理者はそもそも有給・道具代の管理対象外なので、案内だけ出す */
              <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-gray-500">
                このタブは職長・スタッフ本人用です（自分の有給残・道具代残を表示します）。
                役員・管理者アカウントでは表示する情報がありません。
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-gray-500">
                スマホ用トークンが未発行のため表示できません。管理者に「人員マスタ → スマホURL発行」を依頼してください。
              </div>
            )
          ) : !myData ? (
            <div className="py-10 text-center text-gray-400">読み込み中…</div>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-xs font-bold text-gray-500">自分の有給</div>
                {myData.leave && !myData.leave.noGrant ? (
                  <>
                    <div className="mt-1 flex items-baseline gap-1">
                      <span className="text-3xl font-bold tabular-nums text-hibi-navy">{myData.leave.remaining}</span>
                      <span className="text-sm text-gray-500">日 残っています（枠 {myData.leave.total}日 / 使用 {myData.leave.used}日）</span>
                    </div>
                    {myData.leave.grantDate && (
                      <div className="text-2xs text-gray-400 mt-1">期間: {myData.leave.grantDate} 〜 {myData.leave.periodEnd}</div>
                    )}
                    {myData.leave.fiveDayShortfall > 0 && (
                      <div className="mt-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs font-bold">
                        年5日の取得義務まで あと{myData.leave.fiveDayShortfall}日 足りません
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-1 text-sm text-gray-400">有給の付与情報がありません</div>
                )}
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-xs font-bold text-gray-500">道具代補助の残額</div>
                {myData.tool?.notStarted && myData.tool.period ? (
                  <div className="mt-1 text-sm text-gray-700">
                    <b>{myData.tool.period.start.replace(/-/g, '/')}</b> から
                    年間 <b className="tabular-nums">¥{myData.tool.budget.toLocaleString()}</b> の補助が始まります
                    <span className="block text-2xs text-gray-400 mt-1">それまでの購入申請は従来どおりマネーフォワードから</span>
                  </div>
                ) : myData.tool && myData.tool.period && typeof myData.tool.remaining === 'number' ? (
                  <div className="mt-1">
                    <span className="text-2xl font-bold tabular-nums text-hibi-navy">¥{myData.tool.remaining.toLocaleString()}</span>
                    <span className="text-xs text-gray-500 ml-2">年間 ¥{(myData.tool.budget || 0).toLocaleString()}{(myData.tool.carry ?? 0) !== 0 && <>（繰越 {(myData.tool.carry ?? 0) > 0 ? '+' : '−'}¥{Math.abs(myData.tool.carry ?? 0).toLocaleString()}）</>} のうち ¥{(myData.tool.used || 0).toLocaleString()} 使用</span>
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-gray-400">道具代の設定がありません</div>
                )}
              </div>

              <a
                href={`/mypage/${userToken}`}
                className="block w-full text-center rounded-xl py-3 text-sm font-bold bg-hibi-navy text-white"
              >有給の申請・詳細はマイページへ →</a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
