import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { ym, locked, org } = await request.json()
    if (!ym) {
      return NextResponse.json({ error: 'ym required' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', 'main')

    if (org === 'hibi' || org === 'hfu') {
      // 組織別ロック: locks["202603_hibi"] = true
      const lockKey = `${ym}_${org}`
      await updateDoc(docRef, { [`locks.${lockKey}`]: locked ? true : false })
      const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} ${orgLabel}を${locked ? '締め' : '締め解除'}`)
    } else {
      // 後方互換: org未指定の場合は全体ロック（旧方式）
      await updateDoc(docRef, { [`locks.${ym}`]: locked ? true : false })
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} を${locked ? '締め' : '締め解除'}`)
    }

    return NextResponse.json({ success: true, locked: !!locked })
  } catch (error) {
    console.error('Lock POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
