/**
 * GET /api/calendar/overview?back=2&fwd=1
 *
 * 月またぎのカレンダー運用状況サマリー（管理者ダッシュボード用・2026-06 追加）。
 * 「どの月・どの状態か（未作成/提出/承認/未署名）」を一望し、取りこぼしを防ぐ。
 *
 * 各月について:
 *   - sites: 現場カレンダーの状態内訳（total/approved/submitted/draft/rejected）
 *   - workers: 署名対象スタッフ数と「全現場署名完了/一部/未署名」の内訳
 *     （/calendar の署名状況パネルと同じ all-workers × all-sites + 再確認考慮ロジック）
 *   - complete: 全現場承認済み かつ 全対象者が署名完了
 */
import { checkApiAuth } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'
import { ym7 } from '@/lib/ym'

export const dynamic = 'force-dynamic'

function jstNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
}

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = parseInt(v ?? '', 10)
  if (isNaN(n)) return def
  return Math.max(min, Math.min(max, n))
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const sp = request.nextUrl.searchParams
    const back = clampInt(sp.get('back'), 2, 0, 12)
    const fwd = clampInt(sp.get('fwd'), 1, 0, 6)

    const now = jstNow()
    const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const dayOfMonth = now.getDate()

    // 対象月リスト（古い順）
    const months: string[] = []
    for (let i = -back; i <= fwd; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }

    const result = []
    for (const ymDash of months) {
      const m = await loadCalendarMatrix(ymDash)

      // 現場の状態内訳
      const siteCounts = { total: 0, approved: 0, submitted: 0, draft: 0, rejected: 0 }
      const approvedSiteIds: string[] = []
      for (const sw of m.sitesWithWorkers) {
        const cal = m.siteCalendars[sw.site.id]
        siteCounts.total++
        const st = cal?.status || 'draft'
        if (st === 'approved') { siteCounts.approved++; approvedSiteIds.push(sw.site.id) }
        else if (st === 'submitted') siteCounts.submitted++
        else if (st === 'rejected') siteCounts.rejected++
        else siteCounts.draft++
      }

      // 署名状況（/calendar 署名状況パネルと同じ判定: 修正後の再確認未済は未完了扱い）
      const target = m.eligibleForeignWorkers.length
      let fullySigned = 0, partial = 0
      const unsignedNames: string[] = []
      for (const w of m.eligibleForeignWorkers) {
        let signedCount = 0
        for (const siteId of approvedSiteIds) {
          const sigVal = m.signaturesBySite[`${w.id}_${siteId}`]
          const signed = !!sigVal
          const signedAt = sigVal && sigVal !== 'true' ? sigVal : null
          const cal = m.siteCalendars[siteId]
          const wasRevised = !!(cal?.status === 'approved' && cal.approvedAt && cal.updatedAt && cal.updatedAt > cal.approvedAt)
          const assignedHere = m.assignedWorkerIdsBySite[siteId]?.has(w.id) || false
          const reconfirmed = !!(wasRevised && signed && signedAt && cal!.updatedAt && signedAt > cal!.updatedAt)
          const effectivelySigned = signed && !(wasRevised && assignedHere && !reconfirmed)
          if (effectivelySigned) signedCount++
        }
        if (approvedSiteIds.length > 0 && signedCount === approvedSiteIds.length) fullySigned++
        else if (signedCount > 0) partial++
        else { if (approvedSiteIds.length > 0) unsignedNames.push(w.name) }
      }
      const unsigned = Math.max(0, target - fullySigned - partial)

      const complete = siteCounts.total > 0 && siteCounts.approved === siteCounts.total && fullySigned === target && target > 0

      // 「翌月が締切間際なのに未完了」= 要対応エスカレーション
      const isFuture = ymDash > curYm
      const isNext = ymDash > curYm && (() => {
        const d = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        return ymDash === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      })()
      const atRisk = isNext && !complete && dayOfMonth >= 20

      result.push({
        ym: ymDash,
        ymCompact: ym7(ymDash).replace('-', ''),
        isCurrent: ymDash === curYm,
        isFuture,
        sites: siteCounts,
        workers: { target, fullySigned, partial, unsigned },
        complete,
        atRisk,
        unsignedNames: unsignedNames.slice(0, 30),
      })
    }

    return NextResponse.json({ curYm, dayOfMonth, months: result })
  } catch (error) {
    console.error('overview error:', error)
    return NextResponse.json({ error: 'Failed to build overview' }, { status: 500 })
  }
}
