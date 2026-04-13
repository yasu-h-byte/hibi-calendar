import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs, deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { ym } = body

    if (!ym) {
      return NextResponse.json({ error: 'ym parameter required' }, { status: 400 })
    }

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
