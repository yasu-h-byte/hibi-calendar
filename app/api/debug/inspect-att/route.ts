import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'

/**
 * デバッグ用API: 特定ワーカーの特定月の出面データと有給履歴を生で返す
 *
 * 使い方（管理画面のブラウザコンソールから）:
 *   fetch('/api/debug/inspect-att', {
 *     method: 'POST',
 *     headers: {
 *       'Content-Type': 'application/json',
 *       'x-admin-password': '<管理者パスワード>',
 *     },
 *     body: JSON.stringify({ workerNameLike: 'ヴゥ', ym: '202603' }),
 *   }).then(r => r.json()).then(console.log)
 */
export async function POST(request: NextRequest) {
  if (!(await checkApiAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { workerNameLike, workerId, ym } = await request.json() as {
    workerNameLike?: string
    workerId?: number
    ym: string
  }

  if (!ym) {
    return NextResponse.json({ error: 'ym required (e.g. 202603)' }, { status: 400 })
  }

  // 1. main から該当workerを探す
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainSnap.exists()) return NextResponse.json({ error: 'main not found' }, { status: 404 })
  const mainData = mainSnap.data()
  const workers = (mainData.workers || []) as { id: number; name: string; nameVi?: string; visa?: string }[]

  let matched: { id: number; name: string; nameVi?: string; visa?: string }[] = []
  if (workerId !== undefined) {
    matched = workers.filter(w => w.id === workerId)
  } else if (workerNameLike) {
    matched = workers.filter(w => (w.name || '').includes(workerNameLike) || (w.nameVi || '').includes(workerNameLike))
  } else {
    return NextResponse.json({ error: 'workerId or workerNameLike required' }, { status: 400 })
  }
  if (matched.length === 0) {
    return NextResponse.json({ error: 'no matching worker', workersHint: workers.map(w => ({ id: w.id, name: w.name })).slice(0, 30) }, { status: 404 })
  }

  const result: Record<string, unknown> = { matched }

  // 2. 出面データ att_YYYYMM を全部取得し、該当workerの行のみ抽出
  const attSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
  const attData = attSnap.exists() ? (attSnap.data().d as Record<string, Record<string, unknown>>) || {} : {}

  for (const w of matched) {
    const wKey = `_${w.id}_`
    const entries: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(attData)) {
      // key format: siteId_workerId_ym_day
      const parts = key.split('_')
      // workerId はsiteIdの末尾要素になる場合があるので、ymをキーにして判別
      const ymIdx = parts.indexOf(ym)
      if (ymIdx <= 0) continue
      const widFromKey = parts[ymIdx - 1]
      if (widFromKey === String(w.id)) {
        entries[key] = val
      }
    }
    ;(result as Record<string, unknown>)[`att_${w.id}`] = entries

    // 3. PLRecord 全体（旧フィールド grant/carry/adj も含めて）
    // + 各レコードの期間（grantDate〜+1年）の P 消化数も計算
    const plData = (mainData.plData || {}) as Record<string, Record<string, unknown>[]>
    const wRecords = plData[String(w.id)] || []

    // 過去3年分の出面データを取得（前期や前々期も対応）
    const allAttForWorker: { date: Date; count: number }[] = []
    const now = new Date()
    for (let yy = now.getFullYear() - 3; yy <= now.getFullYear() + 1; yy++) {
      for (let mm = 1; mm <= 12; mm++) {
        const yymm = `${yy}${String(mm).padStart(2, '0')}`
        const attSnap2 = await getDoc(doc(db, 'demmen', `att_${yymm}`))
        if (!attSnap2.exists()) continue
        const data2 = (attSnap2.data().d || {}) as Record<string, Record<string, unknown>>
        for (const [key, val] of Object.entries(data2)) {
          if (!val) continue
          const e = val as { p?: number | boolean }
          if (!e.p) continue
          // siteId_workerId_ym_day
          const parts = key.split('_')
          const ymIdx = parts.indexOf(yymm)
          if (ymIdx <= 0) continue
          const widFromKey = parts[ymIdx - 1]
          if (widFromKey !== String(w.id)) continue
          const day = parseInt(parts[parts.length - 1])
          allAttForWorker.push({
            date: new Date(yy, mm - 1, day),
            count: 1,
          })
        }
      }
    }

    // 各 PLRecord について、期間内の P 消化数を計算
    const plWithUsage = wRecords.map(r => {
      const grantDate = r.grantDate as string | undefined
      let periodUsed = 0
      let periodEndStr: string | null = null
      if (grantDate) {
        const gdStart = new Date(grantDate + 'T00:00:00')
        if (!isNaN(gdStart.getTime())) {
          const gdEnd = new Date(gdStart)
          gdEnd.setFullYear(gdEnd.getFullYear() + 1)
          periodUsed = allAttForWorker.filter(a => a.date >= gdStart && a.date < gdEnd).length
          periodEndStr = `${gdEnd.getFullYear()}-${String(gdEnd.getMonth() + 1).padStart(2, '0')}-${String(gdEnd.getDate()).padStart(2, '0')}`
        }
      }
      // 残日数 = 付与 + 繰越 - 調整 - 消化
      const grantDays = (r.grantDays as number | undefined) ?? (r.grant as number | undefined) ?? 0
      const carryOver = (r.carryOver as number | undefined) ?? (r.carry as number | undefined) ?? 0
      const adjustment = (r.adjustment as number | undefined) ?? (r.adj as number | undefined) ?? 0
      const remaining = Math.max(0, grantDays + carryOver - adjustment - periodUsed)
      return {
        fy: r.fy,
        grantDate: r.grantDate,
        periodEnd: periodEndStr,
        // 新フィールド（現行）
        grantDays: r.grantDays,
        carryOver: r.carryOver,
        adjustment: r.adjustment,
        // 旧フィールド（移行時に残ったまま？）
        grant: r.grant,
        carry: r.carry,
        adj: r.adj,
        // 計算結果
        periodUsed,
        remaining,
        // メタ
        _archived: r._archived,
        grantedAt: r.grantedAt,
        grantedBy: r.grantedBy,
        method: r.method,
        designatedLeavesCount: Array.isArray(r.designatedLeaves) ? (r.designatedLeaves as unknown[]).length : 0,
        designatedLeaves: r.designatedLeaves,
      }
    })
    ;(result as Record<string, unknown>)[`pl_${w.id}`] = plWithUsage
  }

  // 4. homeLeaves情報
  result['homeLeaves'] = mainData.homeLeaves || []

  return NextResponse.json(result)
}
