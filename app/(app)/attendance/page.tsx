'use client'

// 出面入力ページ（司令塔）
// データ取得・入力状態・デバウンス保存・承認ハンドラを担当し、表示は
// components/ 配下（画面固有）と components/attendance/ 配下（バナー類・配置モーダル）に委譲。
// 純粋な計算（フッター合計・警告収集・退職バッジ等）は lib/attendance-grid.ts を参照。

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { permRoleOf, roleCan } from '@/lib/permissions'
import { isTimeBasedMonth, calcOvertimeHours, DAY_START_OPTIONS, DAY_END_OPTIONS } from '@/types'
import {
  currentYm, getYmOptions, getDow, DOW_JA,
  computeWorkerTotals, computeSubconTotals, computeFooterSums, EMPTY_FOOTER_SUMS,
  collectRestDayWorkWarnings,
} from '@/lib/attendance-grid'
import AttendanceActionBar from '@/components/AttendanceActionBar'
import HomeLeaveBanner from '@/components/attendance/HomeLeaveBanner'
import UpcomingRetirementsBanner from '@/components/attendance/UpcomingRetirementsBanner'
import NextMonthCalendarBanner from '@/components/attendance/NextMonthCalendarBanner'
import AttendanceWarningBanner from '@/components/attendance/AttendanceWarningBanner'
import AssignModal from '@/components/attendance/AssignModal'
import { GridData, AttEntry, SubconDayEntry, PendingSave, Worker } from './types'
import HeaderBar from './components/HeaderBar'
import AttendanceGrid from './components/AttendanceGrid'
import NightShiftModal, { NightShiftValue } from './components/NightShiftModal'
import DriverModal from './components/DriverModal'
import HistoryModal from './components/HistoryModal'
import BulkEntryModal, { type BulkItem } from './components/BulkEntryModal'
import RestMismatchBanner from './components/RestMismatchBanner'
import { TodoStrip } from '@/components/ui/PageParts'
import { Icon } from '@/components/ui/Icon'
import { canDriveDefault } from '@/lib/allowance'
import { resolveWorkTypeSiteId } from '@/lib/site-hierarchy'
import { todayJstIso, todayJstDate } from '@/lib/date-utils'
import { postJson } from '@/lib/api-client'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { CALENDAR_REMIND_FROM_DAY, CALENDAR_DEADLINE_DAY } from '@/lib/calendar'

export default function AttendanceGridPage() {
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState('')
  const [userId, setUserId] = useState(0)
  const [userForemanSites, setUserForemanSites] = useState<string[]>([])
  const [ym, setYm] = useState(currentYm)
  const [siteId, _setSiteId] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('att_lastSiteId') || ''
    }
    return ''
  })
  const setSiteId = useCallback((id: string) => {
    _setSiteId(id)
    if (id) localStorage.setItem('att_lastSiteId', id)
  }, [])
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [allSites, setAllSites] = useState<{ id: string; name: string; archived?: boolean }[]>([])
  const [localApprovals, setLocalApprovals] = useState<Record<number, boolean>>({})  // 後方互換: 職長承認 bool
  const [localFinalApprovals, setLocalFinalApprovals] = useState<Record<number, boolean>>({})

  // Save status: null | 'saving' | 'saved' | 'error'
  const [saveStatus, setSaveStatus] = useState<null | 'saving' | 'saved' | 'error'>(null)
  const saveStatusTimer = useRef<NodeJS.Timeout | null>(null)

  // Local state for entries (for instant UI updates)
  const [workerEntries, setWorkerEntries] = useState<Record<string, Record<number, AttEntry | null>>>({})
  const [subconEntries, setSubconEntries] = useState<Record<string, Record<number, SubconDayEntry | null>>>({})

  // workDays input
  const [workDaysInput, setWorkDaysInput] = useState<string>('')

  // Assignment modal
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // 2026-10-01 出面入力の改修: 申請は右から開くパネル、注意書きは「確認すること」にまとめて開閉
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [checksOpen, setChecksOpen] = useState(false)
  const [reqCounts, setReqCounts] = useState<{ leave: number; home: number; foreman: number; final: number }>({ leave: 0, home: 0, foreman: 0, final: 0 })
  const [showBulk, setShowBulk] = useState(false)
  // さかのぼり入力の「今から変更する」（代表・事業責任者だけ。押したときだけ入力なしのマスに選択を出す・2026-10-02）
  const [backfillMode, setBackfillMode] = useState(false)
  // 夜勤モーダル（台風待機など年数回のケース）
  const [nightTarget, setNightTarget] = useState<{ workerId: string; day: number } | null>(null)
  // 夜勤が発生した日（現場×月ごと）。指定した日だけスタッフのセルに夜勤バッジが出る
  const [nightDays, setNightDays] = useState<number[]>([])
  const [drivers, setDrivers] = useState<Record<number, { am: number[]; pm: number[] }>>({})
  const [driverDay, setDriverDay] = useState<number | null>(null)

  // 翌月カレンダー未確定アラート用（月末1週間前を過ぎたら全現場の status を取得）
  const [nextMonthCalCheck, setNextMonthCalCheck] = useState<{
    ym: string
    daysToMonthEnd: number
    sites: { siteId: string; siteName: string; status: string | null }[]
  } | null>(null)

  // Debounce queue
  const pendingSaves = useRef<Map<string, PendingSave>>(new Map())
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)

  const ymOptions = useMemo(() => getYmOptions(26), []) // 2024年4月まで遡れるように拡張

  // 時間ベース入力モード（202605〜）
  const useTimeBased = isTimeBasedMonth(ym)

  // 1日あたりのセル幅（px）
  // 時間ベース入力月は始業・終業・休憩など情報が多いため広めに
  const cellWidth = useTimeBased ? 76 : 56

  /**
   * 名前列の幅（2026-08-31 追加）。
   * 職長は専用のスマホ画面ではなく、このPC画面をスマホで操作している。
   * 幅375pxで名前列150pxだと画面の4割を占め、日付が3日分しか見えなかったため、
   * 狭い画面では90pxに縮めて表示日数を稼ぐ。
   */
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const nameWidth = isNarrow ? 90 : 150

  // 時間選択肢は lib/attendance.ts の共通定数（スマホ入力と同一）
  const startTimeOptions = DAY_START_OPTIONS
  const endTimeOptions = DAY_END_OPTIONS

  // Read auth
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw, user } = JSON.parse(stored)
        setPassword(pw)
        if (user) {
          setUserRole(user.role || '')
          setUserId(user.workerId || 0)
          setUserForemanSites(user.foremanSites || [])
        }
      } catch { /* ignore */ }
    }
  }, [])

  // Fetch grid data
  // 現場・月を素早く切り替えたとき、前の応答があとから届いて表を上書きしない（lib/hooks/useLatestRequest・2026-10-02 総合点検）。
  //   旧: 取り消しも順番の確認も無く、承認・夜勤・運転者は state の siteId/ym で送るのに表は古い応答の内容、になり得た
  const latest = useLatestRequest()
  const fetchData = useCallback(async () => {
    if (!password || !siteId || !ym) return
    const req = latest.begin()
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/attendance/grid?siteId=${siteId}&ym=${ym}`, {
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
      const json: GridData = await res.json()
      if (!req.isCurrent()) return
      setData(json)
      setWorkerEntries(json.workerEntries)
      setNightDays(json.nightDays || [])
      setDrivers(json.drivers || {})
      setSubconEntries(json.subconEntries)
      setLocalApprovals(json.approvals || {})
      // 最終承認は finalApprovals マップから bool マップを生成
      const finalBoolMap: Record<number, boolean> = {}
      const finalRaw = json.finalApprovals || {}
      for (const k of Object.keys(finalRaw)) {
        finalBoolMap[Number(k)] = true
      }
      setLocalFinalApprovals(finalBoolMap)
      // Use siteWorkDays (from approved calendar) if workDays is not manually set
      const effectiveWorkDays = json.workDays ?? json.siteWorkDays
      setWorkDaysInput(effectiveWorkDays != null ? String(effectiveWorkDays) : '')
    } catch (e) {
      if (latest.isAbort(e) || !req.isCurrent()) return  // 自分で止めた古い読み込み
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      if (req.isCurrent()) setLoading(false)
    }
  }, [password, siteId, ym, latest])

  useEffect(() => { fetchData() }, [fetchData])

  // On first load with sites, select first site if none selected
  useEffect(() => {
    if (data && data.sites.length > 0 && !siteId) {
      setSiteId(data.sites[0].id)
    }
  }, [data, siteId, setSiteId])

  // Initial site load: fetch site list from sites API
  const sitesLoaded = useRef(false)
  useEffect(() => {
    if (!password || sitesLoaded.current) return
    sitesLoaded.current = true
    const loadSites = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/sites', {
          headers: { 'x-admin-password': password },
        })
        if (res.ok) {
          const json = await res.json()
          const sites = json.sites || []
          setAllSites(sites)
          // 工種サイト（鉄骨など）が選ばれていたら親現場へ（選択欄には親だけ出す・2026-09-30）
          const cur = sites.find((s: { id: string; parentId?: string }) => s.id === siteId) as { parentId?: string } | undefined
          if (cur?.parentId && sites.some((s: { id: string }) => s.id === cur.parentId)) {
            setSiteId(cur.parentId)
          } else
          // siteId が空、または保存値がサイトリストに存在しない場合のみデフォルト設定
          if (!siteId || !sites.some((s: { id: string }) => s.id === siteId)) {
            const activeSites = sites.filter((s: { archived?: boolean; parentId?: string }) => !s.archived && !s.parentId)
            if (activeSites.length > 0) {
              setSiteId(activeSites[0].id)
            }
          }
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    loadSites()
  }, [password, siteId, setSiteId])

  // ── 翌月カレンダー未確定アラート ──
  // 月末1週間前を過ぎたら、翌月の siteCalendar status を全現場分取得して
  // 未確定（draft/未作成/rejected/submitted）の現場があればバナー表示。
  // ym 切替には依存させず、今日の日付ベースで一度だけチェック。
  useEffect(() => {
    if (!password) return
    // 予告は 18日から（サイドバーと同じ・lib/calendar.ts CALENDAR_REMIND_FROM_DAY）。日付は日本時間
    //   旧: 「月末まで7日」でブラウザの日付を使い、サイドバー（18日）・ベル（25日）とばらばらだった（2026-10-02 点検）
    const today = todayJstDate()
    if (today.getDate() < CALENDAR_REMIND_FROM_DAY) {
      setNextMonthCalCheck(null)
      return
    }
    const daysToMonthEnd = CALENDAR_DEADLINE_DAY - today.getDate()   // 提出の期限（25日）までの日数
    // 翌月の ym "YYYY-MM"
    const nm = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    const nextYm = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}`
    fetch(`/api/calendar/status?ym=${nextYm}`, {
      headers: { 'x-admin-password': password },
    })
      .then(r => r.ok ? r.json() : null)
      .then((json: { sites?: { siteId: string; siteName: string; status: string | null }[] } | null) => {
        if (!json || !json.sites) return
        setNextMonthCalCheck({
          ym: nextYm,
          daysToMonthEnd,
          sites: json.sites.map(s => ({
            siteId: s.siteId,
            siteName: s.siteName,
            status: s.status,
          })),
        })
      })
      .catch(() => {})
  }, [password])

  // ── Debounced save flush ──

  /**
   * 溜めた入力をまとめて保存する。
   * keepalive（2026-10-02 総合点検）: 画面を離れる（別メニューへ移る）ときの最後の送信に付ける。
   *   旧: 入力から1秒以内に画面を離れると、タイマーを止めるだけで送っていなかった（表示は出ていたので気づけない）
   */
  const flushSaves = useCallback(async (opts: { keepalive?: boolean } = {}) => {
    if (!password || !data || pendingSaves.current.size === 0) return

    setSaveStatus('saving')

    const saves = Array.from(pendingSaves.current.values())
    pendingSaves.current.clear()

    try {
      // Send all pending saves and inspect each response
      //   同時に送るのは4件まで（2026-09-30 点検: 一括入力で数百件を一度に送ると、1件ごとに
      //   出面ドキュメント（200〜300KB）を読むため読み取りと同一文書への書き込みが集中する）
      const saveOne = async (s: PendingSave) => {
        // 工種のある現場では保存先が日ごと・人ごとに変わる（2026-09-25）:
        //   既にその日のエントリがある現場 > その日の工種指定 > 本人の既定 > 親現場
        //   工種の無い現場は全部 undefined なので親現場（= data.site.id）のまま
        const existingSite = s.type === 'worker'
          ? data.entrySiteByWorkerDay?.[s.id]?.[s.day]
          : data.entrySiteBySubconDay?.[s.id]?.[s.day]
        const workerDefault = s.type === 'worker'
          ? data.defaultWorkType?.[s.id]
          : data.defaultWorkTypeSubcon?.[s.id]
        const targetSiteId = resolveWorkTypeSiteId(data.site.id, {
          existingSite, dayWorkType: data.dayWorkType?.[String(s.day)], workerDefault,
        })
        const body: Record<string, unknown> = {
          siteId: targetSiteId,
          ym: data.ym,
          day: s.day,
        }
        if (s.type === 'worker') {
          body.workerId = s.id
          body.entry = s.entry
        } else {
          body.subconId = s.id
          body.subconEntry = s.subconEntry
        }
        let res = await fetch('/api/attendance/grid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': password,
          },
          body: JSON.stringify(body),
          keepalive: opts.keepalive === true,
        })

        // 有給の残数超過（2026-08-04 追加 / グエン ミン トゥアン事案）
        //   既定では拒否されるが、前借り等の正当な運用を止めないよう、
        //   内容を明示したうえで承知の場合だけ上書きできるようにする。
        //   上書きした場合はサーバ側で activityLog に記録される。
        if (res.status === 409) {
          const errData = await res.clone().json().catch(() => null)
          if (errData?.code === 'LEAVE_OVERDRAFT') {
            const b = errData.balance
            // 2026-09-14: 職長には残数超過の上書きを認めない（職長は共通パスワードのため
            //   サーバ側では管理者と区別できず、ここで止めるしかない。職長トークン画面と同じ方針）
            if (userRole === 'foreman') {
              alert(b?.noGrant
                ? `${errData.workerName} さんには有給が付与されていません。管理者に連絡してください。`
                : `${errData.workerName} さんの有給残は 0 日です（枠 ${b?.total}日 / 消化 ${b?.used}日）。残数を超える有給は登録できません。管理者に連絡してください。`)
              return { ok: false, save: s, error: '有給残数の超過のため登録できません（管理者へ）', status: 409 }
            }
            const msg = b?.noGrant
              ? `${errData.workerName} さんには有給が付与されていません。\n\nこのまま有給として登録しますか？`
              : `${errData.workerName} さんの有給残は 0 日です。\n`
                + `　付与枠: ${b?.total} 日\n　消化済み: ${b?.used} 日`
                + (b?.overdraft ? `\n　超過: ${b.overdraft} 日` : '')
                + `\n\n残数を超えて有給を登録しますか？（記録に残ります）`
            if (!confirm(msg)) {
              return { ok: false, save: s, error: '有給残数の超過のため登録しませんでした', status: 409 }
            }
            res = await fetch('/api/attendance/grid', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
              body: JSON.stringify({ ...body, allowOverdraft: true }),
            })
          }
          // 非稼働日への有給（2026-09-02 追加）: 過払い防止のため既定は拒否、承知の場合だけ上書き
          if (errData?.code === 'NON_WORKING_DAY') {
            if (!confirm(`${errData.workerName} さんの ${data.ym}/${s.day} は現場カレンダーの非稼働日です。\n休日・所定休に有給を入れると有給日給の過払いになります。\n\nそれでも有給として登録しますか？（記録に残ります）`)) {
              return { ok: false, save: s, error: '非稼働日のため有給を登録しませんでした', status: 409 }
            }
            res = await fetch('/api/attendance/grid', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
              body: JSON.stringify({ ...body, allowNonWorkingDay: true }),
            })
          }
        }

        if (!res.ok) {
          // エラーレスポンスから詳細を取得（保存失敗を握りつぶさない）
          let errMsg = `${res.status} ${res.statusText}`
          try {
            const errData = await res.json()
            if (errData?.error) errMsg = errData.error
          } catch { /* JSON でないレスポンスの場合 */ }
          return { ok: false, save: s, error: errMsg, status: res.status }
        }
        // 保存できたら「この日のエントリはこの現場にある」を覚える（次の編集も同じ現場へ）。
        // 消した（entry null）ならその記録も消す
        if (data.workTypeSites?.length) {
          const hasValue = s.type === 'worker' ? !!s.entry : !!s.subconEntry
          setData(prev => {
            if (!prev) return prev
            const mapKey = s.type === 'worker' ? 'entrySiteByWorkerDay' : 'entrySiteBySubconDay'
            const outer = { ...(prev[mapKey] || {}) }
            const inner = { ...(outer[s.id] || {}) }
            if (hasValue) inner[s.day] = targetSiteId
            else delete inner[s.day]
            outer[s.id] = inner
            return { ...prev, [mapKey]: outer }
          })
        }
        return { ok: true as const, save: s }
      }
      const results: Awaited<ReturnType<typeof saveOne>>[] = []
      for (let i = 0; i < saves.length; i += 4) {
        results.push(...await Promise.all(saves.slice(i, i + 4).map(saveOne)))
      }
      const failures = results.filter(r => !r.ok) as { ok: false; save: PendingSave; error: string; status: number }[]

      if (failures.length === 0) {
        setSaveStatus('saved')
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      } else {
        // ⚠️ 2026-05-11 修正: 旧コードはレスポンスを確認せず常に「保存しました」を表示
        //   していたため、API が 403/409/503 でエラーを返しても画面に出ず、データ消失と
        //   誤認される事案が発生。res.ok を厳密にチェックして失敗を alert で明示する。
        setSaveStatus('error')
        const sample = failures.slice(0, 5)
        const detail = sample.map(f => {
          const s = f.save
          const label = s.type === 'worker' ? `スタッフID:${s.id}` : `応援:${s.id}`
          return `  ${label} ${data.ym}/${s.day}: ${f.error}`
        }).join('\n')
        const more = failures.length > sample.length ? `\n  …他 ${failures.length - sample.length} 件` : ''
        // 注意書きは、本人の入力待ちで止まったときだけ出す（2026-10-02 代表指摘: 権限がなくて止まったときにも
        //   「出勤は後付けできません」が必ず付き、本当の理由が分かりにくかった）
        const staffInputReason = failures.some(f => /スマホ入力待ち|出勤に変えられません/.test(f.error))
        alert(
          `❌ ${failures.length} 件の保存に失敗しました\n\n${detail}${more}` +
          (staffInputReason
            ? `\n\n※外国人スタッフの「出勤」は、本人のスマホ入力が無い日には入れられません。\n` +
              `打刻し忘れの日は、代表か政仁さんが「今から変更する」から入れます（昨日までの日）。\n` +
              `有給・欠勤・帰国中・0.6補は、事務・職長も後から入れられます。`
            : '')
        )
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 5000)
        // 保存できなかったマスが画面に入力済みのまま残らないよう、サーバの内容で表示を戻す（2026-09-30 点検）。
        //   続けて入力された未保存の分があるときは、それを消さないよう読み直さない
        if (pendingSaves.current.size === 0) fetchData()
      }
    } catch (e) {
      console.error('Save error:', e)
      setSaveStatus('error')
      alert(`❌ 通信エラーで保存できませんでした\n\n${e instanceof Error ? e.message : String(e)}\n\nネットワーク状態を確認してもう一度お試しください。`)
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 5000)
    }
  }, [password, data, fetchData])

  const scheduleSave = useCallback((key: string, save: PendingSave) => {
    pendingSaves.current.set(key, save)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      flushSaves()
    }, 1000)
  }, [flushSaves])

  // 画面を離れるときの未送信分（2026-10-02 総合点検）:
  //   - 別メニューへ移る（アンマウント）→ 残っている分を keepalive 付きで送る
  //   - タブを閉じる・再読み込み → ブラウザの「このページを離れますか」で止める
  const flushRef = useRef(flushSaves)
  useEffect(() => { flushRef.current = flushSaves }, [flushSaves])
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingSaves.current.size === 0) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      if (pendingSaves.current.size > 0) void flushRef.current({ keepalive: true })
    }
  }, [])

  // ── Worker cell handlers ──

  // Excel風キーボードナビゲーション: Enter で同じ日付列の次の人のステータスにジャンプ
  const focusNextWorkerStatus = useCallback((day: number, currentWorkerId: string, shiftKey: boolean) => {
    // 同じ日付列のステータスセル一覧を取得（disabled は自動的にスキップ）
    const cells = Array.from(
      document.querySelectorAll(`[data-att-status][data-att-day="${day}"]:not([disabled])`)
    ) as HTMLSelectElement[]
    const currentIdx = cells.findIndex(c => c.dataset.attRow === currentWorkerId)
    if (currentIdx < 0) {
      // フォールバック: 最初のセルへ
      cells[0]?.focus()
      return
    }
    const target = shiftKey ? cells[currentIdx - 1] : cells[currentIdx + 1]
    if (target) {
      target.focus()
      // セル全体が画面内に入るようにスクロール調整
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [])

  // 任意のキーボードイベントから呼び出すヘルパー
  const handleAttCellKeyDown = useCallback((e: React.KeyboardEvent, day: number, workerId: string) => {
    // 2026-06-XX 追加 (UI #5): 追加ショートカット
    //   Enter / Shift+Enter: 縦方向の移動 (既存)
    //   Esc: フォーカス解除（誤入力時の取り消し）
    //   Ctrl/Cmd+S: debounce 待たず即保存（後続処理は scheduleSave 側でハンドル）
    //   ※ select 要素では文字キーでオプションがジャンプ (W/P/R/E/H) — ブラウザ標準動作
    if (e.key === 'Enter') {
      e.preventDefault()
      focusNextWorkerStatus(day, workerId, e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      // ブラウザのページ保存ダイアログを抑制（debounce 内で自動保存されるので何もしなくて良い）
      e.preventDefault()
    }
  }, [focusNextWorkerStatus])

  // 2026-08-28 追加: 本人がスマホで入力した記録を消す/変えるときだけ確認する。
  //   8/27 IHI で誤削除が起き、当日入力のため日次バックアップでも救えなかった。
  //   管理者が入れた記録の修正は従来どおり無確認（日常操作の邪魔をしない）。
  // 2026-10-02 総合点検: 確認を1つの関数にして、日本人のセル（handleWorkChange）と
  //   ベトナム人の時間入力のセル（handleTimeStatusChange）の両方から呼ぶ。旧: 前者にだけあり、
  //   本人の打刻（始業・終業つき）を「-」や別の状態に変えると確認なしで消えていた
  const confirmOverwriteStaffEntry = useCallback((workerId: string, day: number, value: string): boolean => {
    const cur = workerEntries[workerId]?.[day] as (AttEntry & { s?: string }) | undefined
    if (cur?.s !== 'staff') return true
    const w = data?.workers.find(x => String(x.id) === String(workerId))
    const desc = cur.p ? '有給' : cur.r ? '欠勤' : cur.h ? '現場休' : cur.hk ? '帰国中'
      : cur.exam ? '試験' : cur.w === 0.6 ? '0.6補償'
      : `出勤${cur.st && cur.et ? ` ${cur.st}〜${cur.et}` : ''}${cur.o ? ` 残業${cur.o}h` : ''}`
    const verb = value === '' ? 'を削除' : 'を上書き'
    return confirm(
      `${w?.name || `ID ${workerId}`} さんが スマホで入力した ${day}日 の記録です。\n\n`
      + `　現在: ${desc}\n\n`
      + `この記録${verb}しますか？`
    )
  }, [workerEntries, data])

  const handleWorkChange = useCallback((workerId: string, day: number, value: string) => {
    if (!confirmOverwriteStaffEntry(workerId, day, value)) return
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }

      let entry: AttEntry | null = null
      if (value === '1') {
        entry = { w: 1, o: 0 }
      } else if (value === '0.5') {
        entry = { w: 0.5, o: 0 }
      } else if (value === '0.6') {
        entry = { w: 0.6 }
      } else if (value === 'P') {
        entry = { w: 0, p: 1 }
      } else if (value === 'E') {
        // 試験（実習生年次試験など。現場出勤にはカウントしないが給与計算では出勤と同等扱い）
        entry = { w: 0, exam: 1 }
      } else if (value === 'R') {
        // 欠勤（2026-08-31 追加）。月給者はこの記録がある日だけ欠勤控除される。
        //   ブランクは「そもそも所定労働日ではない」扱いで控除されない。
        entry = { w: 0, r: 1 }
      }

      if (entry) {
        entries[day] = entry
      } else {
        delete entries[day]
      }
      next[workerId] = entries
      return next
    })

    let entry: AttEntry | null = null
    if (value === '1') entry = { w: 1, o: 0 }
    else if (value === '0.5') entry = { w: 0.5, o: 0 }
    else if (value === '0.6') entry = { w: 0.6 }
    else if (value === 'P') entry = { w: 0, p: 1 }
    else if (value === 'E') entry = { w: 0, exam: 1 }
    else if (value === 'R') entry = { w: 0, r: 1 }

    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry,
    })
  }, [scheduleSave, workerEntries, data?.workers])

  const handleOtChange = useCallback((workerId: string, day: number, otValue: string) => {
    const ot = parseFloat(otValue) || 0
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day]
      if (existing && existing.w > 0) {
        entries[day] = { ...existing, o: ot }
      }
      next[workerId] = entries
      return next
    })

    // Get current entry to preserve w value
    const current = workerEntries[workerId]?.[day]
    if (current && current.w > 0) {
      const updated = { ...current, o: ot }
      scheduleSave(`w-${workerId}-${day}`, {
        type: 'worker', id: workerId, day, entry: updated,
      })
    }
  }, [scheduleSave, workerEntries])

  // ── Time-based cell handlers (202605〜) ──

  /** 時間ベース: 特殊ステータス変更（P/R/H/出勤/クリア） */
  const handleTimeStatusChange = useCallback((workerId: string, day: number, value: string) => {
    if (!confirmOverwriteStaffEntry(workerId, day, value)) return
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }

      let entry: AttEntry | null = null
      if (value === 'P') {
        entry = { w: 0, p: 1, s: 'admin' }
      } else if (value === 'E') {
        // 試験: 実習生の年次試験など。現場出勤にはカウントしないが給与計算では出勤と同等扱い
        entry = { w: 0, exam: 1, s: 'admin' }
      } else if (value === 'R') {
        entry = { w: 0, r: 1, s: 'admin' }
      } else if (value === 'H') {
        entry = { w: 0, h: 1, s: 'admin' }
      } else if (value === 'C') {
        // 現場都合休みの休業補償（2026-08-25）。w=0.6 が補償日の実体。
        // スタッフは打刻しないので管理者・職長・事業責任者が代理入力する。
        entry = { w: 0.6, s: 'admin' }
      } else if (value === 'W') {
        // 出勤: デフォルト時間で初期化
        entry = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      }

      if (entry) {
        entries[day] = entry
      } else {
        delete entries[day]
      }
      next[workerId] = entries
      return next
    })

    let entry: AttEntry | null = null
    if (value === 'P') entry = { w: 0, p: 1, s: 'admin' }
    else if (value === 'E') entry = { w: 0, exam: 1, s: 'admin' }
    else if (value === 'R') entry = { w: 0, r: 1, s: 'admin' }
    else if (value === 'H') entry = { w: 0, h: 1, s: 'admin' }
    else if (value === 'C') entry = { w: 0.6, s: 'admin' }
    else if (value === 'W') entry = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }

    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry,
    })
  }, [scheduleSave])

  /** 現場の休憩設定（残業h を保存時と同じ決まりで数える・calcOvertimeHours） */
  const siteWs = data?.site.workSchedule

  /** 時間ベース: 始業時間変更 */
  const handleStartTimeChange = useCallback((workerId: string, day: number, st: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, st, s: 'admin' }
      // 残業時間を再計算
      // 残業h は calcOvertimeHours だけで数える（現場の休憩設定・夜勤ブロックは含めない）
      const ot = calcOvertimeHours(updated, siteWs)
      updated.o = ot > 0 ? ot : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    // For save: get current entry and apply
    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, st, s: 'admin' }
    const ot = calcOvertimeHours(updated, siteWs)
    if (ot > 0) updated.o = ot; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
  }, [scheduleSave, workerEntries, siteWs])

  /** 時間ベース: 終業時間変更 */
  const handleEndTimeChange = useCallback((workerId: string, day: number, et: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, et, s: 'admin' }
      // 残業h は calcOvertimeHours だけで数える（現場の休憩設定・夜勤ブロックは含めない）
      const ot = calcOvertimeHours(updated, siteWs)
      updated.o = ot > 0 ? ot : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, et, s: 'admin' }
    const ot = calcOvertimeHours(updated, siteWs)
    if (ot > 0) updated.o = ot; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
  }, [scheduleSave, workerEntries, siteWs])

  /** 時間ベース: 休憩チェック変更 */
  const handleBreakChange = useCallback((workerId: string, day: number, breakKey: 'b1' | 'b2' | 'b3', checked: boolean) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, [breakKey]: checked ? 1 : 0, s: 'admin' }
      // 残業h は calcOvertimeHours だけで数える（現場の休憩設定・夜勤ブロックは含めない）
      const ot = calcOvertimeHours(updated, siteWs)
      updated.o = ot > 0 ? ot : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, [breakKey]: checked ? 1 : 0, s: 'admin' }
    const ot = calcOvertimeHours(updated, siteWs)
    if (ot > 0) updated.o = ot; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
  }, [scheduleSave, workerEntries, siteWs])

  /**
   * 夜勤が発生した日の指定 / 解除（台風待機など）。
   *
   * 「まず夜勤があった日を選び、その日のスタッフだけに夜勤バッジを出す」という流れにするための
   * 日単位の指定。誰が夜勤したかはエントリ側の ns が持つので、これは入力対象日を絞る
   * UIフィルタでしかない（給与計算・所定日数には影響しない）。
   *
   * 解除するとバッジが消えるが、既に登録済みの夜勤エントリ（ns）は消さない。
   * 誤操作で給与が変わらないようにするため。個別の取り消しはモーダルから行う。
   */
  const handleToggleNightDay = useCallback(async (day: number) => {
    const next = nightDays.includes(day)
      ? nightDays.filter(d => d !== day)
      : [...nightDays, day].sort((a, b) => a - b)
    setNightDays(next)   // 楽観更新
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'saveNightDays', siteId, ym, days: next }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch {
      setNightDays(nightDays)  // 失敗したら戻す
      setSaveStatus('error')
    }
  }, [nightDays, password, siteId, ym])

  /** 便ごとの運転者を保存（運転手当の元データ） */
  const handleSaveDrivers = useCallback(async (day: number, am: number[], pm: number[]) => {
    const prev = drivers
    const next = { ...drivers }
    if (am.length === 0 && pm.length === 0) delete next[day]
    else next[day] = { am, pm }
    setDrivers(next)   // 楽観更新
    setDriverDay(null)
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'saveDrivers', siteId, ym, day, am, pm }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch {
      setDrivers(prev)  // 失敗したら戻す
      setSaveStatus('error')
    }
  }, [drivers, password, siteId, ym])

  /**
   * 夜勤の保存 / 取り消し（台風待機など年数回のケース）。
   *
   * 夜勤は w に足さず ns/nst/net で別枠に持つ。w を 1.5 にすると出勤日数が 1.5 日になり、
   * 欠勤判定（所定日数 − 出勤日数）が壊れるため。人工は lib/compute.ts の calcManDays が
   * ns から導出する（夜勤のみ 1.5 / 日勤＋夜勤 2.5）。
   *
   * ⚠️ 「夜勤のみ」に切り替えたときは日勤の時刻・休憩・残業を消す。残しておくと
   *    日勤ブロックと夜勤ブロックの二重計上になる。API 側は computeAttendanceDeleteFields で
   *    エントリに無いフィールドを削除するので、ここで delete すれば残骸は残らない。
   */
  const handleNightSave = useCallback((value: NightShiftValue | null) => {
    if (!nightTarget) return
    const { workerId, day } = nightTarget
    const base = workerEntries[workerId]?.[day]
    if (!base) { setNightTarget(null); return }

    const updated: AttEntry = { ...base, s: 'admin' }
    if (!value) {
      // 夜勤の取り消し
      delete updated.ns
      delete updated.nonly
      delete updated.nst
      delete updated.net
      delete updated.nb
      delete updated.nnote
    } else {
      updated.ns = 1
      updated.nst = value.nst
      updated.net = value.net
      updated.nb = value.nb
      if (value.nonly) updated.nonly = 1; else delete updated.nonly
      if (value.nnote) updated.nnote = value.nnote; else delete updated.nnote
      if (value.nonly) {
        // 夜勤のみ: 日勤ぶんの入力を消す
        delete updated.st
        delete updated.et
        delete updated.b1
        delete updated.b2
        delete updated.b3
        delete updated.o
      }
    }

    setWorkerEntries(prev => {
      const next = { ...prev }
      next[workerId] = { ...(next[workerId] || {}), [day]: updated }
      return next
    })
    scheduleSave(`w-${workerId}-${day}`, { type: 'worker', id: workerId, day, entry: updated })
    setNightTarget(null)
  }, [nightTarget, workerEntries, scheduleSave])

  // ── Subcon cell handlers ──

  const handleSubconNChange = useCallback((subconId: string, day: number, value: string) => {
    const n = parseFloat(value) || 0
    setSubconEntries(prev => {
      const next = { ...prev }
      if (!next[subconId]) next[subconId] = {}
      const entries = { ...next[subconId] }
      const existing = entries[day]
      if (n > 0 || (existing && existing.on > 0)) {
        entries[day] = { n, on: existing?.on ?? 0 }
      } else {
        delete entries[day]
      }
      next[subconId] = entries
      return next
    })

    const existing = subconEntries[subconId]?.[day]
    const on = existing?.on ?? 0
    const subconEntry = (n > 0 || on > 0) ? { n, on } : null
    scheduleSave(`s-${subconId}-${day}`, {
      type: 'subcon', id: subconId, day, entry: null, subconEntry,
    })
  }, [scheduleSave, subconEntries])

  const handleSubconOnChange = useCallback((subconId: string, day: number, value: string) => {
    const on = parseFloat(value) || 0
    setSubconEntries(prev => {
      const next = { ...prev }
      if (!next[subconId]) next[subconId] = {}
      const entries = { ...next[subconId] }
      const existing = entries[day]
      if (on > 0 || (existing && existing.n > 0)) {
        entries[day] = { n: existing?.n ?? 0, on }
      } else {
        delete entries[day]
      }
      next[subconId] = entries
      return next
    })

    const existing = subconEntries[subconId]?.[day]
    const n = existing?.n ?? 0
    const subconEntry = (on > 0 || n > 0) ? { n, on } : null
    scheduleSave(`s-${subconId}-${day}`, {
      type: 'subcon', id: subconId, day, entry: null, subconEntry,
    })
  }, [scheduleSave, subconEntries])

  // ── Save workDays ──

  const workDaysTimer = useRef<NodeJS.Timeout | null>(null)
  const handleWorkDaysChange = useCallback((value: string) => {
    setWorkDaysInput(value)
    if (workDaysTimer.current) clearTimeout(workDaysTimer.current)
    workDaysTimer.current = setTimeout(async () => {
      if (!password || !data) return
      setSaveStatus('saving')
      try {
        const res = await fetch('/api/attendance/grid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': password,
          },
          body: JSON.stringify({
            action: 'saveWorkDays',
            ym: data.ym,
            value: parseFloat(value) || 0,
          }),
        })
        // 権限が無いなどで保存できなかったときに「保存しました」と出さない（2026-09-30 点検）
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          setSaveStatus('error')
          alert(`所定日数を保存できませんでした: ${j.error || res.status}`)
          return
        }
        setSaveStatus('saved')
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      } catch (e) {
        console.error('Save workDays error:', e)
        setSaveStatus(null)
      }
    }, 1000)
  }, [password, data])

  // ── Approval handlers（楽観的UI） ──

  // 職長承認は「該当現場の職長」のみ操作可。adminは閲覧のみ。
  // 応援現場は事業責任者も職長承認できる（入力〜承認をまとめて見る・2026-09-30）
  //   職長でない人が職長に登録されている現場は、政仁さんが職長承認を代行する（その人には押させない・2026-10-01 代表）
  const canForemanApprove = (userRole === 'foreman' && userForemanSites.includes(siteId) && !data?.proxyApproval)
    || (!!data?.isSupportSite && !!userRole && roleCan(permRoleOf({ role: userRole }), 'attendance.inputSupport'))
    || (!!data?.proxyApproval && !!userRole && roleCan(permRoleOf({ role: userRole }), 'attendance.foremanApproveProxy'))
  const canFinalize = userRole === 'admin' || userRole === 'approver'

  // ── 承認の送信（2026-10-02 総合点検）──
  //   旧: 画面を先に更新して fetch(...).catch(() => {}) で、通信結果を見ていなかった。
  //   サーバが断っても（担当外 403・先の日 400・最終承認済みの取り消し 409・職長承認が先 400）画面は承認済みのままで、
  //   月締めで初めて「承認なし」と分かった。結果を見て、失敗した日は表示を戻して理由を出す
  const postApproval = useCallback(async (action: string, day: number): Promise<string | null> => {
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action, siteId, ym, day, approvedBy: userId }),
      })
      if (res.ok) return null
      const j = await res.json().catch(() => ({}))
      return j.error || `エラー（${res.status}）`
    } catch {
      return '通信エラー'
    }
  }, [password, siteId, ym, userId])

  /** まとめて送る（4件ずつ）。失敗した日と理由を返す */
  const postApprovalDays = useCallback(async (action: string, targetDays: number[]): Promise<{ day: number; error: string }[]> => {
    const failed: { day: number; error: string }[] = []
    for (let i = 0; i < targetDays.length; i += 4) {
      const chunk = targetDays.slice(i, i + 4)
      const results = await Promise.all(chunk.map(d => postApproval(action, d)))
      results.forEach((err, idx) => { if (err) failed.push({ day: chunk[idx], error: err }) })
    }
    return failed
  }, [postApproval])

  const alertApprovalFailures = useCallback((label: string, failed: { day: number; error: string }[]) => {
    if (failed.length === 0) return
    const m = Number(ym.slice(4, 6))
    const lines = failed.slice(0, 5).map(f => `・${m}/${f.day}: ${f.error}`).join('\n')
    alert(`${label}できなかった日があります（${failed.length}日）。表示を元に戻しました。\n\n${lines}${failed.length > 5 ? '\n…ほか' : ''}`)
  }, [ym])

  /**
   * まとめて職長承認する日 = 昨日までで、誰かの入力があって、職長承認がまだの日（「今やること」の件数と同じ）。
   * 2026-10-02 総合点検: 旧実装は月の全部の日（先の日・誰も入力していない日も）を承認していた。
   *   承認済みの日はスタッフのスマホが打刻を拒否するので、月末まで打刻できなくなる（9/2 の誤承認と同じ形）。
   *   今日の分は、スタッフが作業後に打刻するので、まとめてには入れない（1日ずつなら承認できる）
   */
  const foremanBulkDays = useMemo(() => {
    if (!data) return [] as number[]
    const todayIso = todayJstIso()
    const withInput = new Set<number>()
    for (const ent of Object.values(workerEntries)) {
      for (const [d, e] of Object.entries(ent || {})) if (e) withInput.add(Number(d))
    }
    for (const ent of Object.values(subconEntries)) {
      for (const [d, e] of Object.entries(ent || {})) if (e && ((e.n || 0) > 0 || (e.on || 0) > 0)) withInput.add(Number(d))
    }
    const isoOf = (d: number) => `${data.year}-${String(data.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    return Array.from({ length: data.daysInMonth }, (_, i) => i + 1)
      .filter(d => withInput.has(d) && isoOf(d) < todayIso && !localApprovals[d])
  }, [data, workerEntries, subconEntries, localApprovals])

  const handleForemanApproveAll = useCallback(async () => {
    if (!data || foremanBulkDays.length === 0) return
    const target = foremanBulkDays
    setLocalApprovals(prev => { const next = { ...prev }; for (const d of target) next[d] = true; return next })
    const failed = await postApprovalDays('approve_foreman', target)
    if (failed.length > 0) {
      setLocalApprovals(prev => { const next = { ...prev }; for (const f of failed) delete next[f.day]; return next })
      alertApprovalFailures('承認', failed)
    }
  }, [data, foremanBulkDays, postApprovalDays, alertApprovalFailures])

  const handleToggleForemanApproval = useCallback(async (day: number) => {
    const approved = !!localApprovals[day]
    const hadFinal = !!localFinalApprovals[day]
    setLocalApprovals(prev => ({ ...prev, [day]: !approved }))
    // 解除する場合は最終承認も画面上で消す（API側が連動して削除する）
    if (approved) {
      setLocalFinalApprovals(prev => {
        const next = { ...prev }
        delete next[day]
        return next
      })
    }
    const err = await postApproval(approved ? 'unapprove_foreman' : 'approve_foreman', day)
    if (err) {
      setLocalApprovals(prev => ({ ...prev, [day]: approved }))
      if (approved && hadFinal) setLocalFinalApprovals(prev => ({ ...prev, [day]: true }))
      alertApprovalFailures(approved ? '承認を取り消し' : '承認', [{ day, error: err }])
    }
  }, [localApprovals, localFinalApprovals, postApproval, alertApprovalFailures])

  const handleFinalApproveAll = useCallback(async () => {
    if (!data) return
    // 職長承認済かつ最終未承認の日だけが対象
    const finalizableDays = Array.from({ length: data.daysInMonth }, (_, i) => i + 1)
      .filter(d => localApprovals[d] && !localFinalApprovals[d])
    if (finalizableDays.length === 0) return
    setLocalFinalApprovals(prev => { const next = { ...prev }; for (const d of finalizableDays) next[d] = true; return next })
    const failed = await postApprovalDays('approve_final', finalizableDays)
    if (failed.length > 0) {
      setLocalFinalApprovals(prev => { const next = { ...prev }; for (const f of failed) delete next[f.day]; return next })
      alertApprovalFailures('最終承認', failed)
    }
  }, [data, localApprovals, localFinalApprovals, postApprovalDays, alertApprovalFailures])

  const handleToggleFinalApproval = useCallback(async (day: number) => {
    const finalApproved = !!localFinalApprovals[day]
    setLocalFinalApprovals(prev => ({ ...prev, [day]: !finalApproved }))
    const err = await postApproval(finalApproved ? 'unapprove_final' : 'approve_final', day)
    if (err) {
      setLocalFinalApprovals(prev => ({ ...prev, [day]: finalApproved }))
      alertApprovalFailures(finalApproved ? '最終承認を取り消し' : '最終承認', [{ day, error: err }])
    }
  }, [localFinalApprovals, postApproval, alertApprovalFailures])

  // ── Computed: grouped workers ──

  const groupedWorkers = useMemo(() => {
    if (!data) return []
    // 並び順: 日本人（visa=none）を先に → 同区分内は ID 昇順
    //   ID 採番が帯域別（日本人=1-99 / 外国人=100-200番台 / 事務=300番台）になったため、
    //   素直に visa→id 昇順で並べると 入力しやすい順番（職人→ベトナム→事務）になる。
    const sortFn = (a: Worker, b: Worker) => {
      const aIsJp = !a.visa || a.visa === 'none'
      const bIsJp = !b.visa || b.visa === 'none'
      if (aIsJp !== bIsJp) return aIsJp ? -1 : 1
      return a.id - b.id
    }
    // filter() で既に新しい配列が返るため slice() は不要
    const hibi = data.workers.filter(w => w.org === 'hibi').sort(sortFn)
    const hfu = data.workers.filter(w => w.org === 'hfu').sort(sortFn)
    const groups: { org: string; label: string; workers: Worker[] }[] = []
    if (hibi.length > 0) groups.push({ org: 'hibi', label: '日比建設', workers: hibi })
    if (hfu.length > 0) groups.push({ org: 'hfu', label: 'HFU', workers: hfu })
    return groups
  }, [data])

  // ── Computed: day info ──

  const days = useMemo(() => {
    if (!data) return []
    return Array.from({ length: data.daysInMonth }, (_, i) => {
      const day = i + 1
      const dow = getDow(data.year, data.month, day)
      return { day, dow, label: DOW_JA[dow] }
    })
  }, [data])

  // ── Computed: worker/subcon totals ──

  const workerTotals = useCallback((workerId: string) => {
    const entries = workerEntries[workerId] || {}
    // 外国人のみ時間ベース計算（202605〜かつvisaあり）
    // 2026-06-13: 旧契約継続者(フン等)はレガシー日数ベース計算なので時間ベースから除外
    const worker = data?.workers.find(w => String(w.id) === workerId)
    const foreign = !!worker?.visa && worker.visa !== 'none' && worker.visa !== ''
    const timeBased = useTimeBased && foreign && !worker?.useOldRules
    return computeWorkerTotals(entries, { timeBased, foreign })
  }, [workerEntries, useTimeBased, data])

  const subconTotals = useCallback((subconId: string) => {
    return computeSubconTotals(subconEntries[subconId] || {})
  }, [subconEntries])

  // ── Computed: footer summary rows ──

  const footerSums = useMemo(() => {
    if (!data) return EMPTY_FOOTER_SUMS
    return computeFooterSums(data.daysInMonth, data.workers, data.subcons, workerEntries, subconEntries)
  }, [data, workerEntries, subconEntries])

  // ── Computed: validation warnings ──

  // 日曜と休日は同じ日に重なるため1つに統合（2026-08-03）。詳細は lib/attendance-grid.ts
  const restDayWarnings = useMemo(() => {
    if (!data) return []
    return collectRestDayWorkWarnings(
      data.year, data.month, data.daysInMonth, data.calendarDays, data.workers, workerEntries,
    )
  }, [data, workerEntries])

  /**
   * 工種の重複（同じ人・同じ日が2つ以上の工種に入っている）警告（2026-09-25）。
   * 数字での自動判定なので lib/site-hierarchy.ts の findWorkTypeDuplicates の結果を
   * そのまま使う（サーバ側で親+工種サイトの att をなぞって作っている）。
   */
  const workTypeSiteName = useCallback((sid: string) => {
    if (!data) return sid
    if (sid === data.site.id) return data.site.workType || '親現場'
    return data.workTypeSites?.find(s => s.id === sid)?.workType || sid
  }, [data])
  const workTypeWarnings = useMemo(() => {
    if (!data?.workTypeDuplicates?.length) return []
    return data.workTypeDuplicates.map(d => {
      const name = d.kind === 'worker'
        ? data.workers.find(w => String(w.id) === d.id)?.name || `ID:${d.id}`
        : data.subcons.find(sc => sc.id === d.id)?.name || d.id
      return { workerName: name, day: d.day, suffix: d.siteIds.map(workTypeSiteName).join('と') }
    })
  }, [data, workTypeSiteName])

  // ── Assignment modal handlers ──

  const handleSaveAssign = useCallback(async (
    workerIds: number[],
    subconIds: string[],
    expectedSiteId: string,
    expectedYm: string,
  ) => {
    if (!password || !data) return
    // 🛡 多層防御: モーダル open 時点の siteId/ym と現在のものが食い違うと
    //   別現場/別月の配置データで上書きしてしまう。明示的に拒否してアラート。
    //   (2026-05-27 sasazuka → IHIメンバー上書き事案の再発防止)
    if (data.site.id !== expectedSiteId || ym !== expectedYm) {
      alert(
        `⚠️ 配置編集中にサイト/月が切り替わったため保存を中止しました。\n\n` +
        `編集開始時: ${expectedSiteId} / ${expectedYm}\n` +
        `現在: ${data.site.id} / ${ym}\n\n` +
        `モーダルを閉じてから再度開いて、編集をやり直してください。`
      )
      setShowAssignModal(false)
      return
    }
    setSaveStatus('saving')
    // 2026-10-02 総合点検: 応答を見て、断られたら（担当外 403・締め済み 409・通信エラー）理由を出してモーダルを閉じない。
    //   旧: 応答を見ずに「保存済み」と出してモーダルを閉じ、再取得で黙って元に戻っていた
    const res = await postJson('/api/attendance/grid', {
      action: 'saveAssign',
      siteId: data.site.id,
      ym,  // 2026-05-19: ym を必ず送って massign[siteId_ym] も更新させる
      workerIds,
      subconIds,
    }, { password })
    if (!res.ok) {
      setSaveStatus('error')
      alert(`配置を保存できませんでした。\n${res.error || ''}`)
      return
    }
    setSaveStatus('saved')
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
    setShowAssignModal(false)
    // Refresh grid
    fetchData()
  }, [password, data, ym, fetchData])

  // ── 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25） ──
  //
  // 作業員ごとの「既定の工種」（新しく入力した日をどの工種サイトに保存するか）を保存する。
  // workerEntries（セルの中身）はどの id 由来でも同じ値を表示しているだけなので、
  // ここで書き換わるのは data.defaultWorkType / defaultWorkTypeSubcon だけでよい。
  const handleChangeDefaultWorkType = useCallback(async (
    workerId: string, workTypeSiteId: string | null, kind: 'worker' | 'subcon' = 'worker',
  ) => {
    if (!password || !data) return
    const prevMap = kind === 'worker' ? data.defaultWorkType : data.defaultWorkTypeSubcon
    setData(prev => {
      if (!prev) return prev
      const key = kind === 'worker' ? 'defaultWorkType' : 'defaultWorkTypeSubcon'
      const nextMap = { ...(prev[key] || {}) }
      if (workTypeSiteId) nextMap[workerId] = workTypeSiteId
      else delete nextMap[workerId]
      return { ...prev, [key]: nextMap }
    })
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'saveDefaultWorkType',
          siteId: data.site.id,
          ym,
          ...(kind === 'worker' ? { workerId } : { subconId: workerId }),
          workTypeSiteId: workTypeSiteId || undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch (e) {
      console.error('Save default work type error:', e)
      // 失敗したら戻す
      setData(prev => {
        if (!prev) return prev
        const key = kind === 'worker' ? 'defaultWorkType' : 'defaultWorkTypeSubcon'
        return { ...prev, [key]: prevMap }
      })
      alert('既定の工種の保存に失敗しました')
    }
  }, [password, data, ym])

  /**
   * 1日分の出面エントリを、親現場 ⇄ 工種サイトの間で移動する（日付のタグをタップ）。
   * エントリの中身（workerEntries の値）はそのままで、「どの id に入っているか」
   * （data.entrySiteByWorkerDay / entrySiteBySubconDay）だけが変わる。
   */
  const handleMoveWorkType = useCallback(async (
    entryId: string, day: number, toSiteId: string, kind: 'worker' | 'subcon' = 'worker',
  ) => {
    if (!password || !data) return
    const mapKey = kind === 'worker' ? 'entrySiteByWorkerDay' : 'entrySiteBySubconDay'
    const prevSite = (data[mapKey] || {})[entryId]?.[day]
    setData(prev => {
      if (!prev) return prev
      const outer = { ...(prev[mapKey] || {}) }
      outer[entryId] = { ...(outer[entryId] || {}), [day]: toSiteId }
      return { ...prev, [mapKey]: outer }
    })
    setSaveStatus('saving')
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'moveWorkType',
          siteId: data.site.id,
          ym,
          day,
          ...(kind === 'worker' ? { workerId: entryId } : { subconId: entryId }),
          toSiteId,
        }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.error || `保存に失敗しました (${res.status})`)
      }
      setSaveStatus('saved')
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
    } catch (e) {
      console.error('Move work type error:', e)
      // 失敗したら戻して再取得（重複ガード等でサーバ側が拒否した場合に画面を確実に合わせる）
      setData(prev => {
        if (!prev) return prev
        const outer = { ...(prev[mapKey] || {}) }
        if (prevSite) outer[entryId] = { ...(outer[entryId] || {}), [day]: prevSite }
        else if (outer[entryId]) { const { [day]: _omit, ...rest } = outer[entryId]; outer[entryId] = rest }
        return { ...prev, [mapKey]: outer }
      })
      setSaveStatus(null)
      alert(e instanceof Error ? e.message : '工種の切替に失敗しました')
      fetchData()
    }
  }, [password, data, ym, fetchData])

  /**
   * 日単位（複数日も可）で工種を決める（2026-09-25・社長「鉄骨は毎日あるとは限らない」）。
   * その日の新しい入力の保存先を変え、既に入っている全員のその日の入力も同じ工種へ移す。
   * 2箇所に入っている人はサーバが移さずに返してくるので、その名前を知らせる。
   * 移動件数が多いので楽観更新はせず、終わったら取り直す。
   */
  const handleSetDayWorkType = useCallback(async (days: number[], toSiteId: string) => {
    if (!password || !data || days.length === 0) return
    setSaveStatus('saving')
    try {
      const res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'setDayWorkType', siteId: data.site.id, ym, days, toSiteId }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || `保存に失敗しました (${res.status})`)
      setSaveStatus('saved')
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      const skipped = (json?.skipped || []) as { name: string; day: number }[]
      if (skipped.length > 0) {
        alert(
          `工種を切り替えましたが、次の人は2つの工種の両方に入力があるため動かしていません。\n` +
          `マスのタグでどちらかを選び直してください。\n\n` +
          skipped.map(s => `  ${s.day}日 ${s.name}`).join('\n'),
        )
      }
    } catch (e) {
      console.error('Set day work type error:', e)
      setSaveStatus(null)
      alert(e instanceof Error ? e.message : '工種の切替に失敗しました')
    }
    fetchData()
  }, [password, data, ym, fetchData])

  // 「期間で切り替え」の入力（from 日・to 日・工種）
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(1)
  const [rangeSiteId, setRangeSiteId] = useState('')
  useEffect(() => {
    // 現場・月が変わったら範囲を1日〜末日に戻し、工種は先頭の工種サイトにする
    setRangeFrom(1)
    setRangeTo(data?.daysInMonth || 1)
    setRangeSiteId(data?.workTypeSites?.[0]?.id || '')
  }, [data?.site.id, data?.ym, data?.daysInMonth, data?.workTypeSites])

  // ── 一括入力（2026-09-30）──
  //   入力できるのは attendance.input の人、または応援現場での attendance.inputSupport（事業責任者）
  const canInputHere = !!userRole && (
    roleCan(permRoleOf({ role: userRole }), 'attendance.input')
    || (!!data?.isSupportSite && roleCan(permRoleOf({ role: userRole }), 'attendance.inputSupport'))
  )
  /** さかのぼり入力ができる人（代表・事業責任者。lib/permissions.ts attendance.backfill） */
  const canBackfillRole = !!userRole && roleCan(permRoleOf({ role: userRole }), 'attendance.backfill')
  const lockedDays = useMemo(() => {
    const s = new Set<number>()
    for (const [d, v] of Object.entries(localApprovals)) if (v) s.add(Number(d))
    for (const [d, v] of Object.entries(localFinalApprovals)) if (v) s.add(Number(d))
    if (data?.locked) for (let d = 1; d <= (data?.daysInMonth || 0); d++) s.add(d)
    return s
  }, [localApprovals, localFinalApprovals, data?.locked, data?.daysInMonth])
  const applyBulk = useCallback((items: BulkItem[]) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      for (const it of items) {
        const row = { ...(next[it.workerId] || {}) }
        if (it.entry) row[it.day] = it.entry; else delete row[it.day]
        next[it.workerId] = row
      }
      return next
    })
    for (const it of items) {
      scheduleSave(`w-${it.workerId}-${it.day}`, { type: 'worker', id: it.workerId, day: it.day, entry: it.entry })
    }
  }, [scheduleSave])

  // ── Render ──

  // ── 今やること・確認すること（2026-10-01 出面入力の改修・見本キャンバス7段目）──
  //   数え方は表の承認行・各注意書きと同じ。表示のための集計だけで、保存・承認の処理は変えない
  const todayIsoA = todayJstIso()
  const dayIsoOf = (d: number) => data ? `${data.year}-${String(data.month).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''
  // 職長承認がまだ = 昨日までで、誰かの入力があって、職長承認が付いていない日（上の foremanBulkDays と同じ集合）。
  //   今日の分は出さない（2026-10-02 代表: ベトナム人スタッフは作業後にスマホで打刻するので、承認は翌日でよい）
  const foremanWaitDays = foremanBulkDays
  // 最終承認待ち = 職長承認済みで最終承認がまだの日（表の「まとめて最終承認」と同じ）
  const finalWaitDays = days.filter(d => localApprovals[d.day] && !localFinalApprovals[d.day]).map(d => d.day)
  const daysLabel = (ds: number[]) => ds.length <= 3 ? ds.map(d => `${data?.month}/${d}`).join('・') : `${data?.month}/${ds[0]}〜${ds[ds.length - 1]}`
  // 翌月の就業カレンダーは、開いている現場（工種サイトなら親）の分だけ数える（2026-10-02 点検: 全社の件数がどの現場にも出ていた）
  const calSiteIdHere = (data?.site as { parentId?: string } | undefined)?.parentId || data?.site.id
  const nmSites = (nextMonthCalCheck?.sites || []).filter(s => s.siteId === calSiteIdHere)
  const nmNotReady = nmSites.filter(s => !s.status || s.status === 'draft' || s.status === 'rejected').length
  const nmSubmitted = nmSites.filter(s => s.status === 'submitted').length
  // 帰国の予定は「確認すること」に数えない（2026-10-02 代表: 会社全体の帰国予定が全現場に出て、毎回開く必要がなかった）。
  //   帰国中はセルに「帰国中」と出る。開いた中の帰国情報は、この現場に配置されている人だけにする
  const siteWorkerIds = new Set((data?.workers || []).map(w => w.id))
  const siteHomeLeaves = (data?.homeLeaves || []).filter(h => siteWorkerIds.has(h.workerId))
  const checkItems: string[] = []
  if (nmNotReady > 0) checkItems.push(`翌月の就業カレンダー 未作成 ${nmNotReady}件`)
  else if (nmSubmitted > 0) checkItems.push(`翌月の就業カレンダー 承認待ち ${nmSubmitted}件`)
  if (restDayWarnings.length > 0) checkItems.push(`休日の出勤 ${restDayWarnings.length}件`)
  if (workTypeWarnings.length > 0) checkItems.push(`工種の重複 ${workTypeWarnings.length}件`)
  if ((data?.restMismatch?.length || 0) > 0) checkItems.push(`休みの区別 ${data!.restMismatch!.length}件`)
  // 退職予定も、この現場の配置の人だけ（2026-10-02 点検: 他の現場の退職予定が全現場の「確認すること」に出ていた）
  const siteRetirements = (data?.upcomingRetirements || []).filter(r => (data?.workers || []).some(w => w.id === r.id && !w.offRoster))
  if (siteRetirements.length > 0) checkItems.push(`退職予定 ${siteRetirements.length}名`)
  const reqTotal = reqCounts.leave + reqCounts.home
  const scrollToGrid = () => document.getElementById('att-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="space-y-4">
      {userRole && !canInputHere && (
        <div className="rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600 border border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700">
          出面の入力は職長・事務が行います（最終承認は下の「最終承認」行から）。{roleCan(permRoleOf({ role: userRole }), 'attendance.workType') && '工種（鉄骨・仮設など）の切り替えはできます。'}
          {roleCan(permRoleOf({ role: userRole }), 'attendance.inputSupport') && ' 応援現場では出面を入力できます（一括入力あり）。'}
          {roleCan(permRoleOf({ role: userRole }), 'attendance.backfill') && ' 昨日までの日は、出面を直接直せます。本人の入力が無い日は、表の上の「今から変更する」を押すと入れられます。'}
        </div>
      )}
      {userRole && data?.isSupportSite && roleCan(permRoleOf({ role: userRole }), 'attendance.inputSupport') && !roleCan(permRoleOf({ role: userRole }), 'attendance.input') && (
        <div className="rounded-lg px-3 py-2 text-sm bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800">
          応援現場です。出面の入力・配置・運転の記録ができます。まとめて入れるときは「一括入力」を使ってください。
        </div>
      )}
      <HeaderBar
        data={data}
        useTimeBased={useTimeBased}
        saveStatus={saveStatus}
        workDaysInput={workDaysInput}
        siteId={siteId}
        ym={ym}
        showArchived={showArchived}
        allSites={allSites}
        ymOptions={ymOptions}
        onOpenAssign={() => setShowAssignModal(true)}
        onOpenHistory={() => setShowHistory(true)}
        onOpenBulk={canInputHere ? () => setShowBulk(true) : undefined}
        onWorkDaysChange={handleWorkDaysChange}
        onSiteChange={setSiteId}
        onYmChange={setYm}
        onShowArchivedChange={setShowArchived}
      />

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-12 text-center text-gray-400">
          <svg className="animate-spin h-6 w-6 mx-auto mb-2 text-hibi-navy" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* ── 今やること（2026-10-01）。表が上のほうから始まるよう、低い帯にする ── */}
      {!loading && data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
          <TodoStrip icon="check" tone={foremanWaitDays.length > 0 ? 'urgent' : 'ok'}
            title="職長承認がまだ"
            big={foremanWaitDays.length > 0 ? `${foremanWaitDays.length}日（${daysLabel(foremanWaitDays)}）` : 'ありません'}
            onClick={foremanWaitDays.length > 0 ? scrollToGrid : undefined} label="表の職長承認の行へ" />
          <TodoStrip icon="check" tone={finalWaitDays.length > 0 ? 'info' : 'ok'}
            title="最終承認待ち"
            big={finalWaitDays.length > 0 ? `${finalWaitDays.length}日` : 'ありません'}
            onClick={finalWaitDays.length > 0 ? scrollToGrid : undefined} label="表の最終承認の行へ" />
          <TodoStrip icon="doc" tone={reqTotal > 0 ? 'warn' : 'ok'}
            title="申請（有給・帰国）"
            big={reqTotal > 0 ? `${reqTotal}件` : 'ありません'}
            onClick={reqTotal > 0 ? () => setRequestsOpen(true) : undefined} label="申請を開く" />
          <TodoStrip icon="alert" tone={checkItems.length > 0 ? 'warn' : 'ok'}
            title="確認すること"
            big={checkItems.length > 0 ? `${checkItems.length}件` : 'ありません'}
            onClick={checkItems.length > 0 ? () => setChecksOpen(v => !v) : undefined} label="確認することを開く" />
        </div>
      )}

      {/* ── 勤怠申請（2026-05-18 追加）。2026-10-01: 上に張り付くバーをやめ、「申請」の帯から右に開くパネルに。
          閉じていても件数は取りに行く（上の帯に出すため） ── */}
      {password && userRole && (
        <AttendanceActionBar
          password={password}
          userRole={userRole}
          userWorkerId={userId}
          userForemanSites={userForemanSites}
          onUpdate={fetchData}
          variant="panel"
          open={requestsOpen}
          onClose={() => setRequestsOpen(false)}
          onCounts={setReqCounts}
        />
      )}

      {/* 帰国の予定は件数に数えないが、ほかに確認することが無い現場でも見えるように出す（2026-10-02 点検: #36 で見えなくなっていた） */}
      {!loading && data && checkItems.length === 0 && siteHomeLeaves.length > 0 && (
        <HomeLeaveBanner homeLeaves={siteHomeLeaves} />
      )}
      {/* ── 確認すること: ふだんは1行の要約。開くと今までの注意書きを並べる（中身・動きは旧と同じ） ── */}
      {!loading && data && checkItems.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/15 overflow-hidden">
          <button type="button" onClick={() => setChecksOpen(v => !v)} aria-expanded={checksOpen}
            className="w-full px-4 py-2.5 flex items-center gap-2.5 text-left">
            <Icon name="alert" size={16} className="text-amber-700 dark:text-amber-300 shrink-0" />
            <span className="text-sm font-bold text-gray-900 dark:text-white whitespace-nowrap">確認すること {checkItems.length}件</span>
            <span className="text-[13px] text-amber-900 dark:text-amber-200 truncate min-w-0">{checkItems.join('・')}</span>
            <span className="ml-auto text-[13px] font-bold text-hibi-navy dark:text-blue-300 whitespace-nowrap">{checksOpen ? '閉じる' : '開く'}</span>
          </button>
          {checksOpen && (
            <div className="px-3 pb-3 space-y-2">
              {/* 翌月カレンダー未確定アラート（components/attendance/NextMonthCalendarBanner.tsx に集約） */}
              <NextMonthCalendarBanner check={nextMonthCalCheck ? { ...nextMonthCalCheck, sites: nmSites } : null} />
              {/* 休日・日曜の出勤警告。1日につき1件だけ出す（日曜と休日で二重表示しない） */}
              <AttendanceWarningBanner
                title="休日・日曜の出勤あり"
                items={restDayWarnings.map(w => ({ workerName: w.workerName, day: w.day, suffix: w.dayType }))}
                tone="orange"
              />

              {/* 工種の重複（同じ人・同じ日が2つ以上の工種に入っている・2026-09-25） */}
              <AttendanceWarningBanner
                title="工種の重複あり（両方に入力されています）"
                items={workTypeWarnings}
                tone="warning"
              />

              {/* 帰国情報バナー（components/attendance/HomeLeaveBanner.tsx に集約） */}
              <HomeLeaveBanner homeLeaves={siteHomeLeaves} />
              {/* 休みの区別の取り違えの疑い（職長承認の前に気づけるように・2026-09-30） */}
              {data && <RestMismatchBanner items={data.restMismatch} workers={data.workers} month={data.month} />}

              {/* 退職予定バナー（components/attendance/UpcomingRetirementsBanner.tsx に集約） */}
              <UpcomingRetirementsBanner retirements={siteRetirements} />

            </div>
          )}
        </div>
      )}

      {/* 期間で工種を切り替える（工種のある現場だけ・2026-09-25）。
          「26日〜30日は鉄骨工事」のように日をまとめて決める。1日だけなら日付の見出しのチップでもよい */}
      {!loading && data && !!data.workTypeSites?.length && !data.locked && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-bold text-hibi-navy dark:text-gray-200">期間で工種を切り替え</span>
          <select value={rangeFrom} onChange={e => setRangeFrom(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-2 py-1.5 bg-white dark:bg-gray-700 dark:border-gray-600">
            {Array.from({ length: data.daysInMonth }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}日</option>)}
          </select>
          <span className="text-gray-500">〜</span>
          <select value={rangeTo} onChange={e => setRangeTo(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-2 py-1.5 bg-white dark:bg-gray-700 dark:border-gray-600">
            {Array.from({ length: data.daysInMonth }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}日</option>)}
          </select>
          <span className="text-gray-500">は</span>
          <select value={rangeSiteId} onChange={e => setRangeSiteId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 bg-white dark:bg-gray-700 dark:border-gray-600 font-bold">
            {data.workTypeSites.map(s => <option key={s.id} value={s.id}>{s.workType}</option>)}
            <option value={data.site.id}>{data.site.workType || '親現場'}</option>
          </select>
          <button
            type="button"
            onClick={() => {
              const from = Math.min(rangeFrom, rangeTo), to = Math.max(rangeFrom, rangeTo)
              const days = Array.from({ length: to - from + 1 }, (_, i) => from + i)
              const label = rangeSiteId === data.site.id ? (data.site.workType || '親現場') : (data.workTypeSites?.find(s => s.id === rangeSiteId)?.workType || '')
              if (!confirm(`${from}日〜${to}日を「${label}」にします。\nこの期間に入力済みの人の出面も全員まとめて「${label}」へ移ります。\nよろしいですか？`)) return
              handleSetDayWorkType(days, rangeSiteId || data.site.id)
            }}
            className="px-4 py-1.5 rounded-lg bg-hibi-navy text-white font-bold hover:bg-[#243656] transition"
          >
            適用
          </button>
          <span className="text-xs text-gray-500 basis-full sm:basis-auto">
            1日だけなら、日付の見出しのチップを押して選べます。個別の例外はマスのタグで。
          </span>
        </div>
      )}

      {/* ── Grid Table ── */}
      {!loading && data && (
        <div id="att-grid" className="scroll-mt-4">
        {/* さかのぼり入力（代表・事業責任者だけ・2026-10-02）: ふだんは出さず、「今から変更する」を押したときだけ
             本人の入力が無い昨日までのマスに選択を出す（代表: 常に出すのは too much） */}
        {canBackfillRole && (
          <div className={`mb-2 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm border ${
            backfillMode
              ? 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-200'
              : 'bg-white border-gray-200 text-gray-600 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300'
          }`}>
            {backfillMode
              ? <span>変更中: 本人の入力が無い昨日までのマスに「入れる…」が出ています（入れた内容は操作ログに残ります）</span>
              : <span>本人の入力が無い日を、さかのぼって入れるとき</span>}
            <button type="button" onClick={() => setBackfillMode(v => !v)}
              className={`ml-auto px-3 py-1 rounded-lg text-sm font-bold ${
                backfillMode
                  ? 'bg-white border border-amber-400 text-amber-800 hover:bg-amber-100 dark:bg-gray-800 dark:text-amber-200'
                  : 'bg-hibi-navy text-white hover:bg-hibi-light'
              }`}>
              {backfillMode ? '変更を終える' : '今から変更する'}
            </button>
          </div>
        )}
        <AttendanceGrid
          data={data}
          days={days}
          cellWidth={cellWidth}
          nameWidth={nameWidth}
          useTimeBased={useTimeBased}
          groupedWorkers={groupedWorkers}
          workerEntries={workerEntries}
          subconEntries={subconEntries}
          footerSums={footerSums}
          localApprovals={localApprovals}
          localFinalApprovals={localFinalApprovals}
          canForemanApprove={canForemanApprove}
          canFinalize={canFinalize}
          startTimeOptions={startTimeOptions}
          endTimeOptions={endTimeOptions}
          workerTotals={workerTotals}
          subconTotals={subconTotals}
          onWorkChange={handleWorkChange}
          onOtChange={handleOtChange}
          onTimeStatusChange={handleTimeStatusChange}
          canBackfill={canBackfillRole && backfillMode}
          onStartTimeChange={handleStartTimeChange}
          onEndTimeChange={handleEndTimeChange}
          onBreakChange={handleBreakChange}
          onSubconNChange={handleSubconNChange}
          onSubconOnChange={handleSubconOnChange}
          onCellKeyDown={handleAttCellKeyDown}
          onNightClick={(workerId, day) => setNightTarget({ workerId, day })}
          nightDays={nightDays}
          onToggleNightDay={handleToggleNightDay}
          drivers={drivers}
          onDriverClick={data.site.noDriveAllowance ? undefined : setDriverDay}
          onForemanApproveAll={handleForemanApproveAll}
          foremanBulkCount={foremanBulkDays.length}
          onToggleForemanApproval={handleToggleForemanApproval}
          onFinalApproveAll={handleFinalApproveAll}
          onToggleFinalApproval={handleToggleFinalApproval}
          workTypeSites={data.workTypeSites}
          dayWorkType={data.dayWorkType}
          onSetDayWorkType={(day, toSiteId) => handleSetDayWorkType([day], toSiteId)}
          defaultWorkType={data.defaultWorkType}
          defaultWorkTypeSubcon={data.defaultWorkTypeSubcon}
          entrySiteByWorkerDay={data.entrySiteByWorkerDay}
          entrySiteBySubconDay={data.entrySiteBySubconDay}
          onChangeDefaultWorkType={(workerId, siteId) => handleChangeDefaultWorkType(workerId, siteId, 'worker')}
          onChangeDefaultWorkTypeSubcon={(subconId, siteId) => handleChangeDefaultWorkType(subconId, siteId, 'subcon')}
          onMoveWorkType={(workerId, day, toSiteId) => handleMoveWorkType(workerId, day, toSiteId, 'worker')}
          onMoveWorkTypeSubcon={(subconId, day, toSiteId) => handleMoveWorkType(subconId, day, toSiteId, 'subcon')}
        />
        </div>
      )}

      {/* No data placeholder */}
      {!loading && !error && !data && !siteId && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-12 text-center text-gray-400">
          現場を選択してください
        </div>
      )}

      {/* ── Assignment Modal ── */}
      {showAssignModal && data && (
        // 🛡 重要: key に siteId+ym を含めることで、開いている間にサイト・月が
        // 切り替わった場合に強制 re-mount し、内部 state を新しい配置で初期化する。
        // これをしないと、サイト切替後に古いサイトの workers がそのまま新しい
        // サイトに保存されるバグが起きる（2026-05-27 sasazuka → IHIメンバー上書き事案）。
        <AssignModal
          key={`assign-modal-${data.site.id}-${ym}`}
          siteId={data.site.id}
          ym={ym}
          siteName={data.site.name}
          // 配置外の入力の人（offRoster）は配置に入っていないので、配置の編集では「配置済み」にしない（保存で配置に入ってしまう）
          currentWorkerIds={data.workers.filter(w => !w.offRoster).map(w => w.id)}
          allWorkers={data.allWorkers || []}
          currentSubconIds={data.subcons.map(sc => sc.id)}
          allSubcons={data.allSubcons || []}
          onSave={handleSaveAssign}
          onClose={() => setShowAssignModal(false)}
        />
      )}

      {/* 夜勤モーダル（台風待機など） */}
      <NightShiftModal
        isOpen={!!nightTarget}
        workerName={data?.workers.find(w => String(w.id) === nightTarget?.workerId)?.name || ''}
        day={nightTarget?.day || 0}
        entry={nightTarget ? workerEntries[nightTarget.workerId]?.[nightTarget.day] : null}
        onSave={handleNightSave}
        onClose={() => setNightTarget(null)}
      />

      <BulkEntryModal
        open={showBulk}
        onClose={() => setShowBulk(false)}
        ym={data?.ym || ym}
        daysInMonth={data?.daysInMonth || 31}
        // 配置外の入力の人（offRoster）は一括入力の対象にしない（選び間違えた現場にまとめて出勤が入ってしまう・2026-10-02 点検）
        workers={(data?.workers || []).filter(w => !w.offRoster)}
        entries={workerEntries}
        calendarDays={data?.calendarDays || null}
        lockedDays={lockedDays}
        timeBasedFor={w => useTimeBased && !!w.visa && w.visa !== 'none' && w.visa !== '' && !w.useOldRules}
        onApply={applyBulk}
        homeLeaves={data?.homeLeaves}
        workSchedule={siteWs}
      />
      <HistoryModal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        ym={ym}
        password={password}
        workerNames={Object.fromEntries((data?.workers || []).map(w => [w.id, w.name]))}
        onRestored={() => { fetchData() }}
      />

      <DriverModal
        isOpen={driverDay !== null}
        day={driverDay ?? 0}
        siteName={data?.site.name || ''}
        workers={(data?.workers || [])
          .filter(w => canDriveDefault(w))   // 運転しうる人だけ（未設定なら日本人のみ）
          .filter(w => {
            // その日に出面のある人だけを選択肢に（実働・夜勤。0.6補償や休みは出ない）
            const e = driverDay !== null ? workerEntries[String(w.id)]?.[driverDay] : null
            if (!e) return false
            const wv = e.w || 0
            return (wv > 0 && wv !== 0.6) || !!e.ns
          })
          .map(w => ({ id: w.id, name: w.name }))}
        current={driverDay !== null ? drivers[driverDay] : undefined}
        onSave={(am, pm) => { if (driverDay !== null) handleSaveDrivers(driverDay, am, pm) }}
        onClose={() => setDriverDay(null)}
      />
    </div>
  )
}
