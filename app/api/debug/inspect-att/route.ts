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

    // 3. PLRecord の designatedLeaves
    const plData = (mainData.plData || {}) as Record<string, Record<string, unknown>[]>
    const wRecords = plData[String(w.id)] || []
    ;(result as Record<string, unknown>)[`pl_${w.id}`] = wRecords.map(r => ({
      fy: r.fy,
      grantDate: r.grantDate,
      grantDays: r.grantDays,
      designatedLeavesCount: Array.isArray(r.designatedLeaves) ? (r.designatedLeaves as unknown[]).length : 0,
      designatedLeaves: r.designatedLeaves,
    }))
  }

  // 4. homeLeaves情報
  result['homeLeaves'] = mainData.homeLeaves || []

  return NextResponse.json(result)
}
