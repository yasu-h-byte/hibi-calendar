import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from '@/lib/fsdb'
import { todayJstIso } from '@/lib/date-utils'

/**
 * デバッグ用: 帰国情報のソース2つを生で返す
 * - main.homeLeaves 配列
 * - homeLongLeave コレクション
 *
 * 使い方:
 *   GET /api/debug/inspect-home-leave（ヘッダ x-admin-password に代表の通行証）
 */
export async function GET(request: NextRequest) {
  // 2026-09-26: 保守ツールは代表のみ
  // 2026-10-02 総合点検: ?password= での認証はやめた（代表の通行証が URL に載り、ブラウザ履歴・サーバのログに残る）。
  //   ヘッダ x-admin-password だけ受け付ける（ほかの API と同じ）
  const denied = await requireSuperAdmin(request)
  if (denied) return denied

  // 今日の日付
  const todayDateStr = todayJstIso()

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
