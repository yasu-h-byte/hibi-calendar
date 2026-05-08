import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { ym7 } from '@/lib/ym'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym: ymRaw, days, updatedBy } = await request.json()
    // siteCalendar の docId/ym は "YYYY-MM" 形式で統一（2026-05-08 正規化）
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    // Get existing doc to preserve status
    const existing = await getDoc(doc(db, 'siteCalendar', docId))
    const existingData = existing.exists() ? existing.data() : {}

    await setDoc(doc(db, 'siteCalendar', docId), {
      siteId,
      ym,
      days,
      status: existingData.status === 'rejected' ? 'draft' : (existingData.status || 'draft'),
      submittedAt: existingData.submittedAt || null,
      submittedBy: existingData.submittedBy || null,
      approvedAt: existingData.approvedAt || null,
      approvedBy: existingData.approvedBy || null,
      rejectedReason: existingData.status === 'rejected' ? null : (existingData.rejectedReason || null),
      updatedAt: new Date().toISOString(),
      updatedBy,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to save days:', error)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
