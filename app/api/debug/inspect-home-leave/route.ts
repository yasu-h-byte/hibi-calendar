import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'

/**
 * デバッグ用: 帰国情報のソース2つを生で返す
 * - main.homeLeaves 配列
 * - homeLongLeave コレクション
 *
 * 使い方:
 *   GET /api/debug/inspect-home-leave?password=<管理者パスワード>
 */
export async function GET(request: NextRequest) {
  // クエリでもヘッダでも認証可能
  const passwordFromQuery = request.nextUrl.searchParams.get('password')
  if (passwordFromQuery) {
    const headers = new Headers(request.headers)
    headers.set('x-admin-password', passwordFromQuery)
    const authReq = new NextRequest(request.url, { headers, method: request.method })
    if (!(await checkApiAuth(authReq))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else if (!(await checkApiAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 今日の日付
  const now = new Date()
  const todayDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  // ① main.homeLeaves
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const mainData = mainSnap.exists() ? mainSnap.data() : {}
  const mainHomeLeaves = (mainData.homeLeaves || []) as { id?: string; workerId: number; workerName?: string; startDate: string; endDate: string }[]

  // ② homeLongLeave コレクション
  const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
  const hlList: { docId: string; workerId?: number; workerName?: string; startDate?: string; endDate?: string; status?: string }[] = []
  hlSnap.forEach(d => {
    const v = d.data()
    hlList.push({
      docId: d.id,
      workerId: v.workerId,
      workerName: v.workerName,
      startDate: v.startDate,
      endDate: v.endDate,
      status: v.status,
    })
  })

  // 期間内判定（今日帰国中のもの）
  const onLeaveFromMain = mainHomeLeaves.filter(hl =>
    hl.startDate <= todayDateStr && todayDateStr <= hl.endDate
  )
  const onLeaveFromCollection = hlList.filter(hl =>
    hl.status === 'approved' && hl.startDate && hl.endDate
    && hl.startDate <= todayDateStr && todayDateStr <= hl.endDate
  )

  return NextResponse.json({
    todayDateStr,
    summary: {
      mainHomeLeavesTotal: mainHomeLeaves.length,
      mainOnLeaveToday: onLeaveFromMain.length,
      homeLongLeaveCollectionTotal: hlList.length,
      hlCollectionOnLeaveToday: onLeaveFromCollection.length,
    },
    onLeaveFromMain,
    onLeaveFromCollection,
    rawMainHomeLeaves: mainHomeLeaves,
    rawHomeLongLeave: hlList,
  })
}
