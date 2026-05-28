/**
 * POST /api/calendar/sign-self
 *
 * Body: { token: string, ym: string ("YYYY-MM"), siteIds?: string[] }
 *
 * トークン認証された外国人スタッフ本人が、自分自身としてカレンダーに
 * 一括サインする。siteIds を省略した場合は、対象月で承認済みかつ
 * 未署名の全現場に対してサインする。
 *
 * セキュリティ:
 *   - workerId はリクエストボディから受け取らない（トークンから解決）
 *   - これにより「他人になりすまして承認する」攻撃を防ぐ
 *   - calendarSign のドキュメントID: `{workerId}_{ym}_{siteId}`
 *
 * 既存 /api/calendar/sign は workerId を直接受け取る形のため、
 * 移行期間中は併存させ、将来的に廃止予定。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { isStillActiveForMonth } from '@/lib/workers'

function hashIP(ip: string): string {
  let hash = 0
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, ym } = body
    const siteIdsParam: string[] | undefined = body.siteIds

    if (!token || !ym) {
      return NextResponse.json({ error: 'token and ym required' }, { status: 400 })
    }

    // Token → worker
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // 外国人スタッフ以外は受け付けない
    if (!worker.visaType || worker.visaType === 'none') {
      return NextResponse.json({ error: 'Not applicable for this worker' }, { status: 400 })
    }

    // 退職: 対象月以降に退職する場合は OK、それ以前に退職済みなら不可
    const ymCompact = ym.replace('-', '')
    if (!isStillActiveForMonth(worker.retired, ymCompact)) {
      return NextResponse.json({ error: 'Worker not active in this month' }, { status: 400 })
    }

    // 全期間帰国中は署名不要
    const homeLeaves = await getAllActiveHomeLeaves()
    if (isFullMonthHomeLeave(worker.id, normalizeYm(ym), homeLeaves)) {
      return NextResponse.json({ error: 'Sign not required for full-month home leave' }, { status: 400 })
    }

    // siteIds が指定されていなければ「承認済み未署名の全現場」を対象に
    let targetSiteIds: string[]
    if (Array.isArray(siteIdsParam) && siteIdsParam.length > 0) {
      targetSiteIds = siteIdsParam
    } else {
      // 承認済みカレンダー一覧を取得
      const calQ = query(
        collection(db, 'siteCalendar'),
        where('ym', '==', ym),
        where('status', '==', 'approved'),
      )
      const calSnap = await getDocs(calQ)
      const approvedSiteIds = calSnap.docs.map(d => d.data().siteId as string)

      // 既存署名を取得
      const signQ = query(
        collection(db, 'calendarSign'),
        where('ym', '==', ym),
        where('workerId', '==', worker.id),
      )
      const signSnap = await getDocs(signQ)
      const signedSiteIds = new Set(signSnap.docs.map(d => d.data().siteId as string))

      targetSiteIds = approvedSiteIds.filter(id => !signedSiteIds.has(id))
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const ipHash = hashIP(ip)
    const signedAt = new Date().toISOString()

    const results: { siteId: string; success: boolean; error?: string; signedAt?: string }[] = []

    for (const siteId of targetSiteIds) {
      // 各現場が approved であることをサーバ側で再確認（クライアント改ざん対策）
      const calDocId = `${siteId}_${ym}`
      const calDoc = await getDoc(doc(db, 'siteCalendar', calDocId))
      if (!calDoc.exists() || calDoc.data().status !== 'approved') {
        results.push({ siteId, success: false, error: 'Calendar not approved' })
        continue
      }

      // 既に署名済みなら冪等にスキップ
      const signDocId = `${worker.id}_${ym}_${siteId}`
      const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))
      if (existingSign.exists()) {
        results.push({ siteId, success: true, signedAt: existingSign.data().signedAt })
        continue
      }

      await setDoc(doc(db, 'calendarSign', signDocId), {
        workerId: worker.id,
        ym,
        siteId,
        signedAt,
        method: 'self_tap',     // 新フロー判別用
        ipHash,
      })

      results.push({ siteId, success: true, signedAt })
    }

    const signedCount = results.filter(r => r.success).length
    const failedCount = results.filter(r => !r.success).length

    return NextResponse.json({
      success: failedCount === 0,
      signedCount,
      failedCount,
      results,
    })
  } catch (error) {
    console.error('sign-self error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
