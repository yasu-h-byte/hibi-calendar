import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

interface Announcement {
  id: string
  title: string
  content: string
  category: 'new' | 'fix' | 'info'
  publishedAt: string
  publishedBy: string
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    const data = snap.exists() ? snap.data() : {}
    const announcements = (data.announcements || []) as Announcement[]
    // publishedAt の降順でソート
    const sorted = [...announcements].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    return NextResponse.json({ announcements: sorted })
  } catch (error) {
    console.error('Announcements GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
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
