import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const ym = searchParams.get('ym')

  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)
    const prescribedDays = main.workDays[ym] || 0
    // カレンダーから現場別所定日数を取得（5月以降は手入力不要）
    const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
    const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
    // 3層構造のベース日数（管理者設定）
    const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
    const result = computeMonthly(main, att.d, att.sd, ym, prescribedDays, hasCalendarData ? siteWorkDaysMap : undefined, baseDays)

    // 組織別ロック状態（後方互換: 旧 locks[ym] もチェック）
    const lockedLegacy = !!(main.locks[ym])
    const lockedHibi = !!(main.locks[`${ym}_hibi`]) || lockedLegacy
    const lockedHfu = !!(main.locks[`${ym}_hfu`]) || lockedLegacy
    const locked = lockedHibi && lockedHfu  // 両方締めていれば全体locked
    const workDays = prescribedDays

    // Site name map for frontend display
    const siteNames: Record<string, string> = {}
    for (const s of main.sites) {
      siteNames[s.id] = s.name
    }

    // 2026-06-XX 追加: 印刷ページ (/monthly/audit-print) 用に
    //   日別出勤データを optional で返す。includeDaily=true で取得。
    //   キー形式: workerId -> { day -> entry }
    //   通常の月次集計画面では使われないので、デフォルトでは含めない（payload 削減）。
    let dailyByWorker: Record<number, Record<number, unknown>> | undefined
    if (searchParams.get('includeDaily') === 'true') {
      dailyByWorker = {}
      for (const [key, entry] of Object.entries(att.d || {})) {
        if (!entry || typeof entry !== 'object') continue
        // key 形式: `${siteId}_${workerId}_${ym}_${day}`
        const parts = key.split('_')
        if (parts.length < 4) continue
        const day = parseInt(parts[parts.length - 1])
        const keyYm = parts[parts.length - 2]
        const wid = parseInt(parts[parts.length - 3])
        const siteId = parts.slice(0, parts.length - 3).join('_')
        if (keyYm !== ym || !Number.isFinite(wid) || !Number.isFinite(day)) continue
        if (!dailyByWorker[wid]) dailyByWorker[wid] = {}
        // 同一日に複数現場の入力がある場合は最初のものを保持（カレンダー表示では1日1セル）
        if (!dailyByWorker[wid][day]) {
          dailyByWorker[wid][day] = { ...entry, _siteId: siteId }
        }
      }
    }

    // 2026-06-12 (監査 Sprint2-D): 締め済み月は締め時スナップショットと現行計算を突合。
    //   締め後の単価変更・出面修正で支給額が変わっていれば画面に警告する。
    type SnapDiffItem = { id: number; name: string; snapshot: number; current: number }
    const snapshotDiffs: { org: string; lockedAt?: string; count: number; items: SnapDiffItem[] }[] = []
    const isHfuOrg = (o?: string) => o === 'hfu' || o === 'HFU'
    for (const [orgKey, isLocked] of [['hibi', lockedHibi], ['hfu', lockedHfu]] as const) {
      if (!isLocked) continue
      try {
        let snapDoc = await getDoc(doc(db, 'payrollSnapshots', `${ym}_${orgKey}`))
        if (!snapDoc.exists()) snapDoc = await getDoc(doc(db, 'payrollSnapshots', `${ym}_all`))
        if (!snapDoc.exists()) continue  // スナップショット導入前の締めは検知対象外
        const snapData = snapDoc.data() as { lockedAt?: string; workers?: { id: number; name: string; salaryNetPay?: number }[] }
        const snapMap = new Map((snapData.workers || []).map(w => [w.id, w]))
        const items: SnapDiffItem[] = []
        for (const w of result.workers) {
          if ((isHfuOrg(w.org) ? 'hfu' : 'hibi') !== orgKey) continue
          const cur = w.salaryNetPay || 0
          const s = snapMap.get(w.id)
          snapMap.delete(w.id)
          const snapVal = s?.salaryNetPay || 0
          if (snapVal !== cur) items.push({ id: w.id, name: w.name, snapshot: snapVal, current: cur })
        }
        for (const s of snapMap.values()) {
          if ((s.salaryNetPay || 0) !== 0) items.push({ id: s.id, name: s.name, snapshot: s.salaryNetPay || 0, current: 0 })
        }
        if (items.length > 0) {
          snapshotDiffs.push({ org: orgKey, lockedAt: snapData.lockedAt, count: items.length, items: items.slice(0, 10) })
        }
      } catch (e) {
        console.error(`[monthly] snapshot diff 取得失敗 (${orgKey}):`, e)
      }
    }

    return NextResponse.json({
      workers: result.workers,
      subcons: result.subcons,
      sites: result.sites,
      totals: result.totals,
      locked,
      lockedHibi,
      lockedHfu,
      workDays,
      prescribedDays,
      baseDays,  // 2026-06-12 (監査): モーダル/印刷の式表示用（旧: クライアントで20固定）
      siteNames,
      hasCalendarData,
      siteWorkDays: siteWorkDaysMap,
      ...(snapshotDiffs.length > 0 ? { snapshotDiffs } : {}),
      ...(dailyByWorker ? { dailyByWorker } : {}),
    })
  } catch (error) {
    console.error('Monthly API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Failed to compute monthly data', detail: errMsg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'setWorkDays') {
      const { ym, value } = body
      if (!ym || !/^\d{6}$/.test(ym)) {
        return NextResponse.json({ error: 'ym required' }, { status: 400 })
      }
      // 2026-06-12 (監査 Sprint2-B): 全社所定日数は旧ルール継続者(フン)の欠勤控除に
      //   直結するため、当該月がロック済みなら変更を拒否
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const lockErr = await checkMonthLocked(ym, 'hibi')
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }
      const numValue = Number(value) || 0
      const docRef = doc(db, 'demmen', 'main')
      await updateDoc(docRef, { [`workDays.${ym}`]: numValue })
      const { logActivity } = await import('@/lib/activity')
      await logActivity('admin', 'monthly.setWorkDays', `${ym} の全社所定日数を ${numValue}日 に設定`)
      return NextResponse.json({ success: true, workDays: numValue })
    }

    if (action === 'copyPrevMonth') {
      const { ym } = body
      if (!ym || !/^\d{6}$/.test(ym)) {
        return NextResponse.json({ error: 'ym required' }, { status: 400 })
      }

      // Calculate previous month ym
      const year = parseInt(ym.slice(0, 4))
      const month = parseInt(ym.slice(4, 6))
      let prevYear = year
      let prevMonth = month - 1
      if (prevMonth < 1) { prevMonth = 12; prevYear -= 1 }
      const prevYm = `${prevYear}${String(prevMonth).padStart(2, '0')}`

      // Read previous month attendance data
      const prevDocSnap = await getDoc(doc(db, 'demmen', `att_${prevYm}`))
      if (!prevDocSnap.exists()) {
        return NextResponse.json({ error: '前月のデータが見つかりません' }, { status: 404 })
      }
      const prevData = prevDocSnap.data()
      const prevD = (prevData.d || {}) as Record<string, unknown>

      // Safety: 前月データが空なら何もしない（誤操作で当月を消すのを防ぐ）
      if (Object.keys(prevD).length === 0) {
        return NextResponse.json({ error: '前月のデータが空のためコピーをスキップしました' }, { status: 400 })
      }

      // Rewrite keys: replace prevYm with ym in attendance keys
      const newD: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(prevD)) {
        // Keys are like: siteId_workerId_ym_dd
        const newKey = key.replace(`_${prevYm}_`, `_${ym}_`)
        newD[newKey] = value
      }

      // ⚠️ 安全対策（2026-05-07 事故を受けて改修）:
      //   旧コードは setDoc(curDocRef, { d: newD, sd: {} }) または
      //   updateDoc(curDocRef, { d: newD }) で d 全体を一気に置換していた。
      //   既存データを残しつつ前月データを「重ね書き」する方式に変更。
      //   (1) 当月docの存在を保証 (sd は触らない)
      //   (2) dot-notation で newD の各キーを 1 件ずつ書き込み
      //   これにより当月に既に手入力された (newDにないキーの) データは保持される。
      //   かつ Firestore の罠 ({field: {}} で field 全消失) を完全に回避できる。
      const { ensureDocExists } = await import('@/lib/firestore-safe')
      const curDocRef = doc(db, 'demmen', `att_${ym}`)
      await ensureDocExists(curDocRef)

      // 大量キーの書き込みは Firestore の updateDoc 上限 (約500フィールド/呼出) に
      // 引っかかる可能性があるため、500件ごとに分割して書き込む
      const newKeys = Object.keys(newD)
      const CHUNK = 400
      for (let i = 0; i < newKeys.length; i += CHUNK) {
        const chunk = newKeys.slice(i, i + CHUNK)
        const updates: Record<string, unknown> = {}
        for (const k of chunk) {
          updates[`d.${k}`] = newD[k]
        }
        await updateDoc(curDocRef, updates)
      }

      return NextResponse.json({ success: true, copiedEntries: newKeys.length })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('Monthly POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
