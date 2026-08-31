import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, getForemanSite } from '@/lib/attendance'
import { getLeaveBalance } from '@/lib/leave-balance'
import { judgeFiveDayObligation } from '@/lib/leave-compute'
import { addMonthsSafe, todayJstIso } from '@/lib/date-utils'
import { recordAccess, getRequestIp } from '@/lib/accessLog'

/**
 * 日本人スタッフのマイページ用データ（2026-08-28 追加）
 *
 * 日本人は出面を職長が記録するため、本人のスマホは「有給の残数と申請」「道具代の残額」
 * だけを見る。出面入力を持たないぶん、ベトナム人向けの /attendance/[token] とは
 * 別ページ（/mypage/[token]）にしている。
 *
 * 道具代の内訳と有給申請の一覧は既存 API（/api/tool-budget?token=・
 * /api/leave-request?token=）をそのまま使う。ここは重複させない。
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })

  try {
    const worker = await getWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    recordAccess({
      workerId: worker.id,
      workerName: worker.name,
      role: 'staff',
      org: worker.company === 'HFU' ? 'hfu' : 'hibi',
      ip: getRequestIp(request),
    }).catch(() => {})

    const today = todayJstIso()
    const [balance, sites, foremanSite] = await Promise.all([
      getLeaveBalance(worker.id, today),
      getStaffSites(worker.id),
      getForemanSite(worker.id),
    ])

    // 年5日取得義務（労基法39条7項）。本人にも「あと何日取る必要があるか」を見せる
    let fiveDayShortfall = 0
    let periodEnd = ''
    if (!balance.noGrant && balance.grantDate) {
      periodEnd = addMonthsSafe(balance.grantDate, 12)
      // 義務判定は「実際に取得した有給日数」で行う（used は買取・調整を含むため使わない）
      const judge = judgeFiveDayObligation(
        balance.grantDate,
        balance.total,
        balance.periodUsed ?? 0,
        worker.retired,
        today,
      )
      fiveDayShortfall = judge.shortfall
    }

    return NextResponse.json({
      worker: {
        id: worker.id,
        name: worker.name,
        jobType: worker.jobType || '',
      },
      today,
      leave: {
        noGrant: balance.noGrant ?? false,
        grantDate: balance.grantDate,
        periodEnd,
        total: balance.total,
        used: balance.used,
        remaining: balance.remaining,
        fiveDayShortfall,
      },
      sites,
      // 職長は出面確認の画面も持っているので、そこへ戻るリンクを出す
      foreman: foremanSite ? { siteId: foremanSite.id, siteName: foremanSite.name } : null,
    })
  } catch (e) {
    console.error('mypage GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
