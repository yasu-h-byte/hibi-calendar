import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser } from '@/lib/auth'
import { getAttendanceHistory, recordAttendanceChange } from '@/lib/attendance-history'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { setAttendanceEntry, computeAttendanceDeleteFields } from '@/lib/attendance'
import { logActivity } from '@/lib/activity'
import type { AttendanceEntry } from '@/types'

/**
 * 出面の変更履歴の閲覧と、誤削除・誤上書きからの復元。
 *
 * GET  ?ym=YYYYMM   … 直近の変更履歴（既定100件）
 * POST { id }       … その履歴の「変更前の内容」を書き戻す
 *
 * 認証: 管理者・事業責任者のみ（給与に直結するデータを書き戻すため）
 */
async function requireAdmin(request: NextRequest) {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const ok = auth.actor === 'admin' || auth.actor === 'super-admin' || auth.actor === 1
  if (!ok) return { error: NextResponse.json({ error: '管理者・事業責任者のみ実行できます' }, { status: 403 }) }
  return { actor: String(auth.actor) }
}

export async function GET(request: NextRequest) {
  const a = await requireAdmin(request)
  if (a.error) return a.error
  const ym = request.nextUrl.searchParams.get('ym') || undefined
  const items = await getAttendanceHistory({ ym, limitCount: 100 })
  return NextResponse.json({ items })
}

export async function POST(request: NextRequest) {
  const a = await requireAdmin(request)
  if (a.error) return a.error
  const { id } = (await request.json()) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const snap = await getDoc(doc(db, 'attendanceHistory', id))
  if (!snap.exists()) return NextResponse.json({ error: '履歴が見つかりません' }, { status: 404 })
  const h = snap.data() as {
    siteId: string; workerId: number; ym: string; day: number
    before: AttendanceEntry; key: string
  }

  // 締め済み月は復元しない（給与確定後のデータ変更を防ぐ既存ルールに合わせる）
  {
    const { checkMonthLocked } = await import('@/lib/locks')
    const lockErr = await checkMonthLocked(h.ym)
    if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
  }

  // 復元そのものも履歴に残す（復元の取り消しができるように）
  let current: AttendanceEntry | undefined
  try {
    const attSnap = await getDoc(doc(db, 'demmen', `att_${h.ym}`))
    const d = (attSnap.exists() ? (attSnap.data().d || {}) : {}) as Record<string, AttendanceEntry>
    current = d[h.key]
  } catch { /* 読めなくても復元は続行 */ }
  await recordAttendanceChange({
    siteId: h.siteId, workerId: h.workerId, ym: h.ym, day: h.day,
    before: current, after: h.before, actor: `${a.actor}(復元)`,
  })

  // 多現場重複ガード（2026-08-31 横展開）: 復元の間に別現場へ入力が移っていた場合、
  //   そのまま書き戻すと同日2現場の二重払いになる
  {
    const { detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
    const attDocR = await getAttendanceDoc(h.ym)
    const sitesAllR = ((await getDoc(doc(db, 'demmen', 'main'))).data()?.sites || []) as { id: string; name?: string }[]
    const conflictR = detectMultiSiteConflict(attDocR, h.siteId, h.workerId, h.ym, h.day, sitesAllR)
    if (conflictR) {
      const cName = sitesAllR.find(s2 => s2.id === conflictR.conflictSiteId)?.name || conflictR.conflictSiteId
      return NextResponse.json({
        error: `「${cName}」に同日の出面が既にあるため復元できません。先にそちらを確認・削除してください`,
      }, { status: 409 })
    }
  }

  // 書き戻し。残骸フィールドは computeAttendanceDeleteFields で掃除する
  await setAttendanceEntry(h.siteId, h.workerId, h.ym, h.day, h.before,
    { deleteFields: computeAttendanceDeleteFields(h.before) })

  await logActivity(a.actor!, 'attendance.restore',
    `${h.siteId}/wid:${h.workerId} ${h.ym}/${h.day} を変更前の内容に復元`)

  return NextResponse.json({ success: true, restored: h.before })
}
