import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap } from '@/lib/auth'
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
 * 認証: lib/permissions.ts の attendance.history（事務・事業責任者・代表）
 */
async function requireAdmin(request: NextRequest) {
  // 2026-09-26: 権限表の attendance.history（事務・事業責任者・代表）。事務は誤操作の復元を担当（manual-morita §3-1）
  const denied = await requireCap(request, 'attendance.history')
  if (denied) return { error: denied }
  const auth = await getApiAuthUser(request)
  return { actor: auth.authorized ? String(auth.actor) : 'unknown' }
}

export async function GET(request: NextRequest) {
  // auth: requireAdmin() の中で attendance.history
  const a = await requireAdmin(request)
  if (a.error) return a.error
  const ym = request.nextUrl.searchParams.get('ym') || undefined
  const items = await getAttendanceHistory({ ym, limitCount: 100 })
  return NextResponse.json({ items })
}

export async function POST(request: NextRequest) {
  // auth: requireAdmin() の中で attendance.history
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
    const conflictR = detectMultiSiteConflict(attDocR, h.siteId, h.workerId, h.ym, h.day, sitesAllR, h.before)
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
