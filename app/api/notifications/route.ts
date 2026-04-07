import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { getUpcomingGrants } from '@/lib/leave-auto'

interface Notification {
  id: string
  icon: string
  message: string
  type: 'warning' | 'error' | 'info'
  count?: number
}

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const now = new Date()
    const currentYm = ymKey(now.getFullYear(), now.getMonth() + 1)
    const today = now.getDate()
    const notifications: Notification[] = []

    const main = await getMainData()
    const activeWorkers = main.workers.filter(w => !w.retired)

    // 1. Calendar unsigned workers (batch query instead of N+1 reads)
    try {
      const activeSites = main.sites.filter(s => !s.archived)

      // Collect all expected worker×site combinations
      const expectedSignIds = new Set<string>()
      for (const site of activeSites) {
        const monthKey = `${site.id}_${currentYm}`
        const mAssign = main.massign[monthKey]
        const dAssign = main.assign[site.id]
        const workerIds = mAssign?.workers || dAssign?.workers || []

        for (const wid of workerIds) {
          expectedSignIds.add(`${wid}_${currentYm}_${site.id}`)
        }
      }

      // Single Firestore query to get ALL signatures for this month
      const signQuery = query(collection(db, 'calendarSign'), where('ym', '==', currentYm))
      const signSnaps = await getDocs(signQuery)
      const existingSignIds = new Set<string>()
      signSnaps.forEach(snap => existingSignIds.add(snap.id))

      // Count unsigned by checking in memory
      let unsignedCount = 0
      for (const id of expectedSignIds) {
        if (!existingSignIds.has(id)) {
          unsignedCount++
        }
      }

      if (unsignedCount > 0) {
        notifications.push({
          id: 'unsigned-calendar',
          icon: '\uD83D\uDCC5',
          message: `就業カレンダー未署名: ${unsignedCount}件の署名が未完了です`,
          type: 'warning',
          count: unsignedCount,
        })
      }
    } catch (e) {
      console.error('Calendar sign check error:', e)
    }

    // 2. PL remaining <= 3 days
    try {
      const currentFy = now.getMonth() + 1 >= 10
        ? String(now.getFullYear())
        : String(now.getFullYear() - 1)

      const lowPLWorkers: string[] = []

      for (const w of activeWorkers) {
        const records = main.plData[String(w.id)] || []
        if (records.length === 0) continue

        const fyRecord = records.find(r => r.fy === currentFy)
        if (!fyRecord) continue

        const total = fyRecord.grantDays + fyRecord.carryOver + fyRecord.adjustment
        const used = fyRecord.used || 0
        const remaining = total - used

        if (remaining <= 3 && total > 0) {
          lowPLWorkers.push(w.name)
        }
      }

      if (lowPLWorkers.length > 0) {
        notifications.push({
          id: 'low-pl',
          icon: '\uD83C\uDF34',
          message: `有給残3日以下: ${lowPLWorkers.slice(0, 3).join('、')}${lowPLWorkers.length > 3 ? ` 他${lowPLWorkers.length - 3}名` : ''}`,
          type: 'warning',
          count: lowPLWorkers.length,
        })
      }
    } catch (e) {
      console.error('PL check error:', e)
    }

    // 3. Monthly lock status（前月が未締めの場合のみ警告。当月は進行中なので対象外）
    try {
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const prevYm = ymKey(prevDate.getFullYear(), prevDate.getMonth() + 1)
      const isPrevLocked = main.locks[prevYm]
      if (!isPrevLocked) {
        const y = prevDate.getFullYear()
        const m = prevDate.getMonth() + 1
        notifications.push({
          id: 'month-unlocked',
          icon: '\uD83D\uDD13',
          message: `月締め未完了: ${y}年${m}月がまだ締められていません`,
          type: 'warning',
        })
      }
    } catch (e) {
      console.error('Lock check error:', e)
    }

    // 4. Today's attendance not entered
    try {
      const att = await getAttData(currentYm)
      const activeSites = main.sites.filter(s => !s.archived)

      const assignedWorkerIds = new Set<number>()
      for (const site of activeSites) {
        const monthKey = `${site.id}_${currentYm}`
        const mAssign = main.massign[monthKey]
        const dAssign = main.assign[site.id]
        const workerIds = mAssign?.workers || dAssign?.workers || []
        for (const wid of workerIds) assignedWorkerIds.add(wid)
      }

      const workersWithEntry = new Set<number>()
      for (const [key, entry] of Object.entries(att.d)) {
        const parts = key.split('_')
        const day = parseInt(parts[3])
        const wid = parseInt(parts[1])
        if (day === today && entry.w !== undefined) {
          workersWithEntry.add(wid)
        }
      }

      const noEntryWorkers = activeWorkers.filter(
        w => assignedWorkerIds.has(w.id) && !workersWithEntry.has(w.id)
      )

      if (noEntryWorkers.length > 0) {
        notifications.push({
          id: 'no-attendance',
          icon: '\u274C',
          message: `出面未入力: 本日${noEntryWorkers.length}名の出面が未入力です`,
          type: 'error',
          count: noEntryWorkers.length,
        })
      }
    } catch (e) {
      console.error('Attendance check error:', e)
    }

    // 5. Upcoming / overdue PL grant dates (30 days ahead, 30 days past)
    try {
      const upcoming = getUpcomingGrants(main, 30)
      for (const u of upcoming) {
        const m = u.grantDate.getMonth() + 1
        const d = u.grantDate.getDate()
        const y = u.grantDate.getFullYear()
        const isPast = u.grantDate <= now
        const dateStr = `${y}/${m}/${d}`

        notifications.push({
          id: `pl-grant-${u.workerId}`,
          icon: isPast ? '\u26A0\uFE0F' : '\uD83C\uDF34',
          message: isPast
            ? `${u.name}の有給付与が未処理です（${dateStr}）\n新規付与: ${u.days}日（法定・勤続${u.yearsOfService}）\n繰越: ${u.carryOver}日（前回残）\n→ 合計: ${u.total}日`
            : `${u.name}の有給付与日が近づいています（${dateStr}）\n新規付与: ${u.days}日（法定・勤続${u.yearsOfService}）\n繰越: ${u.carryOver}日（前回残）\n→ 合計: ${u.total}日`,
          type: isPast ? 'warning' : 'info',
        })
      }
    } catch (e) {
      console.error('Upcoming PL grant check error:', e)
    }

    return NextResponse.json({ notifications })
  } catch (error) {
    console.error('Notifications API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
