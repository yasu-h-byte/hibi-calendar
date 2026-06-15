import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, getAssign } from '@/lib/compute'
import { getApprovalForDay } from '@/lib/attendance'
import { isStillActiveForMonth } from '@/lib/workers'
import { AttendanceEntry, DayType } from '@/types'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const siteId = request.nextUrl.searchParams.get('siteId')
  const ym = request.nextUrl.searchParams.get('ym')
  if (!siteId || !ym) {
    return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
  }

  try {
    // 独立した 2 つの read を並列化（1 RTT 削減）
    const [main, att] = await Promise.all([
      getMainData(),
      getAttData(ym),
    ])

    const site = main.sites.find(s => s.id === siteId)
    if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 })

    // Get workers assigned to this site (with 12-month lookback)
    const assignData = getAssign(main, siteId, ym)
    const workerIds = assignData.workers

    // Get days in month
    const [y, m] = [parseInt(ym.substring(0, 4)), parseInt(ym.substring(4, 6))]
    const daysInMonth = new Date(y, m, 0).getDate()

    // Build attendance grid first (to check who has data)
    const allWorkerEntries: Record<number, Record<number, AttendanceEntry>> = {}
    for (const wid of workerIds) {
      allWorkerEntries[wid] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${wid}_${ym}_${String(d)}`
        if (att.d[key]) allWorkerEntries[wid][d] = att.d[key]
      }
    }

    // For months where massign has too many workers (pre-2026 bulk assignment),
    // filter to only those with actual attendance data
    const currentAssignCount = main.assign[siteId]?.workers?.length || 0
    const monthKey = `${siteId}_${ym}`
    const useMassignFilter = main.massign[monthKey] && workerIds.length > currentAssignCount * 2
    const filteredWorkerIds = useMassignFilter
      ? workerIds.filter((wid: number) => Object.keys(allWorkerEntries[wid] || {}).length > 0)
      : workerIds

    // 2026-05-25 修正: 退職日が入っていても、退職日が表示月の月初以降ならまだ在籍中なので表示する
    //   旧: !w.retired （退職日が入った瞬間に非表示 → 退職月の出面入力ができないバグ）
    //   新: 退職日 >= 表示月の月初 なら表示（退職月の出面入力可能、翌月以降は非表示）
    //   2026-05-27: lib/workers の共通ヘルパーに統一
    const workers = main.workers
      .filter(w => filteredWorkerIds.includes(w.id) && isStillActiveForMonth(w.retired, ym))
      .map(w => ({
        id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
        retired: w.retired || undefined,  // 退職日（バッジ表示用）
        // 2026-06-13: 旧契約継続者（フン等）は出面UIをレガシー（日数+残業+0.6補）にするため
        useOldRules: (w as { useOldRules?: boolean }).useOldRules || undefined,
      }))

    const workerEntries: Record<string, Record<number, AttendanceEntry>> = {}
    for (const w of workers) {
      workerEntries[w.id] = allWorkerEntries[w.id] || {}
    }

    // Get subcons assigned to this site (with 12-month lookback)
    const subconIds = assignData.subcons
    const subcons = main.subcons
      .filter(sc => subconIds.includes(sc.id))
      .map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

    const subconEntries: Record<string, Record<number, { n: number; on: number }>> = {}
    for (const sc of subcons) {
      subconEntries[sc.id] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${sc.id}_${ym}_${String(d)}`
        if (att.sd[key]) subconEntries[sc.id][d] = att.sd[key]
      }
    }

    // 組織別ロック状態（後方互換: 旧 locks[ym] もチェック）
    const lockedLegacy = !!(main.locks[ym])
    const lockedHibi = !!(main.locks[`${ym}_hibi`]) || lockedLegacy
    const lockedHfu = !!(main.locks[`${ym}_hfu`]) || lockedLegacy
    const locked = lockedHibi && lockedHfu

    // Foreman name (check mforeman for monthly override)
    const mfKey = `${siteId}_${ym}`
    const mf = main.mforeman?.[mfKey]
    const effectiveForeman = mf?.foreman ?? mf?.wid ?? site.foreman
    const foremanWorker = main.workers.find(w => w.id === effectiveForeman)
    const foremanName = foremanWorker?.name || ''
    const foremanNote = mf?.note || ''

    // Approval status per day（2段階承認対応）— 1日ずつ sequential 取得していた為遅かった
    //   30 RTT → 並列化で 1 RTT 相当に
    const approvals: Record<number, boolean> = {}
    const foremanApprovals: Record<number, { by: number; at: string }> = {}
    const finalApprovals: Record<number, { by: number; at: string }> = {}
    const dayList = Array.from({ length: daysInMonth }, (_, i) => i + 1)
    const collectionApprovals = await Promise.all(
      dayList.map(d => getApprovalForDay(siteId, ym, d))
    )
    for (let i = 0; i < dayList.length; i++) {
      const d = dayList[i]
      const approvalKey = `${siteId}_${ym}_${String(d)}`
      const collectionApproval = collectionApprovals[i]
      if (collectionApproval?.foreman) {
        approvals[d] = true
        foremanApprovals[d] = collectionApproval.foreman
      } else if (att.approvals?.[approvalKey]) {
        // Fallback: 旧データ (att_*.approvals) の場合
        approvals[d] = true
      }
      if (collectionApproval?.final) {
        finalApprovals[d] = collectionApproval.final
      }
    }

    // workDays for this month
    const workDaysValue = main.workDays[ym] ?? null

    // Per-site workDays from approved calendars
    const siteWorkDaysForMonth = main.siteWorkDays[ym] ?? {}
    const siteWorkDaysValue = siteWorkDaysForMonth[siteId] ?? null

    // Load approved site calendar for holiday work detection
    const calYm = `${String(y)}-${String(m).padStart(2, '0')}`
    const calDocId = `${siteId}_${calYm}`
    const calSnap = await getDoc(doc(db, 'siteCalendar', calDocId))
    const calData = calSnap.exists() ? calSnap.data() : null
    const calendarDays: Record<string, DayType> | null =
      calData?.status === 'approved' && calData?.days ? calData.days as Record<string, DayType> : null

    // All active workers (for assignment modal)
    // 2026-06-XX 修正: 退職月までは配置候補に含める（同月内の引き継ぎ対応）
    const allWorkers = main.workers
      .filter(w => isStillActiveForMonth(w.retired, ym))
      .map(w => ({ id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job }))

    // All subcons (for assignment modal) — 2026-05-18: 配置編集モーダルの「外注先」タブ用
    const allSubcons = (main.subcons || []).map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

    // foremanOverride: non-null only when mforeman actually overrides the default
    const foremanOverride = mf
      ? { name: foremanWorker?.name || '', note: mf.note || '' }
      : null

    // 帰国情報: homeLongLeave コレクションが唯一の真実ソース（2026-05-13 統合）
    // 表示対象:
    //   - 当月と帰国期間が重なるもの (帰国中扱い)
    //   - 当月以降に予定されているもの (帰国予定扱い、最大6ヶ月先まで)
    //   - 既に終了したもの (endDate < monthStart) は除外
    //   - 6ヶ月以上先に始まるもの (startDate > horizonEnd) は除外
    // workerName はマスタからルックアップして表示時の最新名を保証する。
    const monthStart = `${String(y)}-${String(m).padStart(2, '0')}-01`
    const horizonDate = new Date(y, m - 1 + 6, daysInMonth)
    const horizonEnd = `${horizonDate.getFullYear()}-${String(horizonDate.getMonth() + 1).padStart(2, '0')}-${String(horizonDate.getDate()).padStart(2, '0')}`
    const homeLeaves: { workerId: number; workerName: string; startDate: string; endDate: string; reason: string; status: string }[] = []

    try {
      const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
      hlSnap.forEach(d => {
        const hl = d.data()
        if (hl.status !== 'approved' && hl.status !== 'foreman_approved') return
        if (!hl.startDate || !hl.endDate) return
        if (hl.endDate < monthStart) return
        if (hl.startDate > horizonEnd) return
        // 名前は表示時にマスタからルックアップ（記録のキャッシュが古くても追従）
        const fresh = main.workers.find(w => w.id === hl.workerId)?.name
        homeLeaves.push({
          workerId: hl.workerId,
          workerName: fresh || hl.workerName || '',
          startDate: hl.startDate,
          endDate: hl.endDate,
          reason: hl.reason || '一時帰国',
          status: hl.status,
        })
      })
    } catch (e) {
      console.warn('homeLongLeave fetch skipped:', e)
    }

    // 開始日順にソート（帰国中→予定の順で見やすく）
    homeLeaves.sort((a, b) => a.startDate.localeCompare(b.startDate))

    return NextResponse.json({
      site: { id: site.id, name: site.name, foreman: effectiveForeman, foremanName, foremanNote },
      foremanOverride,
      year: y, month: m, daysInMonth, ym,
      workers, subcons,
      workerEntries, subconEntries,
      locked,
      lockedHibi,
      lockedHfu,
      approvals,
      foremanApprovals,
      finalApprovals,
      workDays: workDaysValue,
      siteWorkDays: siteWorkDaysValue,
      allWorkers,
      allSubcons,
      sites: main.sites.map(s => ({ id: s.id, name: s.name, archived: s.archived })),
      calendarDays,
      homeLeaves,
      // 2026-05-25 追加: 退職予定情報（今日から3ヶ月以内に退職予定の全スタッフ）
      //   出面入力画面のバナー表示用。職長が他現場のスタッフも含めて全社の退職予定を把握できる。
      upcomingRetirements: (() => {
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const horizon = new Date(today)
        horizon.setMonth(horizon.getMonth() + 3)
        const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        const horizonIso = `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, '0')}-${String(horizon.getDate()).padStart(2, '0')}`
        return main.workers
          .filter(w => w.retired && w.retired >= todayIso && w.retired <= horizonIso)
          .map(w => ({
            id: w.id, name: w.name, org: w.org, visa: w.visa,
            retired: w.retired as string,
          }))
          .sort((a, b) => a.retired.localeCompare(b.retired))
      })(),
    })
  } catch (error) {
    console.error('Grid GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    const { doc, setDoc, getDoc } = await import('firebase/firestore')
    const { db } = await import('@/lib/firebase')

    // ⚠️ 月次ロックチェック（2026-05-08 追加）
    //   出面エントリの編集は ym がロックされている場合は API レベルで拒否。
    //   UIレベルでは表示済みだが、UI を介さず直接 POST する経路を塞ぐ。
    //   admin は強制解除のため lock 系アクションは別ロジックなので影響なし。
    //   保存以外の管理アクション (saveWorkDays/saveAssign/approve系) は対象外。
    const isAttendanceWriteAction =
      !action || action === 'saveAttendance'  // デフォルトの出面エントリ保存
    if (isAttendanceWriteAction) {
      const { ym } = body
      if (ym) {
        const main = await getMainData()
        const lockedLegacy = !!(main.locks?.[ym])
        const lockedHibi = !!(main.locks?.[`${ym}_hibi`]) || lockedLegacy
        const lockedHfu = !!(main.locks?.[`${ym}_hfu`]) || lockedLegacy
        // 両方ロックされていれば全社ロック → 編集禁止
        if (lockedHibi && lockedHfu) {
          return NextResponse.json({ error: '月次ロック済みのため編集できません' }, { status: 409 })
        }
        // 一部組織のみロック時の判定はワーカーの所属で分岐すべきだが、
        // grid POST では entry に workerId が含まれるのでチェック可能
        if (body.workerId !== undefined) {
          const w = main.workers.find(ww => ww.id === Number(body.workerId))
          if (w) {
            const wOrg = w.org === 'hfu' || w.org === 'HFU' ? 'hfu' : 'hibi'
            if (wOrg === 'hibi' && lockedHibi) {
              return NextResponse.json({ error: '日比建設の月次ロック済みのため編集できません' }, { status: 409 })
            }
            if (wOrg === 'hfu' && lockedHfu) {
              return NextResponse.json({ error: 'HFUの月次ロック済みのため編集できません' }, { status: 409 })
            }
          }
        }
      }
    }

    // Action: save workDays
    if (action === 'saveWorkDays') {
      const { ym, value } = body
      if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, { workDays: { [ym]: value } }, { merge: true })
      return NextResponse.json({ success: true })
    }

    // Action: save assignments (workers と subcons 両対応)
    //
    // ⚠️ 2026-05-19 修正: assign[siteId] だけ更新しても画面に反映されないバグ修正
    //
    // バグの原因:
    //   getAssign() は massign[siteId_ym] → 過去12ヶ月分の massign → assign[siteId]
    //   の順で参照する。massign に既存データがあると assign の更新が表示されない。
    //
    // 修正方針:
    //   1. assign[siteId] を更新（デフォルト・未来月用）
    //   2. massign[siteId_ym] も更新（現在表示中の月の override として確実に反映）
    //   ym が指定されている場合のみ massign を更新する（後方互換）
    //
    // workerIds / subconIds はそれぞれ undefined 可（指定なしの side は変更しない）
    if (action === 'saveAssign') {
      const { siteId, ym, workerIds, subconIds } = body
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      // Read current to preserve unspecified sides (workers or subcons)
      const snap = await getDoc(docRef)
      const current = snap.exists() ? snap.data() : {}

      // (1) assign[siteId] を更新
      const currentAssign = (current.assign || {})[siteId] || {}
      const nextAssign: Record<string, unknown> = { ...currentAssign }
      if (Array.isArray(workerIds)) nextAssign.workers = workerIds
      if (Array.isArray(subconIds)) nextAssign.subcons = subconIds

      const updatePayload: Record<string, unknown> = {
        assign: { [siteId]: nextAssign }
      }

      // (2) ym 指定があれば massign[siteId_ym] も更新（現在月の override を確実に反映）
      if (ym && typeof ym === 'string' && /^\d{6}$/.test(ym)) {
        const mk = `${siteId}_${ym}`
        const currentMassign = (current.massign || {})[mk] || {}
        const nextMassign: Record<string, unknown> = { ...currentMassign }
        if (Array.isArray(workerIds)) nextMassign.workers = workerIds
        if (Array.isArray(subconIds)) nextMassign.subcons = subconIds
        updatePayload.massign = { [mk]: nextMassign }
      }

      await setDoc(docRef, updatePayload, { merge: true })
      return NextResponse.json({ success: true })
    }

    // ── 承認系アクション ──
    // 後方互換: action: 'approve' / 'unapprove' は職長承認に対応する
    //   （旧クライアントが投げてくる場合のため残す。新UIは下記の専用アクションを使う）
    // 新アクション:
    //   approve_foreman   / unapprove_foreman : 職長による1次承認
    //   approve_final     / unapprove_final   : 最終承認 (admin/approver)

    if (action === 'approve' || action === 'approve_foreman') {
      const { siteId, ym, day, approvedBy } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      const { setForemanApprovalForDay } = await import('@/lib/attendance')
      await setForemanApprovalForDay(siteId, ym, day, approvedBy || 0)
      return NextResponse.json({ success: true })
    }

    if (action === 'unapprove' || action === 'unapprove_foreman') {
      const { siteId, ym, day } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      const { removeForemanApprovalForDay } = await import('@/lib/attendance')
      await removeForemanApprovalForDay(siteId, ym, day)
      return NextResponse.json({ success: true })
    }

    if (action === 'approve_final') {
      const { siteId, ym, day, approvedBy } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      // 「職長承認済み」を必須要件としてサーバ側でチェック（クライアントUIだけでなく二重に保護）
      const existing = await getApprovalForDay(siteId, ym, day)
      if (!existing?.foreman) {
        return NextResponse.json({ error: '職長承認が先に必要です' }, { status: 400 })
      }
      const { setFinalApprovalForDay } = await import('@/lib/attendance')
      await setFinalApprovalForDay(siteId, ym, day, approvedBy || 0)
      return NextResponse.json({ success: true })
    }

    if (action === 'unapprove_final') {
      const { siteId, ym, day } = body
      if (!siteId || !ym || !day) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      const { removeFinalApprovalForDay } = await import('@/lib/attendance')
      await removeFinalApprovalForDay(siteId, ym, day)
      return NextResponse.json({ success: true })
    }

    // Default: save attendance entry
    const { siteId, ym, workerId, day, entry, subconId, subconEntry } = body

    if (!siteId || !ym || !day) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', `att_${ym}`)

    if (workerId !== undefined && entry !== undefined) {
      const key = `${siteId}_${workerId}_${ym}_${String(day)}`

      // ベトナム人スタッフのガード: 「最初の入力はスタッフ本人から」を強制。
      // 既存エントリがない場合は admin/foreman からの新規作成を原則拒否。
      // 例外: 事後申請性ステータス (p:有給 / hk:帰国中 / w=0.6:現場都合休み) は許容。
      // クリア（削除）と既存エントリの修正は許可。
      if (entry && typeof entry === 'object') {
        try {
          const { canAdminEditEntry, detectMultiSiteConflict } = await import('@/lib/attendance')
          const main = await getMainData()
          const worker = main.workers.find(w => w.id === Number(workerId))
          if (worker) {
            const curSnap = await getDoc(docRef)
            const curD = (curSnap.exists() ? curSnap.data().d : {}) as Record<string, AttendanceEntry>
            const existing = curD?.[key]
            // 事後申請性ステータス（有給/帰国中/現場都合休み w=0.6）は ガード例外許容のため newEntry を渡す
            // ※ 2026-06-XX: w=0.6 (補償日) を例外に追加（lib/attendance.ts canAdminEditEntry 参照）
            const check = canAdminEditEntry({ visa: worker.visa }, existing, entry as AttendanceEntry)
            if (!check.editable) {
              return NextResponse.json({ error: check.reason || '編集不可' }, { status: 403 })
            }
            // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
            const conflict = detectMultiSiteConflict(curD, siteId, Number(workerId), ym, Number(day), main.sites)
            if (conflict) {
              const cName = main.sites.find(s => s.id === conflict.conflictSiteId)?.name || conflict.conflictSiteId
              const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
              return NextResponse.json({
                error: `既に「${cName}」（${shiftLabel}）で同日の出面が登録されています。先にそちらを取り消すか別現場のエントリを削除してください。`,
                conflictSiteId: conflict.conflictSiteId,
              }, { status: 409 })
            }
          }
        } catch (e) {
          // ⚠️ fail-closed: ガード判定に失敗したら拒否する（fail-open は本ガードの趣旨に反する）。
          //   2026-05-08 修正。判定経路で Firestore 一時障害等が起きても、ベトナム人スタッフ本人入力を
          //   先行させるルールを破らない。
          console.error('Vietnamese-worker guard error:', e)
          return NextResponse.json({ error: 'ガード判定に失敗しました（一時的な障害の可能性）' }, { status: 503 })
        }
      }

      if (entry && typeof entry === 'object') {
        // ⚠️ 空オブジェクト {} は禁止（既存エントリを空マップに置換すると 2026-05-07 事故の同種パターン）。
        //   有効なエントリであることを保証してから保存。
        if (Object.keys(entry).length === 0) {
          return NextResponse.json({ error: 'Empty entry rejected' }, { status: 400 })
        }
        // 有効なエントリ: ソース情報を付与して保存
        // ⚠️ 2026-05-09 根本原因対処: ステータス変更時の残骸を消すため
        //   setAttendanceEntry + computeAttendanceDeleteFields 経由で書き込む。
        //   旧コードは setDoc(merge:true) で残骸が残っていた。
        const entryWithSource = { ...entry, s: 'admin' } as AttendanceEntry
        const { setAttendanceEntry, computeAttendanceDeleteFields } = await import('@/lib/attendance')
        const deleteFields = computeAttendanceDeleteFields(entryWithSource)
        await setAttendanceEntry(siteId, Number(workerId), ym, Number(day), entryWithSource, { deleteFields })

        // ⚠️ 2026-05-11 追加: 追跡可能性向上のため admin の出面書き込みを Activity log に記録
        //   政仁さんの「4月後付けPL消失」事案でログ無しで原因追跡できなかったため。
        try {
          const { logActivity } = await import('@/lib/activity')
          const status = entryWithSource.p ? '有給'
            : entryWithSource.r ? '欠勤'
            : entryWithSource.h ? '現場休'
            : entryWithSource.hk ? '帰国中'
            : entryWithSource.exam ? '試験'
            : entryWithSource.w ? (entryWithSource.o ? `出勤+${entryWithSource.o}h` : '出勤')
            : '不在'
          await logActivity(
            'admin',
            'attendance.gridEdit',
            `${siteId}/wid:${workerId} ${ym}/${day} → ${status}`,
          )
        } catch { /* ログ失敗は本体処理に影響させない */ }
      } else {
        // nullまたは無効なエントリ: フィールドを削除
        const { deleteField } = await import('firebase/firestore')
        const { updateDoc } = await import('firebase/firestore')
        await updateDoc(docRef, { [`d.${key}`]: deleteField() })
        try {
          const { logActivity } = await import('@/lib/activity')
          await logActivity(
            'admin',
            'attendance.gridDelete',
            `${siteId}/wid:${workerId} ${ym}/${day} を削除`,
          )
        } catch { /* ignore */ }
      }
    }

    if (subconId !== undefined && subconEntry !== undefined) {
      const key = `${siteId}_${subconId}_${ym}_${String(day)}`
      if (subconEntry && typeof subconEntry === 'object') {
        // ⚠️ 同上: 外注エントリも空マップ拒否
        if (Object.keys(subconEntry).length === 0) {
          return NextResponse.json({ error: 'Empty subcon entry rejected' }, { status: 400 })
        }
        await setDoc(docRef, { sd: { [key]: subconEntry } }, { merge: true })
      } else {
        const { deleteField, updateDoc } = await import('firebase/firestore')
        await updateDoc(docRef, { [`sd.${key}`]: deleteField() })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Grid POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
