import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  // 2026-06-12 (監査 Sprint2-B): 操作者を識別して記録。
  //   旧: checkApiAuth + 'admin' 固定名義 → 誰が締め/解除したか追跡不能で、
  //   「締め→こっそり解除→改竄→再締め」が無痕跡で可能だった
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const actorLabel = auth.actor === 'super-admin' ? 'super-admin'
    : auth.actor === 'admin' ? 'admin(共通PW)'
    : `workerId=${auth.actor}`

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
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} ${orgLabel}を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    } else {
      // 後方互換: org未指定の場合は全体ロック（旧方式）
      await updateDoc(docRef, { [`locks.${ym}`]: locked ? true : false })
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    }

    return NextResponse.json({ success: true, locked: !!locked })
  } catch (error) {
    console.error('Lock POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
