import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

interface HomeLeave {
  id: string           // workerId_startDate (e.g., "123_2026-07-01")
  workerId: number
  workerName: string
  startDate: string    // YYYY-MM-DD (departure date)
  endDate: string      // YYYY-MM-DD (return to Japan date)
  reason: string       // '一時帰国' | 'ビザ更新帰国' | 'その他'
  note?: string        // optional notes
  createdAt: string    // ISO datetime
}

export async function GET(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const mainRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(mainRef)

    if (!snap.exists()) {
      return NextResponse.json({ homeLeaves: [] })
    }

    const data = snap.data()
    const homeLeaves: HomeLeave[] = data.homeLeaves || []

    return NextResponse.json({ homeLeaves })
  } catch (error) {
    console.error('Home leave GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { action } = body

    const mainRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(mainRef)
    const data = snap.exists() ? snap.data() : {}
    const homeLeaves: HomeLeave[] = data.homeLeaves || []

    // ── Add ──
    if (action === 'add') {
      const { workerId, workerName, startDate, endDate, reason, note } = body

      if (!workerId || !workerName || !startDate || !endDate || !reason) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      // Validate startDate < endDate
      if (startDate >= endDate) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
      }

      const id = `${workerId}_${startDate}`

      // Check for duplicate
      if (homeLeaves.some(h => h.id === id)) {
        return NextResponse.json({ error: 'Already exists' }, { status: 409 })
      }

      const newEntry: HomeLeave = {
        id,
        workerId,
        workerName,
        startDate,
        endDate,
        reason,
        ...(note ? { note } : {}),
        createdAt: new Date().toISOString(),
      }

      homeLeaves.push(newEntry)
      await updateDoc(mainRef, { homeLeaves })
      await logActivity('admin', 'homeLeave.add', `${workerName} 一時帰国登録 ${startDate}〜${endDate}`)

      return NextResponse.json({ success: true, id })
    }

    // ── Update ──
    if (action === 'update') {
      const { id, startDate, endDate, reason, note } = body

      if (!id) {
        return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      }

      const idx = homeLeaves.findIndex(h => h.id === id)
      if (idx === -1) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      // Merge updates
      if (startDate !== undefined) homeLeaves[idx].startDate = startDate
      if (endDate !== undefined) homeLeaves[idx].endDate = endDate
      if (reason !== undefined) homeLeaves[idx].reason = reason
      if (note !== undefined) homeLeaves[idx].note = note

      // Validate dates after merge
      if (homeLeaves[idx].startDate >= homeLeaves[idx].endDate) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
      }

      await updateDoc(mainRef, { homeLeaves })
      await logActivity('admin', 'homeLeave.update', `${homeLeaves[idx].workerName} 一時帰国更新 ${homeLeaves[idx].startDate}〜${homeLeaves[idx].endDate}`)

      return NextResponse.json({ success: true })
    }

    // ── Delete ──
    if (action === 'delete') {
      const { id } = body

      if (!id) {
        return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      }

      const target = homeLeaves.find(h => h.id === id)
      if (!target) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      const updated = homeLeaves.filter(h => h.id !== id)
      await updateDoc(mainRef, { homeLeaves: updated })
      await logActivity('admin', 'homeLeave.delete', `${target.workerName} 一時帰国削除 ${target.startDate}〜${target.endDate}`)

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Home leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
