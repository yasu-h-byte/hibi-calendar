import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'
import { checkCalendarLegal } from '@/lib/calendar-legal'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { ym, sites, approvedBy, acknowledgeWarnings } = await request.json() as {
      ym: string
      sites: { siteId: string; days: Record<string, DayType> }[]
      approvedBy: number
      acknowledgeWarnings?: boolean
    }

    if (!ym || !sites || !Array.isArray(sites) || sites.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const ymKey = ym.replace('-', '')

    // 法令適合チェック（全現場・変形労働: 月総枠/法定休日/連続勤務）
    const errorMsgs: string[] = []
    const warnMsgs: string[] = []
    for (const site of sites) {
      const legal = checkCalendarLegal(site.days, ym)
      for (const f of legal.findings) {
        if (f.severity === 'error') errorMsgs.push(`${site.siteId}: ${f.message}`)
        else if (f.severity === 'warn') warnMsgs.push(`${site.siteId}: ${f.message}`)
      }
    }
    if (errorMsgs.length > 0) {
      return NextResponse.json({ error: errorMsgs.join('\n') }, { status: 400 })
    }
    if (warnMsgs.length > 0 && !acknowledgeWarnings) {
      return NextResponse.json({
        error: '法令上の確認事項があります。内容を確認の上で承認してください。',
        requiresAcknowledge: true,
        warnings: warnMsgs,
      }, { status: 400 })
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
