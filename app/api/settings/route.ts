import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return { ref: docRef, data: docSnap.data() }
}

// GET: return defaultRates from demmen/main
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ defaultRates: { tobiRate: 0, dokoRate: 0 } })
    }

    const defaultRates = (result.data.defaultRates as { tobiRate: number; dokoRate: number }) || { tobiRate: 0, dokoRate: 0 }
    return NextResponse.json({ defaultRates })
  } catch (error) {
    console.error('Settings GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'saveDefaultRates') {
      const { tobiRate, dokoRate } = body
      if (typeof tobiRate !== 'number' || typeof dokoRate !== 'number') {
        return NextResponse.json({ error: '単価は数値で入力してください' }, { status: 400 })
      }

      const docRef = doc(db, 'demmen', 'main')
      const docSnap = await getDoc(docRef)
      if (!docSnap.exists()) {
        return NextResponse.json({ error: 'No data found' }, { status: 404 })
      }

      const data = docSnap.data()
      await setDoc(docRef, { ...data, defaultRates: { tobiRate, dokoRate } })
      return NextResponse.json({ success: true })
    }

    if (action === 'backup') {
      const result = await getMainDoc()
      if (!result) {
        return NextResponse.json({ error: 'No data found' }, { status: 404 })
      }

      return NextResponse.json({ backup: result.data })
    }

    if (action === 'restore') {
      const { data } = body
      if (!data || typeof data !== 'object') {
        return NextResponse.json({ error: '有効なJSONデータが必要です' }, { status: 400 })
      }

      // Safety checks
      if (!data.workers && !data.sites) {
        return NextResponse.json({ error: 'workers または sites フィールドが見つかりません。有効なバックアップファイルか確認してください' }, { status: 400 })
      }

      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, data)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Settings POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
