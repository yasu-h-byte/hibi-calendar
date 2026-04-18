import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, getAssign } from '@/lib/compute'
import { getApprovalForDay, setApprovalForDay } from '@/lib/attendance'
import { AttendanceEntry, DayType } from '@/types'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const siteId = request.nextUrl.searchParams.get('siteId')
  const ym = request.nextUrl.searchParams.get('ym')
  if (!siteId || !ym) {
    return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)

    const site = main.sites.find(s => s.id === siteId)
    if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 })

    // Get workers assigned to this site (with 12-month lookback)
    const assignData = getAssign(main, siteId, ym)
    const workerIds = assignData.workers

    // Get days in month
    const [y, m] = [parseInt(ym.substring(0, 4)), parseInt(ym.substring(4, 6))]
    const daysInMonth = new Date(y, m, 0).getDate()

    // Build attendance grid first (to check who has data)
    const allWorkerEntries: Record<number, Record<number, AttendanceEntry>> = {}
    for (const wid of workerIds) {
      allWorkerEntries[wid] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${wid}_${ym}_${String(d)}`
        if (att.d[key]) allWorkerEntries[wid][d] = att.d[key]
      }
    }

    // For months where massign has too many workers (pre-2026 bulk assignment),
    // filter to only those with actual attendance data
    const currentAssignCount = main.assign[siteId]?.workers?.length || 0
    const monthKey = `${siteId}_${ym}`
    const useMassignFilter = main.massign[monthKey] && workerIds.length > currentAssignCount * 2
    const filteredWorkerIds = useMassignFilter
      ? workerIds.filter((wid: number) => Object.keys(allWorkerEntries[wid] || {}).length > 0)
      : workerIds

    const workers = main.workers
      .filter(w => filteredWorkerIds.includes(w.id))
      .map(w => ({
        id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      }))

    const workerEntries: Record<string, Record<number, AttendanceEntry>> = {}
    for (const w of workers) {
      workerEntries[w.id] = allWorkerEntries[w.id] || {}
    }

    // Get subcons assigned to this site (with 12-month lookback)
    const subconIds = assignData.subcons
    const subcons = main.subcons
      .filter(sc => subconIds.includes(sc.id))
      .map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

    const subconEntries: Record<string, Record<number, { n: number; on: number }>> = {}
    for (const sc of subcons) {
      subconEntries[sc.id] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${sc.id}_${ym}_${String(d)}`
        if (att.sd[key]) subconEntries[sc.id][d] = att.sd[key]
      }
    }

    // 組織別ロック状態（後方互換: 旧 locks[ym] もチェック）
    const lockedLegacy = !!(main.locks[ym])
    const lockedHibi = !!(main.locks[`${ym}_hibi`]) || lockedLegacy
    const lockedHfu = !!(main.locks[`${ym}_hfu`]) || lockedLegacy
    const locked = lockedHibi && lockedHfu

    // Foreman name (check mforeman for monthly override)
    const mfKey = `${siteId}_${ym}`
    const mf = main.mforeman?.[mfKey]
    const effectiveForeman = mf?.foreman ?? mf?.wid ?? site.foreman
    const foremanWorker = main.workers.find(w => w.id === effectiveForeman)
    const foremanName = foremanWorker?.name || ''
    const foremanNote = mf?.note || ''

    // Approval status per day
    // Check both the attendanceApprovals collection (new) and att doc approvals field (legacy)
    const approvals: Record<number, boolean> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const approvalKey = `${siteId}_${ym}_${String(d)}`
      // Check attendanceApprovals collection first (where foreman writes)
      const collectionApproval = await getApprovalForDay(siteId, ym, d)
      if (collectionApproval?.foreman) {
        approvals[d] = true
      } else if (att.approvals?.[approvalKey]) {
        // Fallback: legacy approvals stored inside att_ document
        approvals[d] = true
      }
    }

    // workDays for this month
    const workDaysValue = main.workDays[ym] ?? null

    // Per-site workDays from approved calendars
    const siteWorkDaysForMonth = main.siteWorkDays[ym] ?? {}
    const siteWorkDaysValue = siteWorkDaysForMonth[siteId] ?? null

    // Load approved site calendar for holiday work detection
    const calYm = `${String(y)}-${String(m).padStart(2, '0')}`
    const calDocId = `${siteId}_${calYm}`
    const calSnap = await getDoc(doc(db, 'siteCalendar', calDocId))
    const calData = calSnap.exists() ? calSnap.data() : null
    const calendarDays: Record<string, DayType> | null =
      calData?.status === 'approved' && calData?.days ? calData.days as Record<string, DayType> : null

    // All active workers (for assignment modal)
    const allWorkers = main.workers
      .filter(w => !w.retired)
      .map(w => ({ id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job }))

    // foremanOverride: non-null only when mforeman actually overrides the default
    const foremanOverride = mf
      ? { name: foremanWorker?.name || '', note: mf.note || '' }
      : null

    // 帰国情報: 2つのソースから統合
    const monthStart = `${String(y)}-${String(m).padStart(2, '0')}-01`
    const monthEnd = `${String(y)}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
    const homeLeaves: { workerId: number; workerName: string; startDate: string; endDate: string; reason: string; status: string }[] = []
    const seenKeys = new Set<string>()

    try {
      // ① スマホ申請（homeLongLeaveコレクション）
      const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
      hlSnap.forEach(d => {
        const hl = d.data()
        if (hl.status !== 'approved' && hl.status !== 'foreman_approved') return
        if (hl.endDate < monthStart || hl.startDate > monthEnd) return
        const key = `${hl.workerId}_${hl.startDate}`
        seenKeys.add(key)
        homeLeaves.push({
          workerId: hl.workerId,
          workerName: hl.workerName,
          startDate: hl.startDate,
          endDate: hl.endDate,
          reason: hl.reason || '一時帰国',
          status: hl.status,
        })
      })
    } catch (e) {
      // homeLongLeave コレクションが存在しない場合は無視
      console.warn('homeLongLeave fetch skipped:', e)
    }

    // ② 手動登録（demmen/main の homeLeaves 配列）
    try {
      const mainDocSnap = await getDoc(doc(db, 'demmen', 'main'))
      if (mainDocSnap.exists()) {
        const manualHomeLeaves: { id?: string; workerId: number; workerName: string; startDate: string; endDate: string; reason?: string }[] =
          mainDocSnap.data().homeLeaves || []
        for (const mhl of manualHomeLeaves) {
          if (!mhl.startDate || !mhl.endDate) continue
          if (mhl.endDate < monthStart || mhl.startDate > monthEnd) continue
          const key = `${mhl.workerId}_${mhl.startDate}`
          if (seenKeys.has(key)) continue
          homeLeaves.push({
            workerId: mhl.workerId,
            workerName: mhl.workerName,
            startDate: mhl.startDate,
            endDate: mhl.endDate,
            reason: mhl.reason || '一時帰国',
            status: 'approved',
          })
        }
      }
    } catch (e) {
      console.warn('homeLeaves from main fetch skipped:', e)
    }

    return NextResponse.json({
      site: { id: site.id, name: site.name, foreman: effectiveForeman, foremanName, foremanNote },
      foremanOverride,
      year: y, month: m, daysInMonth, ym,
      workers, subcons,
      workerEntries, subconEntries,
      locked,
      lockedHibi,
      lockedHfu,
      approvals,
      workDays: workDaysValue,
      siteWorkDays: siteWorkDaysValue,
      allWorkers,
      sites: main.sites.map(s => ({ id: s.id, name: s.name, archived: s.archived })),
      calendarDays,
      homeLeaves,
    })
  } catch (error) {
    console.error('Grid GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    const { doc, setDoc, getDoc } = await import('firebase/firestore')
    const { db } = await import('@/lib/firebase')

    // Action: save workDays
    if (action === 'saveWorkDays') {
      const { ym, value } = body
      if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, { workDays: { [ym]: value } }, { merge: true })
      return NextResponse.json({ success: true })
    }

    // Action: save assignments
    if (action === 'saveAssign') {
      const { siteId, workerIds } = body
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      // Read current assign to preserve subcons
      const snap = await getDoc(docRef)
      const current = snap.exists() ? snap.data() : {}
      const currentAssign = (current.assign || {})[siteId] || {}
      await setDoc(docRef, {
        assign: {
          [siteId]: {
            ...currentAssign,
            workers: workerIds || [],
          }
        }
      }, { merge: true })
      return NextResponse.json({ success: true })
    }

    // Action: approve/unapprove a day
    if (action === 'approve') {
      const { siteId, ym, day, approvedBy } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      await setApprovalForDay(siteId, ym, day, approvedBy || 0)
      return NextResponse.json({ success: true })
    }

    if (action === 'unapprove') {
      const { siteId, ym, day } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      const { deleteDoc } = await import('firebase/firestore')
      const approvalDocRef = doc(db, 'attendanceApprovals', `${siteId}_${ym}_${String(day)}`)
      await deleteDoc(approvalDocRef)
      return NextResponse.json({ success: true })
    }

    // Default: save attendance entry
    const { siteId, ym, workerId, day, entry, subconId, subconEntry } = body

    if (!siteId || !ym || !day) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', `att_${ym}`)

    if (workerId !== undefined && entry !== undefined) {
      const key = `${siteId}_${workerId}_${ym}_${String(day)}`
      if (entry && typeof entry === 'object') {
        // 有効なエントリ: ソース情報を付与して保存
        const entryWithSource = { ...entry, s: 'admin' }
        await setDoc(docRef, { d: { [key]: entryWithSource } }, { merge: true })
      } else {
        // nullまたは無効なエントリ: フィールドを削除
        const { deleteField } = await import('firebase/firestore')
        const { updateDoc } = await import('firebase/firestore')
        await updateDoc(docRef, { [`d.${key}`]: deleteField() })
      }
    }

    if (subconId !== undefined && subconEntry !== undefined) {
      const key = `${siteId}_${subconId}_${ym}_${String(day)}`
      if (subconEntry && typeof subconEntry === 'object') {
        await setDoc(docRef, { sd: { [key]: subconEntry } }, { merge: true })
      } else {
        const { deleteField, updateDoc } = await import('firebase/firestore')
        await updateDoc(docRef, { [`sd.${key}`]: deleteField() })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Grid POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
