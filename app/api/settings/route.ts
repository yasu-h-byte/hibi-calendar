import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return { ref: docRef, data: docSnap.data() }
}

// GET: return defaultRates from demmen/main
export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const action = request.nextUrl.searchParams.get('action')
    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ defaultRates: { tobiRate: 0, dokoRate: 0 } })
    }

    if (action === 'getPermissions') {
      const rolePermissions = (result.data.rolePermissions as Record<string, string[]>) || {}
      return NextResponse.json({ rolePermissions })
    }

    if (action === 'getUserPasswords') {
      const userPasswords = (result.data.userPasswords as Record<string, string>) || {}
      return NextResponse.json({ userPasswords })
    }

    const defaultRates = (result.data.defaultRates as { tobiRate: number; dokoRate: number }) || { tobiRate: 0, dokoRate: 0 }
    return NextResponse.json({ defaultRates })
  } catch (error) {
    console.error('Settings GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'savePermissions') {
      const { rolePermissions } = body
      if (!rolePermissions || typeof rolePermissions !== 'object') {
        return NextResponse.json({ error: 'rolePermissions required' }, { status: 400 })
      }
      const docRef = doc(db, 'demmen', 'main')
      const { updateDoc } = await import('firebase/firestore')
      await updateDoc(docRef, { rolePermissions })
      return NextResponse.json({ success: true })
    }

    if (action === 'saveUserPasswords') {
      const { userPasswords } = body
      if (!userPasswords || typeof userPasswords !== 'object') {
        return NextResponse.json({ error: 'userPasswords required' }, { status: 400 })
      }
      const docRef = doc(db, 'demmen', 'main')
      const { updateDoc } = await import('firebase/firestore')
      await updateDoc(docRef, { userPasswords })
      await logActivity('admin', 'settings.userPasswords', '個人パスワードを更新')
      return NextResponse.json({ success: true })
    }

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
      const oldRates = (data.defaultRates as { tobiRate: number; dokoRate: number }) || { tobiRate: 0, dokoRate: 0 }
      await setDoc(docRef, { ...data, defaultRates: { tobiRate, dokoRate } })
      await logActivity('admin', 'rates.default', `鳶 ¥${oldRates.tobiRate}→¥${tobiRate}, 土工 ¥${oldRates.dokoRate}→¥${dokoRate}`)
      return NextResponse.json({ success: true })
    }

    if (action === 'backup') {
      const result = await getMainDoc()
      if (!result) {
        return NextResponse.json({ error: 'No data found' }, { status: 404 })
      }

      // Also export all att_YYYYMM documents (attendance data)
      const attDocs: Record<string, Record<string, unknown>> = {}
      const colRef = collection(db, 'demmen')
      const colSnap = await getDocs(colRef)
      for (const docSnap of colSnap.docs) {
        if (docSnap.id.startsWith('att_')) {
          attDocs[docSnap.id] = docSnap.data()
        }
      }

      return NextResponse.json({
        backup: {
          ...result.data,
          _attDocs: attDocs,
        },
      })
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

      // Separate attendance docs from main data
      const attDocs = (data._attDocs || {}) as Record<string, Record<string, unknown>>
      const mainData = { ...data }
      delete mainData._attDocs

      // Restore main document
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, mainData)

      // Restore attendance documents
      for (const [attDocId, attDocData] of Object.entries(attDocs)) {
        if (attDocId.startsWith('att_') && attDocData && typeof attDocData === 'object') {
          const attDocRef = doc(db, 'demmen', attDocId)
          await setDoc(attDocRef, attDocData)
        }
      }

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Settings POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
