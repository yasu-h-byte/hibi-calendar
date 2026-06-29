import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
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
import { getAttData, parseDKey } from '@/lib/compute'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const siteIdParam = request.nextUrl.searchParams.get('siteId')

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    const worker = await getWorkerByToken(token)
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

    const assignedSites = await getStaffSites(worker.id)
    if (assignedSites.length === 0 && !siteIdParam) {
      return NextResponse.json({ error: 'No site assigned' }, { status: 404 })
    }

    // Get all active (non-archived) sites for the dropdown
    const allActiveSites = await getSites()

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

    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const d = now.getDate()
    const ym = ymKey(y, m)

    // Read attendance data
    const attData = await getAttendanceDoc(ym)

    // Today's entry
    const todayKey = attKey(siteId, worker.id, ym, d)
    const currentEntry = attData[todayKey] || null

    // Past 5 days (with site name)
    const pastDays = []
    // Build site name lookup + 現在現場の workSchedule 取得
    const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
    const siteNames: Record<string, string> = {}
    let currentSiteWorkSchedule: unknown = null
    if (mainDoc.exists()) {
      const sites = mainDoc.data().sites || []
      for (const s of sites) {
        siteNames[s.id] = (s.name as string || '').slice(0, 3)
        if (s.id === siteId) {
          currentSiteWorkSchedule = s.workSchedule || null
        }
      }
    }

    for (let off = 1; off <= 5; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()

      // May need to read a different month's doc
      let pAttData = attData
      if (pym !== ym) {
        pAttData = await getAttendanceDoc(pym)
      }

      // Check current site first, then check all sites for this day
      const pk = attKey(siteId, worker.id, pym, pDay)
      let entry = pAttData[pk] || null
      let entrySiteId = siteId

      // If no entry on current site, check other sites
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

      const status = getEntryStatus(entry)
      const approval = await getApprovalForDay(entrySiteId, pym, pDay)
      const locked = !!(approval?.foreman)

      pastDays.push({
        date: formatDateShort(pd),
        year: pd.getFullYear(),
        month: pd.getMonth() + 1,
        day: pDay,
        entry,
        status,
        locked,
        dayOffset: off,
        siteName: siteNames[entrySiteId] || '',
      })
    }

    // Today's approval
    const todayApproval = await getApprovalForDay(siteId, ym, d)

    // 道具代情報（技能実習生・特定技能のみ、佐藤さんが手動設定した期間起点から1年サイクル）
    // 2026-04-30 運用開始: データ整備完了に伴いガード撤廃（データが無ければ自然に非表示）
    let toolBudgetRemaining: number | null = null
    let toolBudgetPeriodStart: string | null = null
    let toolBudgetPeriodEnd: string | null = null
    try {
      const visa = worker.visaType
      const isForeign = visa && (visa.startsWith('jisshu') || visa.startsWith('tokutei'))
      if (isForeign) {
        const tbSnap = await getDoc(doc(db, 'demmen', 'toolBudget'))
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
                toolBudgetRemaining = tbData.budgetByVisa?.[visa] ?? tbData.defaultBudget ?? 30000
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
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      if (mainSnap.exists()) {
          const plData: Record<string, { fy?: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; used?: number; _archived?: boolean }[]> = mainSnap.data().plData || {}
          const plRecordsRaw = plData[String(worker.id)] || []
          const plRecords = plRecordsRaw.filter(r => !r._archived)

          if (plRecords.length > 0) {
            // 最新の付与レコードを特定（grantDate最大・grantDays>0）
            const granted = plRecords
              .filter(r => r.grantDate && ((r.grantDays ?? r.grant ?? 0) > 0))
              .slice()
              .sort((a, b) => new Date(a.grantDate as string).getTime() - new Date(b.grantDate as string).getTime())
            const latest = granted[granted.length - 1] || plRecords[plRecords.length - 1]
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
                // 出面データは過去2年+当年で十分
                const attEntries: Record<string, Record<string, unknown>> = {}
                for (let yy = now.getFullYear() - 2; yy <= now.getFullYear(); yy++) {
                  for (let mm = 1; mm <= 12; mm++) {
                    const att = await getAttData(ymKey(yy, mm))
                    Object.assign(attEntries, att.d)
                  }
                }
                for (const [key, entry] of Object.entries(attEntries)) {
                  if (!entry) continue
                  const e = entry as { p?: number | boolean }
                  if (!e.p) continue
                  const pk = parseDKey(key)
                  if (parseInt(pk.wid) !== worker.id) continue
                  const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                  if (d >= gdStart && d < gdEnd) periodUsed++
                }
              }
            }
            const totalUsed = adj + periodUsed

            // FIFO 内訳: 繰越分→当期付与分の順に消費
            const fromCarryOver = Math.min(totalUsed, carry)
            const fromGrant = Math.max(0, totalUsed - carry)
            plCarryOverRemaining = Math.max(0, carry - fromCarryOver)
            plGrantRemaining = Math.max(0, grant - fromGrant)
            plRemaining = plCarryOverRemaining + plGrantRemaining

            // 当期付与分の時効 = 付与日 + 2年 - 1日
            if (latest.grantDate) {
              const grantDate = new Date(latest.grantDate + 'T00:00:00')
              if (!isNaN(grantDate.getTime())) {
                const expiry = new Date(grantDate)
                const origMonth = expiry.getMonth()
                expiry.setFullYear(expiry.getFullYear() + 2)
                if (expiry.getMonth() !== origMonth) expiry.setDate(0)
                expiry.setDate(expiry.getDate() - 1)
                plExpiryDate = expiry.toISOString().slice(0, 10)
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
                const prevGd = new Date(prev.rec.grantDate + 'T00:00:00')
                const prevExp = new Date(prevGd)
                const origM = prevExp.getMonth()
                prevExp.setFullYear(prevExp.getFullYear() + 2)
                if (prevExp.getMonth() !== origM) prevExp.setDate(0)
                prevExp.setDate(prevExp.getDate() - 1)
                plCarryOverExpiryDate = prevExp.toISOString().slice(0, 10)
                const nowT = Date.now()
                const diffDays = Math.floor((prevExp.getTime() - nowT) / (24 * 60 * 60 * 1000))
                if (diffDays < 0) plCarryOverExpiryStatus = 'expired'
                else if (diffDays <= 90) plCarryOverExpiryStatus = 'warning'
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
      today: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateJP(now),
      },
      currentEntry,
      currentStatus: getEntryStatus(currentEntry),
      todayLocked: !!(todayApproval?.foreman),
      pastDays,
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
    const allActiveSites = await getSites()
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
    try {
      const mainSnapForWS = await getDoc(doc(db, 'demmen', 'main'))
      if (mainSnapForWS.exists()) {
        const allSites = (mainSnapForWS.data().sites || []) as { id: string; workSchedule?: SiteWorkScheduleRaw }[]
        const found = allSites.find(s => s.id === siteId)
        siteWorkSchedule = found?.workSchedule || null
      }
    } catch { /* ignore */ }
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

    // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
    // （日勤+夜勤は許容、日勤+日勤や夜勤+夜勤は拒否）
    try {
      const { detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
      const attDoc = await getAttendanceDoc(ym)
      // 全現場リスト（アーカイブ済みも含む。過去の現場間違いを検出するため）
      const sitesAll = (await getDoc(doc(db, 'demmen', 'main'))).data()?.sites || []
      const conflict = detectMultiSiteConflict(attDoc, siteId, worker.id, ym, day, sitesAll)
      if (conflict) {
        const found = sitesAll.find((s: { id: string; name: string }) => s.id === conflict.conflictSiteId)
        const conflictSiteName = found?.name || conflict.conflictSiteId
        const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
        return NextResponse.json({
          error: `既に「${conflictSiteName}」（${shiftLabel}）で同日の出面が登録されています。職長に依頼してください。`,
          conflictSiteId: conflict.conflictSiteId,
          conflictSiteName,
        }, { status: 409 })
      }
    } catch (e) {
      console.error('Multi-site guard error (staff):', e)
      return NextResponse.json({ error: 'ガード判定に失敗しました' }, { status: 503 })
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
        // 2026-06-XX 修正 (CR-3): 出面入力経由の有給申請でも残日数チェック
        //   旧: 無条件に書き込み → 残超過消化が成立する
        //   新: 申請モーダルと同じ残チェックを実施
        //   ※ 「申請モーダル経由のみ」に強制する代替案もあるが、既存UXを壊さないため
        //      ここでチェックする方針
        try {
          const mainData = (await import('@/lib/compute')).getMainData
          const main = await mainData()
          const plRecords = main.plData[String(worker.id)] || []
          // 当期 (grantDate 最新) を取得
          const latest = plRecords
            .filter((r: { grantDate?: string }) => r.grantDate)
            .sort((a: { grantDate?: string }, b: { grantDate?: string }) =>
              new Date(b.grantDate!).getTime() - new Date(a.grantDate!).getTime()
            )[0]
          if (latest) {
            const { computePeriodUsed } = await import('@/lib/leave-compute')
            // 当該年度の全有給日を集計（全月の att を取得）
            const { getAttData } = await import('@/lib/compute')
            const allAtt: Record<string, unknown> = {}
            const now = new Date()
            for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
              for (let m = 1; m <= 12; m++) {
                const ymStr = `${y}${String(m).padStart(2, '0')}`
                const att = await getAttData(ymStr)
                Object.assign(allAtt, att.d)
              }
            }
            const used = computePeriodUsed(worker.id, latest.grantDate!, allAtt)
            const grant = (latest as { grantDays?: number; grant?: number }).grantDays
              ?? (latest as { grant?: number }).grant ?? 0
            const carry = (latest as { carryOver?: number; carry?: number }).carryOver
              ?? (latest as { carry?: number }).carry ?? 0
            const adj = (latest as { adjustment?: number; adj?: number }).adjustment
              ?? (latest as { adj?: number }).adj ?? 0
            const total = grant + carry - adj
            const remaining = Math.max(0, total - used.requestedPeriodUsed)
            if (remaining <= 0) {
              return NextResponse.json(
                { error: '有給休暇の残日数がありません。管理者にご確認ください。' },
                { status: 400 }
              )
            }
          }
        } catch (chkErr) {
          // 残チェックでエラーが出ても申請自体は通す（既存運用継続性）
          console.warn('[staff/leave] 残チェック失敗:', chkErr)
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
