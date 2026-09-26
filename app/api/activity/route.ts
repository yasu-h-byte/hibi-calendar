import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, requireCap } from '@/lib/auth'
import { getActivityLog } from '@/lib/activity'

export async function GET(request: NextRequest) {
  // 2026-09-26: アクセス履歴・操作記録は代表（lib/permissions.ts system.admin）
  const denied = await requireCap(request, 'system.admin')
  if (denied) return denied

  try {
    const { searchParams } = request.nextUrl
    const startDate = searchParams.get('startDate') || undefined
    const endDate = searchParams.get('endDate') || undefined
    const userId = searchParams.get('userId') || undefined
    const action = searchParams.get('action') || undefined

    const entries = await getActivityLog({
      startDate,
      endDate,
      userId,
      action,
      limitCount: 200,
    })

    return NextResponse.json({ entries })
  } catch (error) {
    console.error('Activity API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
