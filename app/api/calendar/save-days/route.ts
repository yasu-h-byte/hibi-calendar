import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { ym7 } from '@/lib/ym'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym: ymRaw, days, updatedBy } = await request.json()
    // siteCalendar の docId/ym は "YYYY-MM" 形式で統一（2026-05-08 正規化）
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    // Get existing doc to preserve status
    const existing = await getDoc(doc(db, 'siteCalendar', docId))
    const existingData = existing.exists() ? existing.data() : {}
    const wasApproved = existingData.status === 'approved'

    // 承認後修正時の差分計算（監査用）+ 変更なし判定
    let diffSummary = ''
    let hasChanges = true
    if (wasApproved && existingData.days) {
      const oldDays = existingData.days as Record<string, string>
      const changes: string[] = []
      const allKeys = new Set([...Object.keys(oldDays), ...Object.keys(days || {})])
      for (const k of allKeys) {
        const before = oldDays[k] || 'work'
        const after = (days || {})[k] || 'work'
        if (before !== after) changes.push(`${k}日: ${before}→${after}`)
      }
      diffSummary = changes.join(', ')
      hasChanges = changes.length > 0
    }

    // 承認済みカレンダーを「修正」したが休日設定（days）が一切変わっていない場合:
    //   updatedAt を更新すると wasRevised/needsResign が立ち、署名済みスタッフへ
    //   不要な再確認依頼が出てしまう。誤操作・空振り保存を救済するため、書き込み自体を
    //   スキップして既存の updatedAt を温存する（＝再確認を発生させない）。
    //   ※承認前(draft)の保存は署名が無く再確認に影響しないため対象外。
    if (wasApproved && existingData.days && !hasChanges) {
      await logActivity(
        String(updatedBy || 'admin'),
        'calendar.reviseApproved',
        `${siteId} ${ym} 承認後修正を試みたが変更なし → 再確認は発生させず（updatedAt温存）`,
      )
      return NextResponse.json({ success: true, unchanged: true })
    }

    await setDoc(doc(db, 'siteCalendar', docId), {
      siteId,
      ym,
      days,
      status: existingData.status === 'rejected' ? 'draft' : (existingData.status || 'draft'),
      submittedAt: existingData.submittedAt || null,
      submittedBy: existingData.submittedBy || null,
      approvedAt: existingData.approvedAt || null,
      approvedBy: existingData.approvedBy || null,
      rejectedReason: existingData.status === 'rejected' ? null : (existingData.rejectedReason || null),
      updatedAt: new Date().toISOString(),
      updatedBy,
    })

    // 承認後修正は監査用に明示的にログ。差分も記録する。
    if (wasApproved) {
      const detail = diffSummary
        ? `${siteId} ${ym} 承認後修正: ${diffSummary}`
        : `${siteId} ${ym} 承認後修正（変更なし or 全置換）`
      await logActivity(String(updatedBy || 'admin'), 'calendar.reviseApproved', detail)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to save days:', error)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
