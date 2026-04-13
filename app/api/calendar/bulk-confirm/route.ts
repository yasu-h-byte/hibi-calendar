import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { ym, sites, approvedBy } = await request.json() as {
      ym: string
      sites: { siteId: string; days: Record<string, DayType> }[]
      approvedBy: number
    }

    if (!ym || !sites || !Array.isArray(sites) || sites.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const [checkY, checkM] = ym.split('-').map(Number)
    const daysInMonth = new Date(checkY, checkM, 0).getDate()
    const legalLimitHours = daysInMonth * 40 / 7

    const errors: string[] = []
    const ymKey = ym.replace('-', '')

    // Validate all sites first
    for (const site of sites) {
      const workDayCount = Object.values(site.days).filter(d => d === 'work').length
      const prescribedHours = workDayCount * 7
      if (prescribedHours > legalLimitHours) {
        const maxDays = Math.floor(legalLimitHours / 7)
        errors.push(
          `${site.siteId}: 出勤${workDayCount}日(${prescribedHours}h)が法定上限${maxDays}日(${(Math.round(legalLimitHours * 10) / 10).toFixed(1)}h)を超えています`
        )
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('\n') }, { status: 400 })
    }

    // Save all sites
    const siteWorkDaysUpdate: Record<string, number> = {}

    for (const site of sites) {
      const docId = `${site.siteId}_${ym}`
      const workDayCount = Object.values(site.days).filter(d => d === 'work').length

      await setDoc(doc(db, 'siteCalendar', docId), {
        siteId: site.siteId,
        ym,
        days: site.days,
        status: 'approved',
        submittedAt: new Date().toISOString(),
        submittedBy: approvedBy,
        approvedAt: new Date().toISOString(),
        approvedBy,
        rejectedReason: null,
        updatedAt: new Date().toISOString(),
        updatedBy: approvedBy,
      })

      siteWorkDaysUpdate[site.siteId] = workDayCount
    }

    // Update siteWorkDays and global workDays
    const mainRef = doc(db, 'demmen', 'main')
    await setDoc(mainRef, {
      siteWorkDays: { [ymKey]: siteWorkDaysUpdate },
    }, { merge: true })

    // Recalculate max workDays across all sites for the month
    const mainSnap = await getDoc(mainRef)
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    const allSiteWorkDays = (mainData.siteWorkDays || {})[ymKey] || {}
    const maxWorkDays = Math.max(...Object.values(allSiteWorkDays) as number[])
    await setDoc(mainRef, {
      workDays: { [ymKey]: maxWorkDays },
    }, { merge: true })

    await logActivity(
      String(approvedBy || 'admin'),
      'calendar.bulk-confirm',
      `${sites.map(s => s.siteId).join(', ')} ${ym} を一括確定`
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to bulk confirm:', error)
    return NextResponse.json({ error: 'Failed to bulk confirm' }, { status: 500 })
  }
}
