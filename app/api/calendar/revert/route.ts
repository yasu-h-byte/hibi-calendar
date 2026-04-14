import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc, getDoc, collection, query, where, getDocs, deleteDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

/**
 * カレンダーステータスの巻き戻しAPI
 * - 承認済み → 提出済みに戻す（承認取消し）
 * - 提出済み → 下書きに戻す（提出取消し）
 */
export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, action, revertedBy } = await request.json()

    if (!siteId || !ym || !action) {
      return NextResponse.json({ error: 'siteId, ym, action required' }, { status: 400 })
    }

    const docId = `${siteId}_${ym}`
    const calRef = doc(db, 'siteCalendar', docId)
    const calSnap = await getDoc(calRef)

    if (!calSnap.exists()) {
      return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
    }

    const calData = calSnap.data()
    const currentStatus = calData.status

    if (action === 'unapprove') {
      // 承認取消し: approved → submitted
      if (currentStatus !== 'approved') {
        return NextResponse.json({ error: `承認済みではありません（現在: ${currentStatus}）` }, { status: 400 })
      }

      // 署名データも削除（承認取消し後は再署名が必要）
      const signQ = query(
        collection(db, 'calendarSign'),
        where('ym', '==', ym),
        where('siteId', '==', siteId)
      )
      const signSnap = await getDocs(signQ)
      let deletedSigns = 0
      for (const d of signSnap.docs) {
        await deleteDoc(d.ref)
        deletedSigns++
      }

      // siteWorkDaysからも削除
      const ymKey = ym.replace('-', '')
      const mainRef = doc(db, 'demmen', 'main')
      const mainSnap = await getDoc(mainRef)
      if (mainSnap.exists()) {
        const mainData = mainSnap.data()
        const siteWorkDays = mainData.siteWorkDays || {}
        if (siteWorkDays[ymKey] && siteWorkDays[ymKey][siteId] !== undefined) {
          const updated = { ...siteWorkDays[ymKey] }
          delete updated[siteId]
          await updateDoc(mainRef, { [`siteWorkDays.${ymKey}`]: updated })
        }
      }

      await updateDoc(calRef, {
        status: 'submitted',
        approvedAt: null,
        approvedBy: null,
        revertedAt: new Date().toISOString(),
        revertedBy: revertedBy || null,
      })

      await logActivity(String(revertedBy || 'admin'), 'calendar.unapprove', `${siteId} ${ym} の承認を取消し（署名${deletedSigns}件も削除）`)

      return NextResponse.json({ success: true, message: '承認を取消しました。署名データも削除されました。' })

    } else if (action === 'unsubmit') {
      // 提出取消し: submitted → draft
      if (currentStatus !== 'submitted') {
        return NextResponse.json({ error: `提出済みではありません（現在: ${currentStatus}）` }, { status: 400 })
      }

      await updateDoc(calRef, {
        status: 'draft',
        submittedAt: null,
        submittedBy: null,
        revertedAt: new Date().toISOString(),
        revertedBy: revertedBy || null,
      })

      await logActivity(String(revertedBy || 'admin'), 'calendar.unsubmit', `${siteId} ${ym} の提出を取消し`)

      return NextResponse.json({ success: true, message: '提出を取消しました。職長が再編集できます。' })

    } else {
      return NextResponse.json({ error: 'Invalid action. Use "unapprove" or "unsubmit".' }, { status: 400 })
    }
  } catch (error) {
    console.error('Calendar revert error:', error)
    return NextResponse.json({ error: 'Failed to revert' }, { status: 500 })
  }
}
