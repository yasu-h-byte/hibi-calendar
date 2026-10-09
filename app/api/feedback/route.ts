/**
 * 困ったこと・要望（2026-10-09）。決まりは lib/feedback.ts。
 *
 * GET               → 一覧（代表は全部・それ以外は自分が書いたものだけ）。messages は返さず件数と最後の一言だけ
 * GET ?id=…         → 1件（画像は15分で切れる署名つきURLにして返す）
 * POST create       → 新しく書く { kind, page, title, text, images[] }
 * POST reply        → 返信 { id, text, images[] }
 * POST markRead     → 開いたら既読 { id }
 * POST setStatus    → 状態を変える { id, status }（代表だけ）
 *
 * 画像は画面で縮めた JPEG を data URL で受け取り、Storage `feedback/{id}/…` に置く（書類庫と同じバケット・非公開）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap, callerCan } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute'
import { getStaffDocsBucket, signedReadUrl } from '@/lib/storage-admin'
import {
  FEEDBACK_COL, FEEDBACK_LIMITS, feedbackTextError, unreadAfterPost, isFeedbackKind, isFeedbackStatus,
  type FeedbackThread, type FeedbackMessage, type FeedbackImage, type FeedbackAuthorKind,
} from '@/lib/feedback'

const OWNER_WORKER_ID = 0

async function caller(request: NextRequest): Promise<{ workerId: number; name: string; manage: boolean } | null> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return null
  const workerId = a.actor === 'super-admin' ? OWNER_WORKER_ID : Number(a.actor)
  const main = await getMainData()
  const w = (main.workers || []).find(x => x.id === workerId)
  const name = w?.name || (workerId === OWNER_WORKER_ID ? '日比靖仁' : `ID ${workerId}`)
  return { workerId, name, manage: await callerCan(request, 'feedback.manage') }
}

function canSee(t: FeedbackThread, me: { workerId: number; manage: boolean }): boolean {
  return me.manage || t.author.workerId === me.workerId
}

const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** data URL の画像を Storage に置く。だめなら理由を throw */
async function saveImages(threadId: string, images: unknown): Promise<FeedbackImage[]> {
  if (!Array.isArray(images) || images.length === 0) return []
  if (images.length > FEEDBACK_LIMITS.images) throw new Error(`画像は1回に${FEEDBACK_LIMITS.images}枚までです`)
  const bucket = getStaffDocsBucket()
  if (!bucket) throw new Error('画像の置き場所が使えません（しばらくしてからもう一度）')
  const out: FeedbackImage[] = []
  for (const [i, img] of images.entries()) {
    const dataUrl = typeof img?.dataUrl === 'string' ? img.dataUrl : ''
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) throw new Error('画像の形式が正しくありません（写真・スクリーンショットを選んでください）')
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > FEEDBACK_LIMITS.imageBytes) throw new Error('画像が大きすぎます')
    const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg'
    const path = `${FEEDBACK_COL}/${threadId}/${newId('img_')}_${i}.${ext}`
    await bucket.file(path).save(buf, { contentType: m[1], resumable: false })
    const name = typeof img?.name === 'string' && img.name.trim() ? img.name.trim().slice(0, 80) : `画像${i + 1}.${ext}`
    out.push({ path, name })
  }
  return out
}

async function withSignedUrls(t: FeedbackThread) {
  const sign = async (im: FeedbackImage) => {
    try { return { ...im, url: await signedReadUrl(im.path, im.name) } } catch { return { ...im, url: null } }
  }
  return {
    ...t,
    messages: await Promise.all((t.messages || []).map(async m => ({
      ...m,
      images: m.images ? await Promise.all(m.images.map(sign)) : undefined,
    }))),
  }
}

export async function GET(request: NextRequest) {
  { const denied = await requireCap(request, 'feedback.post'); if (denied) return denied }
  try {
    const me = await caller(request)
    if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const id = request.nextUrl.searchParams.get('id')
    if (id) {
      const snap = await getDoc(doc(db, FEEDBACK_COL, id))
      if (!snap.exists()) return NextResponse.json({ error: '見つかりません' }, { status: 404 })
      const t = { ...(snap.data() as FeedbackThread), id }
      if (!canSee(t, me)) return NextResponse.json({ error: '見られません' }, { status: 403 })
      return NextResponse.json({ thread: await withSignedUrls(t), me })
    }

    const snap = me.manage
      ? await getDocs(collection(db, FEEDBACK_COL))
      : await getDocs(query(collection(db, FEEDBACK_COL), where('author.workerId', '==', me.workerId)))
    const list = snap.docs.map(d => {
      const t = { ...(d.data() as FeedbackThread), id: d.id }
      const last = (t.messages || [])[t.messages.length - 1]
      return {
        id: t.id, createdAt: t.createdAt, updatedAt: t.updatedAt, author: t.author, kind: t.kind, page: t.page,
        title: t.title, status: t.status, unreadForAuthor: t.unreadForAuthor, unreadForOwner: t.unreadForOwner,
        count: (t.messages || []).length,
        last: last ? { by: last.by, text: (last.text || '').slice(0, 80), at: last.at } : null,
      }
    })
    return NextResponse.json({ list, me })
  } catch (e) {
    console.error('feedback GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  { const denied = await requireCap(request, 'feedback.post'); if (denied) return denied }
  try {
    const me = await caller(request)
    if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json()
    const { action } = body
    const now = new Date().toISOString()

    if (action === 'create') {
      const { kind, page, title, text, images } = body
      if (!isFeedbackKind(kind)) return NextResponse.json({ error: '種類を選んでください' }, { status: 400 })
      const err = feedbackTextError(text, Array.isArray(images) ? images.length : 0)
      if (err) return NextResponse.json({ error: err }, { status: 400 })
      const id = newId('fb_')
      const imgs = await saveImages(id, images)
      const t = String(title || '').trim().slice(0, FEEDBACK_LIMITS.title)
        || String(text || '').trim().split('\n')[0].slice(0, FEEDBACK_LIMITS.title) || '（画像）'
      const msg: FeedbackMessage = {
        id: newId('m_'), at: now, by: { kind: 'user', workerId: me.workerId, name: me.name },
        text: String(text || '').trim(), ...(imgs.length ? { images: imgs } : {}),
      }
      const thread: Omit<FeedbackThread, 'id'> = {
        createdAt: now, updatedAt: now, author: { workerId: me.workerId, name: me.name },
        kind, page: String(page || '').slice(0, 40), title: t, status: 'open', messages: [msg],
        ...unreadAfterPost('user', { authorIsManager: me.manage }),
      }
      await setDoc(doc(db, FEEDBACK_COL, id), thread)
      return NextResponse.json({ success: true, id })
    }

    const { id } = body
    if (!id || typeof id !== 'string') return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    const ref = doc(db, FEEDBACK_COL, id)
    const snap = await getDoc(ref)
    if (!snap.exists()) return NextResponse.json({ error: '見つかりません' }, { status: 404 })
    const t = { ...(snap.data() as FeedbackThread), id }
    if (!canSee(t, me)) return NextResponse.json({ error: '見られません' }, { status: 403 })

    if (action === 'reply') {
      const { text, images } = body
      const err = feedbackTextError(text, Array.isArray(images) ? images.length : 0)
      if (err) return NextResponse.json({ error: err }, { status: 400 })
      const imgs = await saveImages(id, images)
      // 書いた本人が返信したら user、代表が他の人の書き込みに返信したら owner
      const kind: FeedbackAuthorKind = t.author.workerId === me.workerId ? 'user' : 'owner'
      const msg: FeedbackMessage = {
        id: newId('m_'), at: now, by: { kind, workerId: me.workerId, name: me.name },
        text: String(text || '').trim(), ...(imgs.length ? { images: imgs } : {}),
      }
      // 終わったものに本人が書き足したら、受付に戻す（見落とさないように）
      const reopen = kind === 'user' && (t.status === 'done' || t.status === 'wontfix')
      await updateDoc(ref, {
        messages: [...(t.messages || []), msg],
        updatedAt: now,
        ...unreadAfterPost(kind, { authorIsManager: me.manage && t.author.workerId === me.workerId }),
        ...(reopen ? { status: 'open' } : {}),
      })
      return NextResponse.json({ success: true })
    }

    if (action === 'markRead') {
      // 開いた人の側の未読を消す。代表が自分の書き込みを開いたときは両方
      const mine = t.author.workerId === me.workerId
      const clear: Record<string, boolean> = {}
      if (mine && t.unreadForAuthor) clear.unreadForAuthor = false
      if (me.manage && t.unreadForOwner) clear.unreadForOwner = false
      if (Object.keys(clear).length) await updateDoc(ref, clear)
      return NextResponse.json({ success: true })
    }

    if (action === 'setStatus') {
      if (!me.manage) return NextResponse.json({ error: '状態を変えられるのは代表だけです' }, { status: 403 })
      const { status } = body
      if (!isFeedbackStatus(status)) return NextResponse.json({ error: '状態が正しくありません' }, { status: 400 })
      if (status !== t.status) {
        // 状態が変わったことも本人に知らせる（未読を付ける）
        await updateDoc(ref, { status, updatedAt: now, unreadForAuthor: t.author.workerId !== me.workerId })
      }
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (e) {
    console.error('feedback POST error:', e)
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg.length < 120 ? msg : 'Server error' }, { status: 500 })
  }
}
