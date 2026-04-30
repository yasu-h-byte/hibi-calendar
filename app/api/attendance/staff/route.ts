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
} from '@/lib/attendance'
import { getSites } from '@/lib/sites'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
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
    // Build site name lookup
    const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
    const siteNames: Record<string, string> = {}
    if (mainDoc.exists()) {
      const sites = mainDoc.data().sites || []
      for (const s of sites) siteNames[s.id] = (s.name as string || '').slice(0, 3)
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
    // 5月以降のみ表示（4月はデータ整備期間のため未表示）
    let toolBudgetRemaining: number | null = null
    let toolBudgetPeriodStart: string | null = null
    let toolBudgetPeriodEnd: string | null = null
    const displayToolBudget = now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() + 1 >= 5)
    try {
      const visa = worker.visaType
      const isForeign = visa && (visa.startsWith('jisshu') || visa.startsWith('tokutei'))
      if (isForeign && displayToolBudget) {
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

    // 有給残日数（5月以降のみ表示。4月はデータ整備期間）
    // Phase 8: FIFO内訳（繰越分・当期付与分の別々表示）
    let plRemaining: number | null = null
    let plExpiryDate: string | null = null  // 当期付与分の有効期限（従来フィールド、後方互換）
    let plCarryOverRemaining: number | null = null
    let plCarryOverExpiryDate: string | null = null
    let plCarryOverExpiryStatus: 'ok' | 'warning' | 'expired' | null = null
    let plGrantRemaining: number | null = null
    let plGrantExpiryDate: string | null = null
    const displayPl = now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() + 1 >= 5)
    try {
      if (displayPl) {
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
      }
    } catch { /* ignore */ }

    return NextResponse.json({
      worker: { id: worker.id, name: worker.name, nameVi: worker.nameVi },
      site: { id: site.id, name: site.name },
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

    // Check site exists and is active
    const allActiveSites = await getSites()
    if (!allActiveSites.find(s => s.id === siteId)) {
      return NextResponse.json({ error: 'Site not found or archived' }, { status: 403 })
    }

    // Check approval lock
    const ym = ymKey(year, month)
    const approval = await getApprovalForDay(siteId, ym, day)
    if (approval?.foreman) {
      return NextResponse.json({ error: 'Day is locked (approved)' }, { status: 409 })
    }

    // Build entry
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
          const startMin = parseInt(String(startTime).split(':')[0]) * 60 + parseInt(String(startTime).split(':')[1] || '0')
          const endMin = parseInt(String(endTime).split(':')[0]) * 60 + parseInt(String(endTime).split(':')[1] || '0')
          let actualMin = endMin - startMin
          if (entry.b1) actualMin -= 30
          if (entry.b2) actualMin -= 60
          if (entry.b3) actualMin -= 30
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
      case 'leave':
        entry = { w: 0, p: 1, s: 'staff' }
        break
      case 'site_off':
        entry = { w: 0, h: 1, s: 'staff' }
        break
      default:
        return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
    }

    await setAttendanceEntry(siteId, worker.id, ym, day, entry)

    return NextResponse.json({ success: true, entry })
  } catch (error) {
    console.error('Staff POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
