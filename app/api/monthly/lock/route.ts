import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, updateDoc, setDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

/**
 * 締め時点の支給額スナップショットを保存（2026-06-12 監査 Sprint2-D）。
 *
 * 背景: 月次集計は表示のたびに「現在の」単価・出面で再計算されるため、
 * 締め（給与確定・振込）後に単価変更や出面修正があると、過去月の画面・Excel・
 * 監査PDFが黙って変わり「あの月いくら払ったか」が再現できなかった。
 * 締め時に worker 別支給額を凍結保存し、/api/monthly が現行計算と突合して
 * 差分があれば画面に警告する。
 */
async function savePayrollSnapshot(ym: string, orgKey: 'hibi' | 'hfu' | 'all', lockedBy: string): Promise<void> {
  const main = await getMainData()
  const att = await getAttData(ym)
  const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ym] || {}
  const hasCal = Object.keys(siteWorkDaysMap).length > 0
  const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
  const result = computeMonthly(main, att.d, att.sd, ym, main.workDays[ym] || 0, hasCal ? siteWorkDaysMap : undefined, baseDays)
  const isHfu = (org?: string) => org === 'hfu' || org === 'HFU'
  const workers = result.workers
    .filter(w => orgKey === 'all' ? true : (orgKey === 'hfu' ? isHfu(w.org) : !isHfu(w.org)))
    .map(w => ({
      id: w.id,
      name: w.name,
      salaryNetPay: w.salaryNetPay || 0,
      totalCost: w.totalCost || 0,
    }))
  await setDoc(doc(db, 'payrollSnapshots', `${ym}_${orgKey}`), {
    ym,
    org: orgKey,
    lockedAt: new Date().toISOString(),
    lockedBy,
    workers,
    totalNetPay: workers.reduce((s, w) => s + w.salaryNetPay, 0),
  })
}

export async function POST(request: NextRequest) {
  // 2026-06-12 (監査 Sprint2-B): 操作者を識別して記録。
  //   旧: checkApiAuth + 'admin' 固定名義 → 誰が締め/解除したか追跡不能で、
  //   「締め→こっそり解除→改竄→再締め」が無痕跡で可能だった
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const actorLabel = auth.actor === 'super-admin' ? 'super-admin'
    : auth.actor === 'admin' ? 'admin(共通PW)'
    : `workerId=${auth.actor}`

  try {
    const { ym, locked, org } = await request.json()
    if (!ym) {
      return NextResponse.json({ error: 'ym required' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', 'main')

    if (org === 'hibi' || org === 'hfu') {
      // 組織別ロック: locks["202603_hibi"] = true
      const lockKey = `${ym}_${org}`
      await updateDoc(docRef, { [`locks.${lockKey}`]: locked ? true : false })
      const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} ${orgLabel}を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    } else {
      // 後方互換: org未指定の場合は全体ロック（旧方式）
      await updateDoc(docRef, { [`locks.${ym}`]: locked ? true : false })
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    }

    // 締め時のみ: 支給額スナップショットを凍結保存（解除時は最後の締め時点を保持）
    if (locked) {
      try {
        await savePayrollSnapshot(ym, org === 'hibi' || org === 'hfu' ? org : 'all', actorLabel)
      } catch (e) {
        // スナップショット失敗で締め自体は妨げない（締めは成立し、差分検知が無効になるだけ）
        console.error('[lock] payrollSnapshot 保存失敗:', e)
      }
    }

    return NextResponse.json({ success: true, locked: !!locked })
  } catch (error) {
    console.error('Lock POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
