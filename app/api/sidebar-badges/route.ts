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
import { siteNeedsCalendar } from '@/lib/site-hierarchy'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'

export async function GET(request: NextRequest) {
  // auth: any-login — メニューの件数バッジ（件数のみ）
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const main = await getMainData()

    // 当月 (今日の年月) を JST で計算（旧: UTC の new Date で JST 0〜9時に前月扱い 2026-08-27）
    const { todayJstIso } = await import('@/lib/date-utils')
    const todayIsoB = todayJstIso()
    const ym = todayIsoB.slice(0, 7).replace('-', '')
    const now = new Date(todayIsoB + 'T00:00:00')  // 以降の日付演算も JST 当日基準

    // ── 月次集計: 検算違反スタッフ数 ──
    //   数える月は月次集計の画面が開く月と同じ（前月がまだ締まっていなければ前月、両社とも締めていれば当月）。
    //   2026-10-02 点検: 旧は常に当月で数え、締める前月の異常がバッジに出なかった（月初は数日分の誤警報も出た）
    let monthlyAnomalyCount = 0
    try {
      const { isMonthLockedInLocks } = await import('@/lib/locks')
      const { addMonthsSafe } = await import('@/lib/date-utils')
      const prevYm = addMonthsSafe(todayIsoB, -1).slice(0, 7).replace('-', '')
      const prevClosed = isMonthLockedInLocks(main.locks, prevYm, 'hibi') && isMonthLockedInLocks(main.locks, prevYm, 'hfu')
      const checkYm = prevClosed ? ym : prevYm
      const att = await getAttData(checkYm)
      const prescribedDays = main.workDays[checkYm] || 0
      const siteWorkDaysMap = main.siteWorkDays?.[checkYm] || {}
      const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
      const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
      // 2026-08-27 修正（給与総点検）: /api/monthly と同じ引数（カレンダー・帰国情報）で
      //   計算しないと、境界月でバッジ件数と月次画面のバナー件数が食い違う
      const { getMonthlyCalendars } = await import('@/lib/repositories/calendarRepo')
      const { getAllActiveHomeLeaves } = await import('@/lib/homeLeave')
      const cals = await getMonthlyCalendars(`${checkYm.slice(0, 4)}-${checkYm.slice(4, 6)}` as Parameters<typeof getMonthlyCalendars>[0])
      const calendarDaysMap: Record<string, Record<string, string>> = {}
      for (const c of cals) if (c.days) calendarDaysMap[c.siteId] = c.days
      const homeLeaves = await getAllActiveHomeLeaves()
      const result = computeMonthly(main, att.d, att.sd, checkYm, prescribedDays, hasCalendarData ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves)
      const validation = validatePayrolls(result.workers as unknown as PayrollSnapshot[])
      // 「確認した」が付いた注意点は数えない（2026-10-05・lib/pay-note-ack.ts。確認の記録は60秒キャッシュ）
      const { summarizeOpenIssues } = await import('@/lib/pay-note-ack')
      const { loadPayNoteAcks } = await import('@/lib/pay-note-ack-server')
      const acks = validation.total > 0 ? await loadPayNoteAcks(checkYm).catch(() => []) : []
      monthlyAnomalyCount = summarizeOpenIssues(validation.issues, acks).affectedWorkerIds.length
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
      // 予告は 18日から（= 25日の期限の1週間前・lib/calendar.ts CALENDAR_REMIND_FROM_DAY）
      const { CALENDAR_REMIND_FROM_DAY } = await import('@/lib/calendar')
      if (todayDay >= CALENDAR_REMIND_FROM_DAY) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        const nextYm = `${nextMonth.getFullYear()}${String(nextMonth.getMonth() + 1).padStart(2, '0')}`
        const nextSiteWorkDays = main.siteWorkDays?.[nextYm] || {}
        const activeSites = (main.sites || []).filter(s => !s.archived && !(s as { parentId?: string }).parentId && siteNeedsCalendar(s as never, nextYm) && s.end >= `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`)
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

    // ── 困ったこと・要望: 自分あての未読（2026-10-09）。代表は代表がまだ読んでいない書き込み、ほかの人は自分の書き込みへの返信 ──
    let feedbackUnread = 0
    try {
      const { getApiAuthUser, callerCan } = await import('@/lib/auth')
      const a = await getApiAuthUser(request)
      if (a.authorized && await callerCan(request, 'feedback.post')) {
        const { db } = await import('@/lib/firebase')
        const { collection, getDocs, query, where } = await import('@/lib/fsdb')
        const { FEEDBACK_COL } = await import('@/lib/feedback')
        if (await callerCan(request, 'feedback.manage')) {
          feedbackUnread = (await getDocs(query(collection(db, FEEDBACK_COL), where('unreadForOwner', '==', true)))).size
        } else {
          const me = a.actor === 'super-admin' ? 0 : Number(a.actor)
          const snap = await getDocs(query(collection(db, FEEDBACK_COL), where('author.workerId', '==', me)))
          feedbackUnread = snap.docs.filter(d => d.data().unreadForAuthor === true).length
        }
      }
    } catch (e) {
      console.warn('[sidebar-badges] feedback count failed:', e)
    }

    return NextResponse.json({
      ym,
      generatedAt: now.toISOString(),
      badges: {
        monthly: monthlyAnomalyCount,    // 月次集計: 検算違反スタッフ数
        calendar: calendarPendingCount,  // カレンダー: 未承認サイト数 (18日以降のみ)
        leave: leaveAlertCount,           // 休暇管理: 常に 0 (アラート不要方針)
        feedback: feedbackUnread,         // 困ったこと・要望: 自分あての未読
      },
    })
  } catch (error) {
    console.error('Sidebar badges API error:', error)
    return NextResponse.json({ error: 'Failed to compute badges' }, { status: 500 })
  }
}
