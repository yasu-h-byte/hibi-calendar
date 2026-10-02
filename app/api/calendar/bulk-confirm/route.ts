import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, updateDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'
import { checkSiteCalendarLegal, legalBlockResponse } from '@/lib/calendar-legal-check'
import { countWorkDays, resolveDayType } from '@/lib/calendar'
import { ym7 } from '@/lib/ym'

export async function POST(request: NextRequest) {
  // 提出を飛ばした直接確定は管理者・事業責任者のみ
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: '確定権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
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
    const ym7s = ym7(ym)
    const [yy, mm] = [parseInt(ym7s.slice(0, 4), 10), parseInt(ym7s.slice(5, 7), 10)]
    const dim = new Date(yy, mm, 0).getDate()
    const sameDays = (a: Record<string, DayType | string> | null | undefined, b: Record<string, DayType | string> | null | undefined) => {
      for (let d = 1; d <= dim; d++) if (resolveDayType(a, yy, mm, d) !== resolveDayType(b, yy, mm, d)) return false
      return true
    }

    // 2026-10-02 総合点検: 承認済みで内容が同じ現場は飛ばす（書き直さない）。
    //   旧: 画面が表示中の全現場を送り、承認済み・署名済みの現場も approvedAt/updatedAt を今に書き直していたため、
    //   配置者のスマホに「更新あり・再署名」が出る一方、管理画面は署名済みのままで食い違った（submittedBy も管理者に化けた）。
    //   承認済みで内容が変わる現場は「承認後の修正」として days と updatedAt だけ変える（再署名は配置者だけ・save-days と同じ）
    type Existing = { status?: string; days?: Record<string, DayType>; submittedAt?: string; submittedBy?: number; approvedAt?: string; approvedBy?: number }
    const existingById = new Map<string, Existing | null>()
    for (const site of sites) {
      const snap = await getDoc(doc(db, 'siteCalendar', `${site.siteId}_${ym}`))
      existingById.set(site.siteId, snap.exists() ? (snap.data() as Existing) : null)
    }
    const toWrite = sites.filter(site => {
      const ex = existingById.get(site.siteId)
      return !(ex?.status === 'approved' && sameDays(ex.days, site.days))
    })

    // 法令適合チェック（書く現場だけ・変形労働: 月総枠/法定休日/連続勤務。前月・翌月のカレンダー込み）
    const errorMsgs: string[] = []
    const warnMsgs: string[] = []
    for (const site of toWrite) {
      const legal = await checkSiteCalendarLegal(site.siteId, ym, site.days)
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

    // Save all sites（時刻は1回だけ取る。approvedAt と updatedAt が1ms ずれると「承認後に修正あり」に見える）
    const now = new Date().toISOString()
    const siteWorkDaysUpdate: Record<string, number> = {}
    const skipped: string[] = []
    const revised: string[] = []

    for (const site of sites) {
      const docId = `${site.siteId}_${ym}`
      const workDayCount = countWorkDays(site.days, ym)
      siteWorkDaysUpdate[site.siteId] = workDayCount
      const ex = existingById.get(site.siteId)
      if (!toWrite.includes(site)) { skipped.push(site.siteId); continue }

      if (ex?.status === 'approved') {
        // 承認後の修正（承認の記録は残し、days と updatedAt だけ更新）
        await updateDoc(doc(db, 'siteCalendar', docId), { days: site.days, updatedAt: now, updatedBy: approvedBy })
        revised.push(site.siteId)
        continue
      }
      await setDoc(doc(db, 'siteCalendar', docId), {
        siteId: site.siteId,
        ym,
        days: site.days,
        status: 'approved',
        submittedAt: ex?.submittedAt || now,
        submittedBy: ex?.submittedBy ?? approvedBy,
        approvedAt: now,
        approvedBy,
        rejectedReason: null,
        updatedAt: now,
        updatedBy: approvedBy,
      })
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
        + (skipped.length > 0 ? `（承認済みで変更なし: ${skipped.join(', ')}）` : '')
        + (revised.length > 0 ? `（承認後修正: ${revised.join(', ')}）` : ''),
    )

    return NextResponse.json({ success: true, skipped, revised })
  } catch (error) {
    console.error('Failed to bulk confirm:', error)
    return NextResponse.json({ error: 'Failed to bulk confirm' }, { status: 500 })
  }
}
