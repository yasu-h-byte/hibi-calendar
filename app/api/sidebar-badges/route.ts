/**
 * サイドバー未対応件数バッジ用 集約 API (2026-06-XX 追加)
 *
 * 各メニュー項目の横に「●N」バッジを表示するためのカウントを集約して返す。
 * - 出面入力: 当月の未入力スタッフ数 (簡易版: なし。重いので除外)
 * - カレンダー: 未承認の月数
 * - 月次集計: 自動検算で違反のあるスタッフ数 (当月)
 * - 休暇管理: 5日義務未達 + 期限切れ間近の合計
 *
 * パフォーマンス重視: 各メニューのカウントを最小コストで集める。
 * クライアント側で 5分キャッシュする想定。
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const main = await getMainData()

    // 当月 (今日の年月) を計算
    const now = new Date()
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`

    // ── 月次集計: 検算違反スタッフ数 ──
    let monthlyAnomalyCount = 0
    try {
      const att = await getAttData(ym)
      const prescribedDays = main.workDays[ym] || 0
      const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
      const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
      const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
      const result = computeMonthly(main, att.d, att.sd, ym, prescribedDays, hasCalendarData ? siteWorkDaysMap : undefined, baseDays)
      const validation = validatePayrolls(result.workers as unknown as PayrollSnapshot[])
      monthlyAnomalyCount = validation.affectedWorkerIds.length
    } catch (e) {
      console.warn('[sidebar-badges] monthly check failed:', e)
    }

    // ── カレンダー: 未承認の月数 (来月のみチェック) ──
    // 2026-06-XX 修正 (運用方針): 翌月分の確定は前月25日以降。
    //   アラートは確定期限の 1週間前 = 18日 以降のみ表示。
    //   それ以前は「まだ確定タイミングではない」ので静かに。
    let calendarPendingCount = 0
    try {
      const todayDay = now.getDate()
      // 18日以降のみアラート (= 25日確定の1週間前)
      if (todayDay >= 18) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        const nextYm = `${nextMonth.getFullYear()}${String(nextMonth.getMonth() + 1).padStart(2, '0')}`
        const nextSiteWorkDays = main.siteWorkDays?.[nextYm] || {}
        const activeSites = (main.sites || []).filter(s => !s.archived && s.end >= `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`)
        calendarPendingCount = activeSites.filter(s => !nextSiteWorkDays[s.id]).length
      }
    } catch (e) {
      console.warn('[sidebar-badges] calendar check failed:', e)
    }

    // ── 休暇管理: 年5日義務 ──
    // 2026-06-XX 修正 (運用方針): 年5日義務のアラートは不要 (常に 0)。
    //   理由: 靖仁さん判断。/leave ページ内では引き続き状況を表示するが、
    //         サイドバーやダッシュボードでの cross-page アラートはノイズになる
    //         ため出さない方針。
    //   関連監査 finding #17 はこの方針に基づき却下扱い。
    const leaveAlertCount = 0
    // (旧実装: 全 plData を読んで judgeFiveDayObligation で集計していた処理は
    //  上記方針により削除。/leave ページ内の表示は別途存続)

    return NextResponse.json({
      ym,
      generatedAt: now.toISOString(),
      badges: {
        monthly: monthlyAnomalyCount,    // 月次集計: 検算違反スタッフ数
        calendar: calendarPendingCount,  // カレンダー: 未承認サイト数 (18日以降のみ)
        leave: leaveAlertCount,           // 休暇管理: 常に 0 (アラート不要方針)
      },
    })
  } catch (error) {
    console.error('Sidebar badges API error:', error)
    return NextResponse.json({ error: 'Failed to compute badges' }, { status: 500 })
  }
}
