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
import { computePeriodUsed, judgeFiveDayObligation } from '@/lib/leave-compute'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const main = await getMainData()

    // 当月 (今日の年月) を計算
    const now = new Date()
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const todayIso = now.toISOString().slice(0, 10)

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
    let calendarPendingCount = 0
    try {
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const nextYm = `${nextMonth.getFullYear()}${String(nextMonth.getMonth() + 1).padStart(2, '0')}`
      // calendar 承認状況を Firestore から確認: demmen/calendar_approvals/{nextYm}_{siteId}
      // 単純化: siteWorkDays[nextYm] が未設定なら承認待ちと判定
      const nextSiteWorkDays = main.siteWorkDays?.[nextYm] || {}
      const activeSites = (main.sites || []).filter(s => !s.archived && s.end >= `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`)
      calendarPendingCount = activeSites.filter(s => !nextSiteWorkDays[s.id]).length
    } catch (e) {
      console.warn('[sidebar-badges] calendar check failed:', e)
    }

    // ── 休暇管理: 年5日義務 未達 + 期限切れ間近 ──
    let leaveAlertCount = 0
    try {
      // 全 plData を読む
      const plSnap = await getDoc(doc(db, 'demmen', 'main'))
      const plData = plSnap.exists() ? ((plSnap.data().plData || {}) as Record<string, Array<Record<string, unknown>>>) : {}
      // 全期間 att (90日以内)
      const sevenDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      const checkYms = new Set<string>()
      for (let d = sevenDaysAgo; d <= now; d.setMonth(d.getMonth() + 1)) {
        checkYms.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      const attCombined: Record<string, unknown> = {}
      for (const ymKey of checkYms) {
        try {
          const a = await getAttData(ymKey)
          Object.assign(attCombined, a.d)
        } catch { /* skip */ }
      }
      const alertedIds = new Set<number>()
      for (const w of main.workers) {
        if (w.retired && w.retired < todayIso) continue
        const records = plData[String(w.id)] || []
        for (const r of records) {
          if (r._archived) continue
          const grantDate = r.grantDate as string | undefined
          const grantDays = (r.grantDays as number | undefined) ?? 0
          if (!grantDate || grantDays < 10) continue
          // 当該レコードが当期内ならチェック
          const { requestedPeriodUsed } = computePeriodUsed(w.id, grantDate, attCombined as Record<string, unknown>, todayIso)
          const judge = judgeFiveDayObligation(grantDate, grantDays, requestedPeriodUsed, w.retired, todayIso)
          if (judge.warning) alertedIds.add(w.id)
        }
      }
      leaveAlertCount = alertedIds.size
    } catch (e) {
      console.warn('[sidebar-badges] leave check failed:', e)
    }

    return NextResponse.json({
      ym,
      generatedAt: now.toISOString(),
      badges: {
        monthly: monthlyAnomalyCount,    // 月次集計: 検算違反スタッフ数
        calendar: calendarPendingCount,  // カレンダー: 未承認サイト数
        leave: leaveAlertCount,           // 休暇管理: 年5日義務アラート数
      },
    })
  } catch (error) {
    console.error('Sidebar badges API error:', error)
    return NextResponse.json({ error: 'Failed to compute badges' }, { status: 500 })
  }
}
