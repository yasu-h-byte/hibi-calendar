import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getWorkersForSite } from '@/lib/sites'

function hashIP(ip: string): string {
  let hash = 0
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { workerId, ym } = body

    // Support both single siteId and bulk siteIds
    const siteIds: string[] = body.siteIds || (body.siteId ? [body.siteId] : [])

    if (!workerId || !ym || siteIds.length === 0) {
      return NextResponse.json({ error: 'workerId, ym, siteId(s) required' }, { status: 400 })
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const ipHash = hashIP(ip)
    const signedAt = new Date().toISOString()

    const results: { siteId: string; success: boolean; error?: string; signedAt?: string }[] = []

    for (const siteId of siteIds) {
      // 全現場署名方式: 配置チェックは行わず、外国人スタッフであれば署名可能
      // Check if site calendar is approved
      const calDocId = `${siteId}_${ym}`
      const calDoc = await getDoc(doc(db, 'siteCalendar', calDocId))
      if (!calDoc.exists() || calDoc.data().status !== 'approved') {
        results.push({ siteId, success: false, error: 'Calendar not approved' })
        continue
      }

      // Check if already signed
      const signDocId = `${workerId}_${ym}_${siteId}`
      const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))
      if (existingSign.exists()) {
        results.push({ siteId, success: true, signedAt: existingSign.data().signedAt })
        continue
      }

      await setDoc(doc(db, 'calendarSign', signDocId), {
        workerId,
        ym,
        siteId,
        signedAt,
        method: 'tap',
        ipHash,
      })

      results.push({ siteId, success: true, signedAt })
    }

    // For single-site backwards compatibility
    if (siteIds.length === 1) {
      const r = results[0]
      if (!r.success) {
        return NextResponse.json({ error: r.error }, { status: 400 })
      }
      return NextResponse.json({ success: true, signedAt: r.signedAt })
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    console.error('Failed to sign:', error)
    return NextResponse.json({ error: 'Failed to sign' }, { status: 500 })
  }
}
