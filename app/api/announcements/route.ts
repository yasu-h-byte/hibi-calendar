import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'

import { mergeAnnouncements, type Announcement } from '@/lib/release-notes'
import { resolveApiRoleFromMain } from '@/lib/attendance-authz'
import { permRoleOf } from '@/lib/permissions'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    const data = snap.exists() ? snap.data() : {}
    const announcements = (data.announcements || []) as Announcement[]
    // 管理者設定の一覧（投稿の編集・削除）は投稿したものだけ
    if (request.nextUrl.searchParams.get('scope') === 'posted') {
      return NextResponse.json({ announcements: [...announcements].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) })
    }
    // 投稿したお知らせ ＋ リリースノート（lib/release-notes.ts）を、その人の役割に合わせて新しい順に（2026-09-26）
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    const r = resolveApiRoleFromMain(await getApiAuthUser(request), { workers: data.workers || [], sites: data.sites || [], mforeman: data.mforeman || {} }, ym)
    return NextResponse.json({ announcements: mergeAnnouncements(announcements, permRoleOf(r ? { role: r.role } : null)) })
  } catch (error) {
    console.error('Announcements GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // 2026-09-26: お知らせの投稿は代表（lib/permissions.ts system.admin）
  const denied = await requireCap(request, 'system.admin')
  if (denied) return denied
  try {
    const body = await request.json()
    const { action } = body
    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      return NextResponse.json({ error: 'Data not found' }, { status: 404 })
    }
    const announcements = (snap.data().announcements || []) as Announcement[]

    if (action === 'add') {
      const { title, content, category, publishedBy } = body as Partial<Announcement>
      if (!title || !content || !category) {
        return NextResponse.json({ error: 'title, content, category は必須です' }, { status: 400 })
      }
      if (!['new', 'fix', 'info'].includes(category)) {
        return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
      }
      const newAnn: Announcement = {
        id: `ann_${Date.now()}`,
        title,
        content,
        category,
        publishedAt: new Date().toISOString(),
        publishedBy: publishedBy || '管理者',
      }
      announcements.push(newAnn)
      await updateDoc(docRef, { announcements })
      await logActivity('admin', 'announcement.add', `${title}`)
      return NextResponse.json({ success: true, announcement: newAnn })
    }

    if (action === 'update') {
      const { id, title, content, category } = body as Partial<Announcement> & { id: string }
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const idx = announcements.findIndex(a => a.id === id)
      if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const updated = { ...announcements[idx] }
      if (title !== undefined) updated.title = title
      if (content !== undefined) updated.content = content
      if (category !== undefined) {
        if (!['new', 'fix', 'info'].includes(category)) {
          return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
        }
        updated.category = category
      }
      announcements[idx] = updated
      await updateDoc(docRef, { announcements })
      await logActivity('admin', 'announcement.update', `${updated.title}`)
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const target = announcements.find(a => a.id === id)
      const filtered = announcements.filter(a => a.id !== id)
      if (filtered.length === announcements.length) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      await updateDoc(docRef, { announcements: filtered })
      await logActivity('admin', 'announcement.delete', target?.title || id)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Announcements POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
