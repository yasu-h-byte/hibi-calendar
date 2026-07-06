import { NextRequest, NextResponse } from 'next/server'
import { getApiRole, isManagerRole } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs, deleteDoc, doc, getDoc, updateDoc } from '@/lib/fsdb'
import { ym7 } from '@/lib/ym'

export async function POST(request: NextRequest) {
  // 指定月の【全現場】のカレンダーと署名を削除する破壊的操作。
  //   管理者・事業責任者のみ（職長・事務は不可）。
  //   旧: checkApiAuth のみ → ログインできる誰でも全現場の承認済みカレンダーを消せた。監査(B)で塞いだ。
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: 'リセット権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { ym: ymRaw } = body

    if (!ymRaw) {
      return NextResponse.json({ error: 'ym parameter required' }, { status: 400 })
    }
    // siteCalendar の ym フィールドは "YYYY-MM" 形式（2026-05-08 正規化）
    const ym = ym7(ymRaw)

    let deletedCalendars = 0
    let deletedSignatures = 0

    // 1. Delete all siteCalendar docs for this month
    const calQ = query(collection(db, 'siteCalendar'), where('ym', '==', ym))
    const calSnap = await getDocs(calQ)
    for (const d of calSnap.docs) {
      await deleteDoc(d.ref)
      deletedCalendars++
    }

    // 2. Delete all calendarSign docs for this month
    // ※ 永続アーカイブ calendarSignLog は法的証跡として**削除しない**（過去の承認状況を残す）。
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym))
    const signSnap = await getDocs(signQ)
    for (const d of signSnap.docs) {
      await deleteDoc(d.ref)
      deletedSignatures++
    }

    // 3. Clear workDays and siteWorkDays in demmen/main
    const ymKey = ym.replace('-', '')
    const mainRef = doc(db, 'demmen', 'main')
    const mainSnap = await getDoc(mainRef)
    if (mainSnap.exists()) {
      const data = mainSnap.data()
      const updates: Record<string, unknown> = {}

      // Clear siteWorkDays for this month
      if (data.siteWorkDays && data.siteWorkDays[ymKey]) {
        const siteWorkDays = { ...data.siteWorkDays }
        delete siteWorkDays[ymKey]
        updates.siteWorkDays = siteWorkDays
      }

      // Clear workDays for this month
      if (data.workDays && data.workDays[ymKey]) {
        const workDays = { ...data.workDays }
        delete workDays[ymKey]
        updates.workDays = workDays
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(mainRef, updates)
      }
    }

    return NextResponse.json({
      success: true,
      deletedCalendars,
      deletedSignatures,
      message: `${ym} のカレンダーデータを初期化しました（カレンダー${deletedCalendars}件、署名${deletedSignatures}件を削除）`,
    })
  } catch (error) {
    console.error('Calendar reset error:', error)
    return NextResponse.json({ error: 'Reset failed' }, { status: 500 })
  }
}
