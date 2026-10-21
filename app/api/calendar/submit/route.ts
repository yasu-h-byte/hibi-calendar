import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { ym7 } from '@/lib/ym'
import { appendCalendarStatusLog } from '@/lib/calendar-status-log.server'

export async function POST(request: NextRequest) {
  try {
    const { siteId, ym: ymRaw } = await request.json()
    const ym = ym7(ymRaw)

    // 提出は「その現場の職長」または管理者・事業責任者のみ（他現場の職長やスタッフは不可）
    const role = await getApiRole(request, ym)
    if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // 誰がやったかは通行証（getApiRole）から決める。旧: 画面が送る body の値をそのまま記録していた（2026-10-21 総点検）
    const submittedBy = role.workerId ?? 0
    const canSubmit = isManagerRole(role.role) || (role.role === 'foreman' && role.foremanSites.includes(siteId))
    if (!canSubmit) {
      return NextResponse.json({ error: '提出権限がありません（担当現場の職長または管理者のみ）' }, { status: 403 })
    }

    const docId = `${siteId}_${ym}`
    const docRef = doc(db, 'siteCalendar', docId)
    const existing = await getDoc(docRef)

    if (!existing.exists()) {
      return NextResponse.json({ error: 'Calendar not found. Save first.' }, { status: 404 })
    }

    const submittedAt = new Date().toISOString()
    await updateDoc(docRef, {
      status: 'submitted',
      submittedAt,
      submittedBy,
      rejectedReason: null,
    })
    // 「いつ・誰が」の台帳（append-only・2026-10-22）
    await appendCalendarStatusLog({ siteId, ym, event: 'submit', by: submittedBy, at: submittedAt })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to submit:', error)
    return NextResponse.json({ error: 'Failed to submit' }, { status: 500 })
  }
}
