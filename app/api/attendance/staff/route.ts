import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken, mapRawWorkers } from '@/lib/workers'
import {
  getAttendanceDoc,
  setAttendanceEntry,
  getApprovalForDay,
  getStaffSites,
  getEntryStatus,
  ymKey,
  attKey,
  formatDateJP,
  formatDateShort,
  computeAttendanceDeleteFields,
} from '@/lib/attendance'
import { getSites } from '@/lib/sites'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { AttendanceEntry } from '@/types'
import { recordAccess, getRequestIp } from '@/lib/accessLog'
import { calcLastUsableDayIso, isLeaveExpiredAsOf, todayJstIso, daysBetween } from '@/lib/date-utils'
import { getAttData, parseDKey } from '@/lib/compute'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const siteIdParam = request.nextUrl.searchParams.get('siteId')

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    // ── 2026-09-02 高速化 ──
    //   main ドキュメント（約260KB）を getWorkerByToken / getStaffSites / getSites /
    //   siteNames / workSchedule がそれぞれ再読しており、読みだけで数秒かかっていた。
    //   1回だけ読んで全てをここから導出する（月初の「入力できない」障害の対処）。
    const mainSnapOnce = await getDoc(doc(db, 'demmen', 'main'))
    const mainRaw = (mainSnapOnce.exists() ? mainSnapOnce.data() : {}) as {
      workers?: unknown[]
      sites?: { id: string; name: string; archived?: boolean; workSchedule?: unknown }[]
      assign?: Record<string, { workers?: number[] }>
      massign?: Record<string, { workers?: number[] }>
    }
    const allWorkers = mapRawWorkers(mainRaw.workers || [])
    const worker = allWorkers.find(w => w.token === token) || null
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // アクセスログ記録（失敗しても処理は続行）
    recordAccess({
      workerId: worker.id,
      workerName: worker.name,
      role: 'staff',
      org: worker.company === 'HFU' ? 'hfu' : 'hibi',
      ip: getRequestIp(request),
    }).catch(() => {})

    // 配置現場（getStaffSites と同じ規則: 当月の月次配置があればそれ、無ければ既定配置）
    const nowJst0 = new Date()
    const curYm0 = ymKey(nowJst0.getFullYear(), nowJst0.getMonth() + 1)
    const assignedSites: { id: string; name: string }[] = []
    for (const site of mainRaw.sites || []) {
      if (site.archived) continue
      const monthAssign = mainRaw.massign?.[`${site.id}_${curYm0}`]
      const eff = monthAssign ?? mainRaw.assign?.[site.id]
      if ((eff?.workers || []).includes(worker.id)) assignedSites.push({ id: site.id, name: site.name })
    }
    // 2026-07-22: 現場未配置（新入社員が配置前にQRを開いた等）でも入口で弾かない。
    //   従来は「未配置かつ現場指定なし」で 404 'No site assigned' を返し、新入社員の
    //   QRが必ずエラーになっていた。配置済みスタッフも元々ドロップダウンで全現場を選べる
    //   ため、未配置でも同じく全現場から選んで使えるようにする（挙動を一貫させる）。
    //   未配置は unassigned フラグで画面に「現場を選んでください」を促す。
    const unassigned = assignedSites.length === 0

    // Get all active (non-archived) sites for the dropdown（main から導出）
    const allActiveSites = (mainRaw.sites || []).filter(s2 => !s2.archived)

    // Build availableSites: all active sites, with primary flag for assigned ones
    const assignedIds = new Set(assignedSites.map(s => s.id))
    const availableSites = allActiveSites.map(s => ({
      id: s.id,
      name: s.name,
      primary: assignedIds.has(s.id),
    }))
    // Sort: assigned sites first, then alphabetically
    availableSites.sort((a, b) => {
      if (a.primary && !b.primary) return -1
      if (!a.primary && b.primary) return 1
      return a.name.localeCompare(b.name, 'ja')
    })

    const siteId = siteIdParam || (assignedSites.length > 0 ? assignedSites[0].id : allActiveSites[0]?.id)
    const site = availableSites.find(s => s.id === siteId) || availableSites[0]
    if (!site) {
      return NextResponse.json({ error: 'No sites available' }, { status: 404 })
    }

    // 2026-08-27 修正（休暇届総点検）: Vercel は UTC のため、JST 0〜9時に「今日」が
    //   前日になり、欠勤届の初期日付が前日を指して確定済み出勤を上書きし得た
    const { todayJstIso } = await import('@/lib/date-utils')
    const tIso = todayJstIso()
    const now = new Date(tIso + 'T00:00:00')  // 後続の期間計算も JST 当日基準
    const y = Number(tIso.slice(0, 4))
    const m = Number(tIso.slice(5, 7))
    const d = Number(tIso.slice(8, 10))
    const ym = ymKey(y, m)

    // Read attendance data（過去14日の窓が前月にかかる月初は、前月も並列で先読み）
    const prevMonthDate = new Date(y, m - 1, d - 14)
    const prevYmStr = ymKey(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1)
    const [attData, attPrevPre] = await Promise.all([
      getAttendanceDoc(ym),
      prevYmStr !== ym ? getAttendanceDoc(prevYmStr) : Promise.resolve(null),
    ])

    // Today's entry
    const todayKey = attKey(siteId, worker.id, ym, d)
    const currentEntry = attData[todayKey] || null

    // Past 5 days (with site name)
    const pastDays: {
      date: string; year: number; month: number; day: number
      entry: AttendanceEntry | null; status: ReturnType<typeof getEntryStatus>
      locked: boolean; dayOffset: number; siteName: string
    }[] = []
    // Build site name lookup + 現在現場の workSchedule 取得（main から導出・再読なし）
    const siteNames: Record<string, string> = {}
    let currentSiteWorkSchedule: unknown = null
    for (const s of mainRaw.sites || []) {
      siteNames[s.id] = (s.name || '').slice(0, 3)
      if (s.id === siteId) currentSiteWorkSchedule = s.workSchedule || null
    }

    // 2026-09-02 高速化: 月をまたぐと att_前月 をループ内で最大4回再読していた
    //（9/1〜9/5 は過去5日の大半が前月）。月単位キャッシュ＋承認の並列取得に変更。
    //   月初にスマホ画面が17秒かかり「入力できない」報告が出た障害の対処。
    const attMonthCache: Record<string, Record<string, AttendanceEntry>> = { [ym]: attData }
    if (attPrevPre) attMonthCache[prevYmStr] = attPrevPre
    const getAttCached = async (pym: string) => {
      if (!(pym in attMonthCache)) attMonthCache[pym] = await getAttendanceDoc(pym)
      return attMonthCache[pym]
    }
    const pastDayInfos = [] as { pd: Date; pym: string; pDay: number; entry: AttendanceEntry | null; entrySiteId: string; off: number }[]
    for (let off = 1; off <= 5; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()
      const pAttData = await getAttCached(pym)

      // Check current site first, then check all sites for this day
      const pk = attKey(siteId, worker.id, pym, pDay)
      let entry = pAttData[pk] || null
      let entrySiteId = siteId
      if (!entry) {
        for (const sid of Object.keys(siteNames)) {
          if (sid === siteId) continue
          const altKey = attKey(sid, worker.id, pym, pDay)
          if (pAttData[altKey]) {
            entry = pAttData[altKey]
            entrySiteId = sid
            break
          }
        }
      }
      pastDayInfos.push({ pd, pym, pDay, entry, entrySiteId, off })
    }
    // ↓承認の取得は missingDays 側とまとめて1回の並列バッチで行う（2026-09-02）
    const pastApprovalsPromise = Promise.all(
      pastDayInfos.map(i => getApprovalForDay(i.entrySiteId, i.pym, i.pDay)))
    const pastApprovals = await pastApprovalsPromise
    pastDayInfos.forEach((i, idx) => {
      pastDays.push({
        date: formatDateShort(i.pd),
        year: i.pd.getFullYear(),
        month: i.pd.getMonth() + 1,
        day: i.pDay,
        entry: i.entry,
        status: getEntryStatus(i.entry),
        locked: !!(pastApprovals[idx]?.foreman),
        dayOffset: i.off,
        siteName: siteNames[i.entrySiteId] || '',
      })
    })

    // ── 未入力の過去稼働日（2026-08-28 追加: 入力督促バナー用）──
    //   入力可能な過去14日のうち、承認済み現場カレンダーの稼働日で、どの現場にも
    //   入力がない日を返す。未入力のまま締めに流れると欠勤扱いになるため、
    //   スマホ画面の先頭で本人に見せて入力させる。
    //   カレンダー未承認の月は日曜のみ非稼働として扱う（職長画面の俯瞰と同じ規則）。
    const missingDays: {
      date: string; year: number; month: number; day: number
      entry: null; status: 'none'; locked: boolean; dayOffset: number; siteName: string
    }[] = []
    {
      const calCache: Record<string, Record<string, string> | null> = {}
      const missingCands = [] as { pd: Date; py: number; pm: number; pDay: number; pym: string; off: number }[]
      for (let off = 1; off <= 14; off++) {
        const pd = new Date(y, m - 1, d - off)
        const py = pd.getFullYear()
        const pm = pd.getMonth() + 1
        const pDay = pd.getDate()
        const pym = ymKey(py, pm)
        const pAtt = await getAttCached(pym)   // pastDays と同じ月キャッシュを共有（2026-09-02）

        const calKey = `${siteId}_${py}-${String(pm).padStart(2, '0')}`
        if (!(calKey in calCache)) {
          try {
            const calSnap = await getDoc(doc(db, 'siteCalendar', calKey))
            const cal = calSnap.exists() ? calSnap.data() : null
            calCache[calKey] = (cal?.status === 'approved' && cal?.days)
              ? (cal.days as Record<string, string>) : null
          } catch { calCache[calKey] = null }
        }
        const calDays = calCache[calKey]
        const isWorkDay = calDays ? calDays[String(pDay)] === 'work' : pd.getDay() !== 0
        if (!isWorkDay) continue

        // どの現場かを問わず入力があればスキップ（現場間違いは職長が移動する）
        let hasEntry = false
        for (const sid of Object.keys(siteNames)) {
          if (getEntryStatus(pAtt[attKey(sid, worker.id, pym, pDay)]) !== 'none') {
            hasEntry = true
            break
          }
        }
        if (hasEntry) continue
        missingCands.push({ pd, py, pm, pDay, pym, off })
      }
      const missApprovals = await Promise.all(
        missingCands.map(c => getApprovalForDay(siteId, c.pym, c.pDay)))
      // （today の承認・道具代はこの後の並列ブロックで取得）
      missingCands.forEach((c, idx) => {
        missingDays.push({
          date: formatDateShort(c.pd),
          year: c.py, month: c.pm, day: c.pDay,
          entry: null,
          status: 'none',
          locked: !!(missApprovals[idx]?.foreman),
          dayOffset: c.off,
          siteName: '',
        })
      })
    }

    // Today's approval と 道具代 doc を並列で取得（2026-09-02 高速化）
    const { isToolBudgetEligible } = await import('@/lib/workers')
    const tbEligible = isToolBudgetEligible({ visa: worker.visaType, job: worker.jobType, retired: worker.retired, hireDate: worker.hireDate })
    const [todayApproval, tbSnapPre] = await Promise.all([
      getApprovalForDay(siteId, ym, d),
      tbEligible ? getDoc(doc(db, 'demmen', 'toolBudget')) : Promise.resolve(null),
    ])

    // 道具代情報（技能実習生・特定技能のみ、佐藤さんが手動設定した期間起点から1年サイクル）
    // 2026-04-30 運用開始: データ整備完了に伴いガード撤廃（データが無ければ自然に非表示）
    let toolBudgetRemaining: number | null = null
    let toolBudgetPeriodStart: string | null = null
    let toolBudgetPeriodEnd: string | null = null
    try {
      if (tbEligible && tbSnapPre) {
        const tbSnap = tbSnapPre
        if (tbSnap.exists()) {
          const tbData = tbSnap.data()
          const anchor = tbData.periodAnchors?.[String(worker.id)]
          if (anchor) {
            const anchorDate = new Date(anchor + 'T00:00:00')
            if (!isNaN(anchorDate.getTime())) {
              // 年加算のヘルパー（うるう年 2/29 → 2/28 に正規化）
              const addYears = (d: Date, y: number): Date => {
                const r = new Date(d)
                const m = r.getMonth()
                r.setFullYear(r.getFullYear() + y)
                if (r.getMonth() !== m) r.setDate(0)
                return r
              }
              let periodStart = new Date(anchorDate)
              while (true) {
                const next = addYears(periodStart, 1)
                if (next > now) break
                periodStart = next
              }
              const periodEnd = addYears(periodStart, 1)
              periodEnd.setDate(periodEnd.getDate() - 1)
              const periodStartStr = periodStart.toISOString().slice(0, 10)
              toolBudgetPeriodStart = periodStartStr
              toolBudgetPeriodEnd = periodEnd.toISOString().slice(0, 10)

              const tbKey = `${worker.id}_${periodStartStr}`
              const tbRecord = tbData.records?.[tbKey]
              if (tbRecord) {
                const tbUsed = (tbRecord.purchases || []).reduce((s: number, p: { amount: number }) => s + p.amount, 0)
                toolBudgetRemaining = tbRecord.budget - tbUsed
              } else {
                const { toolBudgetDefaultFor } = await import('@/lib/workers')
                toolBudgetRemaining = toolBudgetDefaultFor({ visa: worker.visaType, job: worker.jobType }, tbData)
              }
            }
          }
        }
      }
    } catch { /* ignore */ }

    // 有給残日数
    // 2026-04-30 運用開始: データ整備完了に伴いガード撤廃（plRecordsが無ければ自然にnullで非表示）
    // Phase 8: FIFO内訳（繰越分・当期付与分の別々表示）
    let plRemaining: number | null = null
    let plExpiryDate: string | null = null  // 当期付与分の有効期限（従来フィールド、後方互換）
    let plCarryOverRemaining: number | null = null
    let plCarryOverExpiryDate: string | null = null
    let plCarryOverExpiryStatus: 'ok' | 'warning' | 'expired' | null = null
    let plGrantRemaining: number | null = null
    let plGrantExpiryDate: string | null = null
    try {
      {
          // 2026-09-02: main の再読をやめ、冒頭で読んだ mainRaw を使う
          const plData: Record<string, { fy?: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; used?: number; _archived?: boolean }[]> =
            ((mainRaw as { plData?: Record<string, never[]> }).plData || {}) as never
          const plRecordsRaw = plData[String(worker.id)] || []
          const plRecords = plRecordsRaw.filter(r => !r._archived)

          // ⚠️ 2026-08-17 修正: 「今日時点で有効な」付与レコードを選ぶこと。
          //   旧コードは grantDate でソートして配列の最後を取っていたため、
          //   **まだ付与日が来ていない未来のレコード**を掴んでいた。
          //   実例: トゥアン(102) は当期(2025-11-01付与・17日)を17日消化して残0日なのに、
          //   未来の 2026-11-01 付与(17日・消化0)を見て「残17日」と表示していた
          //   （有効期限も 2028/10/31 と未来枠のものが出ていた）。
          //   申請時のガードは getLeaveBalance → selectActiveGrantRecord で正しく0と
          //   判定して弾くため、「17日あるのに申請できない」というUX不整合になっていた。
          //   ※ 判定は lib/leave-compute.ts の selectActiveGrantRecord に一元化する。
          //     「配列の最後」「fyの数値比較」で代用しないこと（どちらも未来レコードを掴む）。
          const { selectActiveGrantRecord } = await import('@/lib/leave-compute')
          const latest = selectActiveGrantRecord(plRecords, todayJstIso())

          if (latest) {
            const grant = latest.grantDays ?? latest.grant ?? 0
            const carry = latest.carryOver ?? latest.carry ?? 0
            const adj = latest.adjustment ?? latest.adj ?? 0

            // periodUsed を出面から動的計算（grantDate..+1年の範囲内のPエントリ数）
            //
            // 設計ポリシー（2026-05-18 確定）:
            //   スタッフ画面の残日数は「申請可能な日数」を示す → 未来日付の予定も「使用済み」扱いに含める
            //   （対比: 管理画面/Excelは「実消化日数」基準なので未来日付は除外）
            //
            // 含めるもの:
            //   - 過去P（実際に消化済み）
            //   - 未来P（承認済みの帰国予定など、出面に既に書き込まれている）
            // 含めないもの:
            //   - pending状態の申請（まだ承認されていない、leave-request API側で別途算入）
            //
            // この設計により、スタッフが「あと15日ある」と思って追加申請したら拒否される、
            // という UX 不整合を防ぐ。
            let periodUsed = 0
            if (latest.grantDate) {
              const gdStart = new Date(latest.grantDate + 'T00:00:00')
              if (!isNaN(gdStart.getTime())) {
                const gdEnd = new Date(gdStart); gdEnd.setFullYear(gdEnd.getFullYear() + 1)
                // 2026-09-02 高速化（月初の「入力できない」障害の主犯）:
                //   旧実装は「過去2年+当年 = 36ヶ月」の att を**逐次**読みしており、
                //   これだけで15〜20秒かかっていた（スマホ回線ではタイムアウト）。
                //   数えるのは付与期間 [grantDate, +1年) の P だけなので、
                //   その期間の月（最大13ヶ月）だけを**並列**で読む。
                const attEntries: Record<string, Record<string, unknown>> = {}
                {
                  const periodYms: string[] = []
                  const cur = new Date(gdStart.getFullYear(), gdStart.getMonth(), 1)
                  while (cur < gdEnd && periodYms.length < 14) {
                    periodYms.push(ymKey(cur.getFullYear(), cur.getMonth() + 1))
                    cur.setMonth(cur.getMonth() + 1)
                  }
                  const atts = await Promise.all(periodYms.map(pymL => getAttData(pymL)))
                  for (const att of atts) Object.assign(attEntries, att.d)
                }
                // 同日複数現場の p は1日として数える（他経路と同じ dedup。2026-08-27）
                const seenP = new Set<string>()
                for (const [key, entry] of Object.entries(attEntries)) {
                  if (!entry) continue
                  const e = entry as { p?: number | boolean }
                  if (!e.p) continue
                  const pk = parseDKey(key)
                  if (parseInt(pk.wid) !== worker.id) continue
                  const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                  if (d >= gdStart && d < gdEnd) seenP.add(`${pk.ym}_${pk.day}`)
                }
                periodUsed = seenP.size
              }
            }
            // 買取済み日数も消化側に含める（getLeaveBalance と同じ式。
            //   2026-08-17 総点検で判明: ここだけ買取を無視していたため、退職精算等で
            //   買取した人のスマホ残数が買取分だけ多く表示される）
            // buyoutDays 未キャッシュの移行データは履歴合算へフォールバック（getLeaveBalance と統一・2026-09-02）
            const latestB = latest as { buyoutDays?: number; buyoutHistory?: Array<{ days?: number }> }
            const buyout = latestB.buyoutDays ?? (latestB.buyoutHistory || []).reduce((s2, b) => s2 + (b.days || 0), 0)
            const totalUsed = adj + buyout + periodUsed

            // FIFO 内訳: 繰越分→当期付与分の順に消費
            const fromCarryOver = Math.min(totalUsed, carry)
            const fromGrant = Math.max(0, totalUsed - carry)
            plCarryOverRemaining = Math.max(0, carry - fromCarryOver)
            plGrantRemaining = Math.max(0, grant - fromGrant)
            plRemaining = plCarryOverRemaining + plGrantRemaining

            // 当期付与分の最終利用可能日 = 付与日 + 2年 - 1日
            if (latest.grantDate) {
              const lastUsable = calcLastUsableDayIso(latest.grantDate)
              if (lastUsable) {
                plExpiryDate = lastUsable
                plGrantExpiryDate = plExpiryDate
              }
            }

            // 繰越分の時効 = 前期レコード.grantDate + 2年 - 1日
            if (plCarryOverRemaining > 0 && latest.grantDate) {
              const curTime = new Date(latest.grantDate + 'T00:00:00').getTime()
              const prevCandidates = plRecordsRaw
                .filter(r => r.grantDate)
                .map(r => ({ rec: r, time: new Date(r.grantDate as string + 'T00:00:00').getTime() }))
                .filter(x => !isNaN(x.time) && x.time < curTime)
                .sort((a, b) => a.time - b.time)
              const prev = prevCandidates[prevCandidates.length - 1]
              if (prev && prev.rec.grantDate) {
                const prevGrant = prev.rec.grantDate as string
                const prevLastUsable = calcLastUsableDayIso(prevGrant)
                plCarryOverExpiryDate = prevLastUsable
                const todayStr = todayJstIso()
                if (isLeaveExpiredAsOf(prevGrant, todayStr)) plCarryOverExpiryStatus = 'expired'
                else if (daysBetween(todayStr, prevLastUsable) <= 90) plCarryOverExpiryStatus = 'warning'
                else plCarryOverExpiryStatus = 'ok'
                if (plCarryOverExpiryStatus === 'expired') plCarryOverRemaining = 0
              }
            }
          }
        }
    } catch { /* ignore */ }

    return NextResponse.json({
      worker: { id: worker.id, name: worker.name, nameVi: worker.nameVi, visaType: worker.visaType },
      site: { id: site.id, name: site.name, workSchedule: currentSiteWorkSchedule },
      allSites: assignedSites,
      availableSites,
      unassigned,  // 2026-07-22: 現場未配置（新入社員が配置前）。画面で現場選択を促す
      today: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateJP(now),
      },
      currentEntry,
      currentStatus: getEntryStatus(currentEntry),
      todayLocked: !!(todayApproval?.foreman),
      pastDays,
      missingDays,
      toolBudgetRemaining,
      toolBudgetPeriodStart,
      toolBudgetPeriodEnd,
      plRemaining,
      plExpiryDate,
      // Phase 8: FIFO内訳
      plCarryOverRemaining,
      plCarryOverExpiryDate,
      plCarryOverExpiryStatus,
      plGrantRemaining,
      plGrantExpiryDate,
    })
  } catch (error) {
    console.error('Staff GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { token, siteId, year, month, day, choice, overtimeHours,
            startTime, endTime, break1, break2, break3,
            restReason, restNote } = await request.json()

    if (!token || !siteId || !year || !month || !day || !choice) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Check site exists and is active + 現場の勤務時間設定を取得
    // 2026-09-02 高速化: POST でも main を1回だけ読んで全てを導出
    const mainSnapPost = await getDoc(doc(db, 'demmen', 'main'))
    const mainRawPost = (mainSnapPost.exists() ? mainSnapPost.data() : {}) as {
      sites?: { id: string; name?: string; archived?: boolean; shiftType?: 'day' | 'night'; workSchedule?: { startTime?: string } }[]
    }
    const allActiveSites = (mainRawPost.sites || []).filter(s2 => !s2.archived).map(s2 => ({ id: s2.id, name: s2.name || '' }))
    if (!allActiveSites.find(s => s.id === siteId)) {
      return NextResponse.json({ error: 'Site not found or archived' }, { status: 403 })
    }
    // workSchedule を取得（残業計算用）
    type SiteBreakRaw = { enabled?: boolean; minutes?: number; mandatory?: boolean }
    type SiteWorkScheduleRaw = {
      startTime?: string; endTime?: string
      morningBreak?: SiteBreakRaw; lunchBreak?: SiteBreakRaw; afternoonBreak?: SiteBreakRaw
    }
    let siteWorkSchedule: SiteWorkScheduleRaw | null = null
    {
      const found = (mainRawPost.sites || []).find(s => s.id === siteId)
      siteWorkSchedule = (found?.workSchedule as SiteWorkScheduleRaw | undefined) || null
    }
    // デフォルト休憩分数（workSchedule未設定時に使用）
    const wsMorning   = siteWorkSchedule?.morningBreak   ?? { enabled: true, minutes: 30, mandatory: false }
    const wsLunch     = siteWorkSchedule?.lunchBreak     ?? { enabled: true, minutes: 60, mandatory: true }
    const wsAfternoon = siteWorkSchedule?.afternoonBreak ?? { enabled: true, minutes: 30, mandatory: false }

    // Check approval lock
    const ym = ymKey(year, month)
    const approval = await getApprovalForDay(siteId, ym, day)
    if (approval?.foreman) {
      return NextResponse.json({ error: 'Day is locked (approved)' }, { status: 409 })
    }

    // 2026-06-12 (監査 Sprint2-B): 月次ロック済み月への書込を拒否。
    //   year/month は任意指定できるため、過去のロック済み月（給与確定後）への
    //   遡及入力で支払額とシステムが食い違うのを防ぐ
    {
      const { checkMonthLocked } = await import('@/lib/locks')
      const lockErr = await checkMonthLocked(ym, (worker as { org?: string }).org)
      if (lockErr) {
        return NextResponse.json({ error: `${lockErr} / Tháng này đã khóa, không thể thay đổi` }, { status: 409 })
      }
    }

    // 2026-08-27 追加（有給総点検・第3回）: 入力可能な日付範囲を制限。
    //   year/month/day は body で任意指定できたため、トークンさえあれば
    //   未来日や遠い過去日へ API 直叩きで書き込めた（UI は今日+過去5日のみ）。
    //   過去は14日前まで。未来日は原則不可だが、**欠勤届(rest)だけは+30日まで許可**
    //   （「明日休みます」の事前届は 2026-07-30 実装の正規機能。当初ガードが
    //   一律拒否で回帰させていたのを同日中に修正）。
    {
      const { todayJstIso, addDaysIso } = await import('@/lib/date-utils')
      const dateIso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
      const today = todayJstIso()
      const futureLimit = choice === 'rest' ? addDaysIso(today, 30) : today
      if (dateIso > futureLimit) {
        return NextResponse.json({ error: choice === 'rest'
          ? '欠勤届は30日先まで提出できます / Đơn xin nghỉ chỉ nộp được trước tối đa 30 ngày'
          : '未来の日付には入力できません / Không thể nhập cho ngày trong tương lai' }, { status: 400 })
      }
      if (dateIso < addDaysIso(today, -14)) {
        return NextResponse.json({ error: '2週間より前の日付は変更できません。職長に依頼してください / Không thể thay đổi ngày quá 2 tuần trước' }, { status: 400 })
      }
    }

    // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
    // （日勤+夜勤は許容、日勤+日勤や夜勤+夜勤は拒否）
    try {
      const { detectMultiSiteConflict, getAttendanceDoc, attKey } = await import('@/lib/attendance')
      const attDoc = await getAttendanceDoc(ym)

      // 2026-08-27 追加（有給総点検・第3回）: 承認済み有給(p)の日をスタッフが
      //   別ステータスで上書きすると、p だけが消えて申請レコードは approved のまま残り、
      //   残数が黙って1日戻っていた（承認↔出面の対の崩れ）。有給の変更は管理者の
      //   取消(revoke)経由に限定する。
      if (choice !== 'leave') {
        const existing = attDoc[attKey(siteId, worker.id, ym, day)] as { p?: number | boolean } | undefined
        if (existing?.p) {
          return NextResponse.json({
            error: 'この日は有給として登録済みです。変更が必要な場合は管理者に連絡してください / Ngày này đã đăng ký nghỉ phép. Vui lòng liên hệ quản lý nếu cần thay đổi',
          }, { status: 409 })
        }
      }
      // 全現場リスト（アーカイブ済みも含む。過去の現場間違いを検出するため）
      const sitesAll = mainRawPost.sites || []
      const conflict = detectMultiSiteConflict(attDoc, siteId, worker.id, ym, day, sitesAll)
      if (conflict) {
        const found = sitesAll.find(s => s.id === conflict.conflictSiteId)
        const conflictSiteName = found?.name || conflict.conflictSiteId
        const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
        return NextResponse.json({
          error: `既に「${conflictSiteName}」（${shiftLabel}）で同日の出面が登録されています。職長に依頼してください。 / Ngày này đã có chấm công tại "${conflictSiteName}". Vui lòng nhờ tổ trưởng.`,
          conflictSiteId: conflict.conflictSiteId,
          conflictSiteName,
        }, { status: 409 })
      }
    } catch (e) {
      console.error('Multi-site guard error (staff):', e)
      return NextResponse.json({ error: 'ガード判定に失敗しました。もう一度お試しください / Kiểm tra thất bại. Vui lòng thử lại' }, { status: 503 })
    }

    // Build entry
    //
    // ⚠️ 2026-05-09 根本原因対処（c36517b の安全再実装）:
    //   ステータス変更時に古いフィールド（出勤の時刻、休みの理由、残業時間など）が
    //   merge:true で残り続けるバグの根治。
    //   computeAttendanceDeleteFields(entry) で「新エントリに含まれない既知フィールドを
    //   自動算出して削除」することで、漏れなく残骸を消す。
    let entry: AttendanceEntry
    const isTimeBased = !!(startTime && endTime) // 時間ベース入力（202605〜）
    switch (choice) {
      case 'work':
        if (isTimeBased) {
          // 時間ベース入力: 始業/終業/休憩から実労働を算出
          entry = {
            w: 1,
            st: String(startTime),
            et: String(endTime),
            b1: break1 ? 1 : 0,
            b2: break2 ? 1 : 0,
            b3: break3 ? 1 : 0,
            s: 'staff',
          }
          // 後方互換: o フィールドにも残業時間を入れる（既存の集計ロジック用）
          // 休憩時間は現場の workSchedule に従う
          const startMin = parseInt(String(startTime).split(':')[0]) * 60 + parseInt(String(startTime).split(':')[1] || '0')
          const endMin = parseInt(String(endTime).split(':')[0]) * 60 + parseInt(String(endTime).split(':')[1] || '0')
          let actualMin = endMin - startMin
          if (entry.b1 && wsMorning.enabled)   actualMin -= wsMorning.minutes   ?? 30
          if (entry.b2 && wsLunch.enabled)     actualMin -= wsLunch.minutes     ?? 60
          if (entry.b3 && wsAfternoon.enabled) actualMin -= wsAfternoon.minutes ?? 30
          const actualH = Math.max(0, actualMin / 60)
          const otH = Math.max(0, Math.round((actualH - 7) * 10) / 10)
          if (otH > 0) entry.o = otH
        } else {
          // レガシー入力（202604以前）
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'staff' }
        }
        break
      case 'rest': {
        const restEntry: AttendanceEntry = { w: 0, r: 1, s: 'staff' }
        if (restReason && String(restReason).trim()) {
          restEntry.rReason = String(restReason).trim()
        }
        if (restNote && String(restNote).trim()) {
          restEntry.rNote = String(restNote).trim()
        }
        entry = restEntry
        break
      }
      case 'leave': {
        // 2026-08-04 修正（有給システム総点検）: 残数チェックを getLeaveBalance に統一
        //   旧実装は2つの穴があった:
        //   ① 「grantDate 降順の先頭」= 先に作られた未来の付与レコードを掴み、
        //      未消化の未来枠で判定してすり抜ける（トゥアン事案と同型）
        //   ② 付与レコードが1件も無いスタッフは latest=undefined でチェック自体を素通り
        //   また 36ヶ月分の出面を読んでおり、クォータ超過事故歴のある読み取り量だった
        //   （共通ヘルパーは付与期間の12〜13ヶ月分のみ）。
        try {
          const { getLeaveBalance } = await import('@/lib/leave-balance')
          const targetDate = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
          // 同じ日の再送信で自分自身を二重カウントしないよう excludeDate を渡す
          // 2026-09-02 修正: 基準日も対象日に（今日の付与期で判定していた）
          const bal = await getLeaveBalance(worker.id, targetDate, targetDate)
          if (bal.remaining <= 0) {
            return NextResponse.json(
              { error: '有給休暇の残日数がありません。管理者にご確認ください。 / Không còn ngày nghỉ phép. Vui lòng liên hệ quản lý.' },
              { status: 400 }
            )
          }
        } catch (chkErr) {
          // 残チェックでエラーが出ても申請自体は通す（既存運用継続性）
          console.warn('[staff/leave] 残チェック失敗:', chkErr)
        }
        // 2026-09-02（代表決定）: 帰国期間中でも有給にできる（旧: 一律ブロック）。
        //   給与側の穴（有給を充てても賃金が出ない）は countHomeLeaveDaysInRange で根治済み。
        // 2026-08-27 追加（有給総点検・第3回）: 非稼働日ガード。
        //   申請経路(request)・時季指定・日付変更には isScheduledWorkDay があるのに
        //   この直接入力経路だけ無く、カレンダー休日への有給＝有給日給の過払いが
        //   ここからだけ通ってしまっていた（2026-06 社労士対応の取り残し）。
        {
          const { isScheduledWorkDay } = await import('@/lib/attendance')
          const targetDate2 = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
          if (!await isScheduledWorkDay(siteId, targetDate2)) {
            return NextResponse.json(
              { error: 'この日は現場の非稼働日のため有給を取得できません / Ngày này công trường nghỉ, không thể lấy phép' },
              { status: 400 }
            )
          }
        }
        // 2026-06-XX 追加 (IM-3): 退職日跨ぎガード
        if (worker.retired && `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}` > worker.retired) {
          return NextResponse.json(
            { error: '退職日以降は有給を申請できません。' },
            { status: 400 }
          )
        }
        entry = { w: 0, p: 1, s: 'staff' }
        break
      }
      case 'site_off':
        entry = { w: 0, h: 1, s: 'staff' }
        break
      default:
        return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
    }

    // 残骸消去: entry に含まれない既知フィールドを全て削除
    const deleteFields = computeAttendanceDeleteFields(entry)
    await setAttendanceEntry(siteId, worker.id, ym, day, entry, { deleteFields })

    return NextResponse.json({ success: true, entry })
  } catch (error) {
    console.error('Staff POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
