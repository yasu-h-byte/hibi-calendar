import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const ym = searchParams.get('ym')

  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)
    const prescribedDays = main.workDays[ym] || 0
    // カレンダーから現場別所定日数を取得（5月以降は手入力不要）
    const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
    const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
    const result = computeMonthly(main, att.d, att.sd, ym, prescribedDays, hasCalendarData ? siteWorkDaysMap : undefined)

    const locked = !!(main.locks[ym])
    const workDays = prescribedDays

    // Site name map for frontend display
    const siteNames: Record<string, string> = {}
    for (const s of main.sites) {
      siteNames[s.id] = s.name
    }

    return NextResponse.json({
      workers: result.workers,
      subcons: result.subcons,
      sites: result.sites,
      totals: result.totals,
      locked,
      workDays,
      prescribedDays,
      siteNames,
      hasCalendarData,
      siteWorkDays: siteWorkDaysMap,
    })
  } catch (error) {
    console.error('Monthly API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Failed to compute monthly data', detail: errMsg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'setWorkDays') {
      const { ym, value } = body
      if (!ym || !/^\d{6}$/.test(ym)) {
        return NextResponse.json({ error: 'ym required' }, { status: 400 })
      }
      const numValue = Number(value) || 0
      const docRef = doc(db, 'demmen', 'main')
      await updateDoc(docRef, { [`workDays.${ym}`]: numValue })
      return NextResponse.json({ success: true, workDays: numValue })
    }

    if (action === 'copyPrevMonth') {
      const { ym } = body
      if (!ym || !/^\d{6}$/.test(ym)) {
        return NextResponse.json({ error: 'ym required' }, { status: 400 })
      }

      // Calculate previous month ym
      const year = parseInt(ym.slice(0, 4))
      const month = parseInt(ym.slice(4, 6))
      let prevYear = year
      let prevMonth = month - 1
      if (prevMonth < 1) { prevMonth = 12; prevYear -= 1 }
      const prevYm = `${prevYear}${String(prevMonth).padStart(2, '0')}`

      // Read previous month attendance data
      const prevDocSnap = await getDoc(doc(db, 'demmen', `att_${prevYm}`))
      if (!prevDocSnap.exists()) {
        return NextResponse.json({ error: '前月のデータが見つかりません' }, { status: 404 })
      }
      const prevData = prevDocSnap.data()
      const prevD = prevData.d || {}

      // Rewrite keys: replace prevYm with ym in attendance keys
      const newD: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(prevD)) {
        // Keys are like: siteId_workerId_ym_dd
        const newKey = key.replace(`_${prevYm}_`, `_${ym}_`)
        newD[newKey] = value
      }

      // Write to current month doc (merge with existing sd)
      const curDocRef = doc(db, 'demmen', `att_${ym}`)
      const curDocSnap = await getDoc(curDocRef)
      if (curDocSnap.exists()) {
        await updateDoc(curDocRef, { d: newD })
      } else {
        await setDoc(curDocRef, { d: newD, sd: {} })
      }

      return NextResponse.json({ success: true, copiedEntries: Object.keys(newD).length })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('Monthly POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
