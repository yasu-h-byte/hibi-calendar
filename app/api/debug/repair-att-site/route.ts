import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, deleteField } from 'firebase/firestore'
import { attKey } from '@/lib/attendance'

/**
 * デバッグ用API: 誤った現場に書き込まれた出面データを正しい現場に移し替える
 *
 * 用途: 2026-04-28発生の「奥寺さんがリンさんの3月有給を笹塚現場に誤登録」修復
 *
 * 処理内容:
 * 1. oldSiteId に書き込まれた dates の出面エントリを削除（updateDoc + deleteField）
 * 2. newSiteId に dates の {w:0, p:1} を書き込み（既存があれば上書き／hkがあれば削除）
 *    ただし dryRun の skipExisting が指定されていればスキップ可
 * 3. PLRecord.designatedLeaves で oldSiteId のものを newSiteId に更新
 *
 * dryRun=true で、実際の変更はせず差分プレビューのみ返す。
 *
 * 認証: x-admin-password ヘッダ (admin/super-admin)
 */
export async function POST(request: NextRequest) {
  if (!(await checkApiAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const actor = (await getApiAuthUser(request)) || 'admin'

  const body = await request.json() as {
    workerId: number
    ym: string                  // '202603'
    dates: string[]             // ['2026-03-07','2026-03-09',...] (YYYY-MM-DD)
    oldSiteId: string
    newSiteId: string
    skipIfNewExists?: boolean   // newSiteId 側に既に p:1 等がある場合は書き込みスキップ
    dryRun?: boolean
  }
  const { workerId, ym, dates, oldSiteId, newSiteId, skipIfNewExists, dryRun } = body

  if (!workerId || !ym || !Array.isArray(dates) || !oldSiteId || !newSiteId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // 1. att_YYYYMM ドキュメント取得
  const attRef = doc(db, 'demmen', `att_${ym}`)
  const attSnap = await getDoc(attRef)
  const attDoc = attSnap.exists() ? attSnap.data() : { d: {} }
  const dData = (attDoc.d || {}) as Record<string, Record<string, unknown>>

  type Plan = {
    date: string
    day: number
    oldKey: string
    oldEntry: Record<string, unknown> | null
    newKey: string
    newEntryBefore: Record<string, unknown> | null
    action: 'move' | 'skip-new-exists' | 'no-old-data'
    note?: string
  }
  const plans: Plan[] = []
  const updates: Record<string, unknown> = {}

  for (const dateStr of dates) {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) continue
    if (d.getFullYear() !== Number(ym.slice(0, 4))) continue
    if (d.getMonth() + 1 !== Number(ym.slice(4, 6))) continue
    const day = d.getDate()
    const oldKey = attKey(oldSiteId, workerId, ym, day)
    const newKey = attKey(newSiteId, workerId, ym, day)
    const oldEntry = dData[oldKey] || null
    const newEntryBefore = dData[newKey] || null

    if (!oldEntry) {
      plans.push({
        date: dateStr, day, oldKey, oldEntry: null, newKey, newEntryBefore,
        action: 'no-old-data',
        note: 'oldSiteId に該当データなし。スキップ。',
      })
      continue
    }

    // newSiteId 側にすでに p:1 等の有給データが入っていれば、上書き回避（重複防止）
    const newHasPaid = newEntryBefore && (
      (newEntryBefore.p as number | undefined) === 1
    )
    if (newHasPaid && skipIfNewExists) {
      // 古い方は削除する（newに既に有給があるので、oldは消すだけ）
      plans.push({
        date: dateStr, day, oldKey, oldEntry, newKey, newEntryBefore,
        action: 'skip-new-exists',
        note: 'newSiteId に既に有給データあり。oldのみ削除。',
      })
      // updates: oldキー全体を削除
      updates[`d.${oldKey}`] = deleteField()
      continue
    }

    // 通常パターン: oldを削除、newに { w:0, p:1 } を書き込み（hk があれば消す）
    plans.push({
      date: dateStr, day, oldKey, oldEntry, newKey, newEntryBefore,
      action: 'move',
    })
    updates[`d.${oldKey}`] = deleteField()
    updates[`d.${newKey}.w`] = 0
    updates[`d.${newKey}.p`] = 1
    updates[`d.${newKey}.hk`] = deleteField()
  }

  // 2. PLRecord.designatedLeaves の siteId 更新計画
  const mainRef = doc(db, 'demmen', 'main')
  const mainSnap = await getDoc(mainRef)
  if (!mainSnap.exists()) {
    return NextResponse.json({ error: 'main doc not found' }, { status: 404 })
  }
  const mainData = mainSnap.data()
  const plData = (mainData.plData || {}) as Record<string, Record<string, unknown>[]>
  const wRecords = plData[String(workerId)] || []
  type DesignatedEntry = { date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string; kind?: string; overwroteHomeLeave?: boolean }

  type HistoryUpdate = { fyIdx: number; entryIdx: number; date: string; from: string; to: string }
  const historyUpdates: HistoryUpdate[] = []

  const dateSet = new Set(dates)
  wRecords.forEach((r, fyIdx) => {
    const arr = (r.designatedLeaves as DesignatedEntry[] | undefined) ?? []
    arr.forEach((entry, entryIdx) => {
      if (entry.siteId === oldSiteId && dateSet.has(entry.date)) {
        historyUpdates.push({ fyIdx, entryIdx, date: entry.date, from: oldSiteId, to: newSiteId })
      }
    })
  })

  // 3. dryRunならここでプレビュー返却
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      plans,
      historyUpdates,
      attUpdatesCount: Object.keys(updates).length,
    })
  }

  // 4. 実行
  // 4-1. 出面データ更新
  if (Object.keys(updates).length > 0) {
    if (!attSnap.exists()) {
      // ドキュメント未存在ならまず空で作る
      await updateDoc(attRef, updates).catch(async () => {
        // ドキュメント未存在の場合は setDoc が必要だが、ここでは起こらないはず
        const { setDoc } = await import('firebase/firestore')
        await setDoc(attRef, { d: {} }, { merge: true })
        await updateDoc(attRef, updates)
      })
    } else {
      await updateDoc(attRef, updates)
    }
  }

  // 4-2. PLRecord履歴更新
  if (historyUpdates.length > 0) {
    historyUpdates.forEach(({ fyIdx, entryIdx, to }) => {
      const arr = (wRecords[fyIdx].designatedLeaves as DesignatedEntry[] | undefined) ?? []
      if (arr[entryIdx]) {
        arr[entryIdx].siteId = to
        // 修復履歴をnoteに追記
        const prevNote = arr[entryIdx].note ? `${arr[entryIdx].note} | ` : ''
        arr[entryIdx].note = `${prevNote}修復(${oldSiteId}→${to}) by ${actor}`
      }
    })
    plData[String(workerId)] = wRecords
    await updateDoc(mainRef, { plData })
  }

  return NextResponse.json({
    success: true,
    plans,
    historyUpdates,
    actor,
  })
}
