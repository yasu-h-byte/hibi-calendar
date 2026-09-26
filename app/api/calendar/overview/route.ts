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
import { checkApiAuth, requireCap } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { loadCalendarMatrix, projectSignSites } from '@/lib/calendar-matrix'
import { summarizeSignStatus } from '@/lib/calendar-sign-status'
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
  // 2026-09-26: 権限表（lib/permissions.ts calendar.view）
  { const denied = await requireCap(request, 'calendar.view'); if (denied) return denied }

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

      // 署名状況は lib/calendar-sign-status.ts（就業カレンダー画面・ベルと同じ決まり・2026-09-26）。
      //   旧: 独自の数え方で、通知文の名前に「1つも署名していない人」しか入れず、
      //   一部の現場だけ署名した人（新しい現場の署名漏れ）が抜けていた
      const target = m.eligibleForeignWorkers.length
      const summary = summarizeSignStatus(projectSignSites(m))
      const fullySigned = approvedSiteIds.length > 0 ? summary.signedCount : 0
      const partial = summary.unsigned.filter(w => w.signed > 0).length
      const unsigned = Math.max(0, target - fullySigned - partial)
      // 通知文に載せる「まだ終わっていない人」＝未署名＋一部だけ署名（残りの現場が多い順）
      const unsignedNames = summary.unsigned.map(w => w.name)

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
