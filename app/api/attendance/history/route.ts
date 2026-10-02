import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap, callerCan } from '@/lib/auth'
import { getAttendanceHistory } from '@/lib/attendance-history'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { getAttendanceDoc } from '@/lib/attendance'
import { getMainData } from '@/lib/compute'
import { dayApprovalOf, finalApprovedEditError, writeAttendanceEntry } from '@/lib/attendance-save'
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
    // その人の会社が締め済みなら拒否（2026-10-02 総合点検: 会社なしだと両社とも締めるまで復元できた）
    const { checkMonthLockedForWorkers } = await import('@/lib/locks')
    const lockErr = await checkMonthLockedForWorkers(h.ym, [h.workerId])
    if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
  }

  // 復元の前の中身（復元そのものも履歴に残し、取り消せるようにする）
  const attDocR = await getAttendanceDoc(h.ym)
  const current = attDocR[h.key] as AttendanceEntry | undefined
  const mainR = await getMainData()

  // 最終承認済みの日は、さかのぼり・最終承認の権限がある人（事業責任者・代表）だけ（2026-10-02 総合点検・出面の保存と同じ決まり）
  {
    const ap = await dayApprovalOf(mainR.sites, h.siteId, h.ym, h.day)
    const canEditFinal = (await callerCan(request, 'attendance.backfill')) || (await callerCan(request, 'attendance.finalApprove'))
    const finalErr = finalApprovedEditError(ap, canEditFinal)
    if (finalErr) return NextResponse.json({ error: finalErr }, { status: 409 })
  }

  // 多現場重複ガード（2026-08-31 横展開）: 復元の間に別現場へ入力が移っていた場合、
  //   そのまま書き戻すと同日2現場の二重払いになる
  //   2026-10-02 総合点検: 旧はこの確かめの前に履歴を書いていたので、断った復元が「復元した」として履歴に残っていた
  {
    const { detectMultiSiteConflict } = await import('@/lib/attendance')
    const conflictR = detectMultiSiteConflict(attDocR, h.siteId, h.workerId, h.ym, h.day, mainR.sites, h.before)
    if (conflictR) {
      const cName = mainR.sites.find(s2 => s2.id === conflictR.conflictSiteId)?.name || conflictR.conflictSiteId
      return NextResponse.json({
        error: `「${cName}」に同日の出面が既にあるため復元できません。先にそちらを確認・削除してください`,
      }, { status: 409 })
    }
  }

  // 書き戻し（共通の入口: 復元そのものを履歴に残す → 残骸の掃除つきで保存・lib/attendance-save.ts）
  await writeAttendanceEntry({
    siteId: h.siteId, workerId: h.workerId, ym: h.ym, day: h.day, entry: h.before, prevEntry: current ?? null, actor: `${a.actor}(復元)`,
  })

  await logActivity(a.actor!, 'attendance.restore',
    `${h.siteId}/wid:${h.workerId} ${h.ym}/${h.day} を変更前の内容に復元`)

  return NextResponse.json({ success: true, restored: h.before })
}
