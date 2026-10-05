import { NextRequest, NextResponse } from 'next/server'
import { requireCap, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, deleteDoc } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import { payNoteAckId, type PayNoteAck } from '@/lib/pay-note-ack'
import { loadPayNoteAcks, invalidatePayNoteAcks } from '@/lib/pay-note-ack-server'

export const dynamic = 'force-dynamic'

/**
 * 給与チェックの注意点を「確認した」と残す・取り消す（2026-10-05 代表依頼）。決まりは lib/pay-note-ack.ts。
 *   GET  ?ym=YYYYMM            その月の確認の一覧（月次集計を見られる人）
 *   POST {action:'ack', ym, workerId, code, message, note?}   確認する（締めができる人＝monthly.close）
 *   POST {action:'unack', ym, workerId, code}                  確認を取り消す（同上）
 * 確認できるのは注意点（warning）だけ。文面（message）を一緒に残し、あとで文面が変わったら未確認に戻る（判定は読む側）。
 */
export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'monthly.view')
  if (denied) return denied
  const ym = request.nextUrl.searchParams.get('ym') || ''
  if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym required' }, { status: 400 })
  try {
    return NextResponse.json({ ym, acks: await loadPayNoteAcks(ym, { fresh: true }) })
  } catch (e) {
    console.error('monthly/note-ack GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireCap(request, 'monthly.close')
  if (denied) return denied
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action || '')
    const ym = String(body.ym || '')
    const workerId = Number(body.workerId)
    const code = String(body.code || '')
    if (!/^\d{6}$/.test(ym) || !Number.isFinite(workerId) || !/^[A-Za-z0-9_]{1,60}$/.test(code)) {
      return NextResponse.json({ error: '月・人・注意点の指定が正しくありません' }, { status: 400 })
    }
    const auth = await getApiAuthUser(request)
    const main = await getMainData()
    const by = !auth.authorized ? 'unknown' : String(auth.actor)
    const byName = !auth.authorized ? 'unknown'
      : auth.actor === 'super-admin' ? '代表'
      : (main.workers.find(w => w.id === auth.actor)?.name || `ID${auth.actor}`)
    const workerName = main.workers.find(w => w.id === workerId)?.name || `ID${workerId}`
    const ref = doc(db, 'payNoteAcks', payNoteAckId(ym, workerId, code))

    if (action === 'ack') {
      const message = String(body.message || '').slice(0, 2000)
      if (!message) return NextResponse.json({ error: '確認する注意点の文面がありません。画面を読み込み直してください' }, { status: 400 })
      const note = String(body.note ?? '').trim().slice(0, 500)
      const ack: PayNoteAck = { ym, workerId, code, message, by, byName, at: new Date().toISOString(), ...(note ? { note } : {}) }
      // 1件まるごと置き換える（前の確認のメモを残さない）
      await setDoc(ref, ack)
      invalidatePayNoteAcks(ym)
      try { await logActivity('admin', 'monthly.noteAck', `${ym} ${workerName} の注意点（${code}）を確認済みに（${byName}）${note ? `: ${note}` : ''}`) } catch { /* ログ失敗は本体に影響させない */ }
      return NextResponse.json({ success: true, ack })
    }
    if (action === 'unack') {
      const snap = await getDoc(ref)
      if (!snap.exists()) return NextResponse.json({ success: true })
      await deleteDoc(ref)
      invalidatePayNoteAcks(ym)
      try { await logActivity('admin', 'monthly.noteAck.cancel', `${ym} ${workerName} の注意点（${code}）の確認を取り消し（${byName}）`) } catch { /* 同上 */ }
      return NextResponse.json({ success: true })
    }
    return NextResponse.json({ error: 'action が正しくありません' }, { status: 400 })
  } catch (e) {
    console.error('monthly/note-ack POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
