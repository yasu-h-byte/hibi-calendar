import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getActivityLog } from '@/lib/activity'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
