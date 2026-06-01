import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { ym7 } from '@/lib/ym'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'

export async function GET(request: NextRequest) {

  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ymRaw = request.nextUrl.searchParams.get('ym')
  if (!ymRaw) {
    return NextResponse.json({ error: 'ym parameter required' }, { status: 400 })
  }
  // siteCalendar の ym フィールドは "YYYY-MM" 形式（2026-05-08 正規化）
  const ym = ym7(ymRaw)

  try {
    // 共通データ取得 → このルートでは「全現場 × 全外国人 × 署名状態」を投影
    const m = await loadCalendarMatrix(ym)

    const eligibleForeignWorkers = m.eligibleForeignWorkers.map(w => ({ id: w.id, name: w.name }))

    const sites = m.sitesWithWorkers.map(sw => {
      const cal = m.siteCalendars[sw.site.id]
      // 「承認後に修正された」判定 — approvedAt 以降に updatedAt が動いた
      //   ※ 通常の保存（職長 draft 編集等）は status='approved' になる前なので影響しない
      //   ※ approve 時に updatedAt が approvedAt とほぼ同時ならズレ吸収のため数秒の buffer は不要
      //     （approve API は updatedAt を触らないため、自然に approvedAt > updatedAt のはず）
      const wasRevised = !!(
        cal?.status === 'approved' &&
        cal.approvedAt &&
        cal.updatedAt &&
        cal.updatedAt > cal.approvedAt
      )
      const assignedHere = m.assignedWorkerIdsBySite[sw.site.id]

      return {
        siteId: sw.site.id,
        siteName: sw.site.name,
        days: cal?.days || null,
        status: cal?.status || null,
        submittedBy: cal?.submittedBy || null,
        approvedBy: cal?.approvedBy || null,
        approvedAt: cal?.approvedAt || null,
        updatedAt: cal?.updatedAt || null,
        updatedBy: cal?.updatedBy || null,
        rejectedReason: cal?.rejectedReason || null,
        wasRevised,
        // 全現場に対して同じ署名対象スタッフを返す（公開ページと数字を揃えるため）
        // 各 worker に assignedHere / reconfirmedAfterRevision フラグを追加
        workers: eligibleForeignWorkers.map(w => {
          const sigKey = `${w.id}_${sw.site.id}`
          const sigVal = m.signaturesBySite[sigKey]
          const signed = !!sigVal
          const signedAt = sigVal && sigVal !== 'true' ? sigVal : null
          const isAssignedHere = assignedHere?.has(w.id) || false
          // 修正後に再確認したか: 署名時刻が updatedAt より後（= 修正後にサインした）
          const reconfirmedAfterRevision = !!(
            wasRevised && signed && signedAt && cal!.updatedAt && signedAt > cal!.updatedAt
          )
          return {
            id: w.id,
            name: w.name,
            signed,
            signedAt,
            assignedHere: isAssignedHere,
            reconfirmedAfterRevision,
          }
        }),
      }
    })

    return NextResponse.json({ sites })
  } catch (error) {
    console.error('Failed to fetch status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}
