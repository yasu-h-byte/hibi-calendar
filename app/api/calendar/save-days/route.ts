import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from '@/lib/fsdb'
import { ym7 } from '@/lib/ym'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  try {
    const { siteId, ym: ymRaw, days, updatedBy } = await request.json()
    // siteCalendar の docId/ym は "YYYY-MM" 形式で統一（2026-05-08 正規化）
    const ym = ym7(ymRaw)

    // カレンダーの保存(＝作成・編集)は submit と同じ権限:
    //   「その現場の職長」または管理者・事業責任者のみ。
    //   旧: checkApiAuth のみ → ログインできれば他現場の職長・事務も任意現場のカレンダーを
    //       上書きできた（承認済みの休日設定の書き換え含む）。監査(B)で塞いだ。
    const role = await getApiRole(request, ym)
    if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const canEdit = isManagerRole(role.role) || (role.role === 'foreman' && role.foremanSites.includes(siteId))
    if (!canEdit) {
      return NextResponse.json({ error: '保存権限がありません（担当現場の職長または管理者のみ）' }, { status: 403 })
    }

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
      // ★ 給与が参照する所定日数(siteWorkDays / workDays)を新しい days から再計算する（監査A）。
      //   これがないと承認後に休日⇄出勤を変えても siteWorkDays が承認時のまま残り、
      //   月次給与の欠勤控除が過大/過少になる（approve / bulk-confirm と同じ再計算を踏襲）。
      const ymKey = ym.replace('-', '')
      const workDayCount = Object.values(days as Record<string, string>).filter(d => d === 'work').length
      const mainRef = doc(db, 'demmen', 'main')
      await setDoc(mainRef, { siteWorkDays: { [ymKey]: { [siteId]: workDayCount } } }, { merge: true })
      const mainSnap = await getDoc(mainRef)
      const siteWorkDaysForMonth = (mainSnap.exists() ? (mainSnap.data().siteWorkDays || {}) : {})[ymKey] || {}
      const vals = Object.values(siteWorkDaysForMonth) as number[]
      if (vals.length > 0) {
        await setDoc(mainRef, { workDays: { [ymKey]: Math.max(...vals) } }, { merge: true })
      }

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
