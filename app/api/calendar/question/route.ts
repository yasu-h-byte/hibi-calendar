/**
 * カレンダーに対する労働者の「質問・異議」窓口（2026-06 追加）
 *
 * これまで承認は「同意する」一択で、労働者が疑問や異議を出す手段が無かった。
 * 真の「同意」には、確認したうえで質問・相談できる経路が必要。
 *
 * - POST（token認証）: 労働者が質問/異議を送信 → calendarQuestions に保存
 * - POST（管理者・body.resolve）: 管理者が「解決済み」に更新
 * - GET（管理者）: 当月の質問一覧を取得
 */
import { checkApiAuth } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, where, doc, updateDoc } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // 管理者: 解決済みにする
    if (body.resolve && body.id) {
      if (!await checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      await updateDoc(doc(db, 'calendarQuestions', body.id), {
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolvedBy: body.resolvedBy ?? null,
      })
      return NextResponse.json({ success: true })
    }

    // 労働者: 質問/異議を送信（token 認証）
    const { token, ym, message, kind, siteId } = body
    if (!token || !ym || !message || !String(message).trim()) {
      return NextResponse.json({ error: 'token, ym, message required' }, { status: 400 })
    }
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
    await addDoc(collection(db, 'calendarQuestions'), {
      workerId: worker.id,
      workerName: worker.name,
      ym,
      siteId: siteId || null,
      kind: kind === 'objection' ? 'objection' : 'question',
      message: String(message).trim().slice(0, 1000),
      resolved: false,
      createdAt: new Date().toISOString(),
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('calendar question error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const ym = request.nextUrl.searchParams.get('ym')
  if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })
  try {
    const qs = await getDocs(query(collection(db, 'calendarQuestions'), where('ym', '==', ym)))
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) })) as Array<{ id: string; resolved?: boolean; createdAt?: string }>
    // 未解決を先頭・新しい順
    items.sort((a, b) => {
      const ar = a.resolved ? 1 : 0, br = b.resolved ? 1 : 0
      if (ar !== br) return ar - br
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    })
    return NextResponse.json({ items })
  } catch (error) {
    console.error('calendar question list error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
