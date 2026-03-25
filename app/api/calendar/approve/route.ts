import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc, getDoc, setDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'

export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, approvedBy } = await request.json()
    const docId = `${siteId}_${ym}`

    // Get the calendar data to count work days
    const calSnap = await getDoc(doc(db, 'siteCalendar', docId))
    const calData = calSnap.exists() ? calSnap.data() : null
    const days: Record<string, DayType> | null = calData?.days || null

    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy,
    })

    // Auto-calculate work days from the calendar and save per-site
    if (days) {
      const workDayCount = Object.values(days).filter(d => d === 'work').length

      // Convert ym from "YYYY-MM" to "YYYYMM" for workDays key
      const ymKey = ym.replace('-', '')

      // Save per-site workDays: siteWorkDays.{YYYYMM}.{siteId} = count
      const mainRef = doc(db, 'demmen', 'main')
      await setDoc(mainRef, {
        siteWorkDays: { [ymKey]: { [siteId]: workDayCount } },
      }, { merge: true })

      // Also update global workDays with the max across all sites
      const mainSnap = await getDoc(mainRef)
      const mainData = mainSnap.exists() ? mainSnap.data() : {}
      const siteWorkDaysForMonth = (mainData.siteWorkDays || {})[ymKey] || {}
      const maxWorkDays = Math.max(...Object.values(siteWorkDaysForMonth) as number[])
      await setDoc(mainRef, {
        workDays: { [ymKey]: maxWorkDays },
      }, { merge: true })
    }

    await logActivity(String(approvedBy || 'admin'), 'calendar.approve', `${siteId} ${ym} を承認`)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to approve:', error)
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 })
  }
}
