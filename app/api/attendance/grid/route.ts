import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, getAssign } from '@/lib/compute'
import { getApprovalForDay } from '@/lib/attendance'
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
    const main = await getMainData()
    const att = await getAttData(ym)

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

    const workers = main.workers
      .filter(w => filteredWorkerIds.includes(w.id) && !w.retired)
      .map(w => ({
        id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
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

    // Approval status per day（2段階承認対応）
    // foremanApprovals: 職長による1次承認
    // finalApprovals:   admin/approver による最終承認
    // approvals:        後方互換用（旧コードが foreman 承認の有無を見るための bool マップ）
    const approvals: Record<number, boolean> = {}
    const foremanApprovals: Record<number, { by: number; at: string }> = {}
    const finalApprovals: Record<number, { by: number; at: string }> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const approvalKey = `${siteId}_${ym}_${String(d)}`
      const collectionApproval = await getApprovalForDay(siteId, ym, d)
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
    const allWorkers = main.workers
      .filter(w => !w.retired)
      .map(w => ({ id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job }))

    // foremanOverride: non-null only when mforeman actually overrides the default
    const foremanOverride = mf
      ? { name: foremanWorker?.name || '', note: mf.note || '' }
      : null

    // 帰国情報: 2つのソースから統合
    // 表示対象:
    //   ① 当月と帰国期間が重なるもの (帰国中扱い)
    //   ② 当月以降に予定されているもの (帰国予定扱い、最大6ヶ月先まで)
    const monthStart = `${String(y)}-${String(m).padStart(2, '0')}-01`
    const monthEnd = `${String(y)}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
    // 6ヶ月先を計算（YYYY-MM-DD）
    const horizonDate = new Date(y, m - 1 + 6, daysInMonth)
    const horizonEnd = `${horizonDate.getFullYear()}-${String(horizonDate.getMonth() + 1).padStart(2, '0')}-${String(horizonDate.getDate()).padStart(2, '0')}`
    const homeLeaves: { workerId: number; workerName: string; startDate: string; endDate: string; reason: string; status: string }[] = []
    const seenKeys = new Set<string>()

    // 表示対象判定:
    //   - 既に終了したものは除外 (endDate < monthStart)
    //   - 6ヶ月以上先に始まるものは除外 (startDate > horizonEnd)
    //   - それ以外（当月重なり or 直近の予定）は表示
    const isInScope = (startDate: string, endDate: string) => {
      if (!startDate || !endDate) return false
      if (endDate < monthStart) return false
      if (startDate > horizonEnd) return false
      return true
    }

    try {
      // ① スマホ申請（homeLongLeaveコレクション）
      const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
      hlSnap.forEach(d => {
        const hl = d.data()
        if (hl.status !== 'approved' && hl.status !== 'foreman_approved') return
        if (!isInScope(hl.startDate, hl.endDate)) return
        const key = `${hl.workerId}_${hl.startDate}`
        seenKeys.add(key)
        homeLeaves.push({
          workerId: hl.workerId,
          workerName: hl.workerName,
          startDate: hl.startDate,
          endDate: hl.endDate,
          reason: hl.reason || '一時帰国',
          status: hl.status,
        })
      })
    } catch (e) {
      console.warn('homeLongLeave fetch skipped:', e)
    }

    // ② 手動登録（demmen/main の homeLeaves 配列）
    try {
      const mainDocSnap = await getDoc(doc(db, 'demmen', 'main'))
      if (mainDocSnap.exists()) {
        const manualHomeLeaves: { id?: string; workerId: number; workerName: string; startDate: string; endDate: string; reason?: string }[] =
          mainDocSnap.data().homeLeaves || []
        for (const mhl of manualHomeLeaves) {
          if (!isInScope(mhl.startDate, mhl.endDate)) continue
          const key = `${mhl.workerId}_${mhl.startDate}`
          if (seenKeys.has(key)) continue
          homeLeaves.push({
            workerId: mhl.workerId,
            workerName: mhl.workerName,
            startDate: mhl.startDate,
            endDate: mhl.endDate,
            reason: mhl.reason || '一時帰国',
            status: 'approved',
          })
        }
      }
    } catch (e) {
      console.warn('homeLeaves from main fetch skipped:', e)
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
      sites: main.sites.map(s => ({ id: s.id, name: s.name, archived: s.archived })),
      calendarDays,
      homeLeaves,
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

    // Action: save assignments
    if (action === 'saveAssign') {
      const { siteId, workerIds } = body
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      // Read current assign to preserve subcons
      const snap = await getDoc(docRef)
      const current = snap.exists() ? snap.data() : {}
      const currentAssign = (current.assign || {})[siteId] || {}
      await setDoc(docRef, {
        assign: {
          [siteId]: {
            ...currentAssign,
            workers: workerIds || [],
          }
        }
      }, { merge: true })
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
      // 既存エントリがない場合は admin/foreman からの新規作成を拒否。
      // クリア（削除）と既存エントリの修正は許可。
      if (entry && typeof entry === 'object') {
        try {
          const { canAdminEditEntry } = await import('@/lib/attendance')
          const main = await getMainData()
          const worker = main.workers.find(w => w.id === Number(workerId))
          if (worker) {
            const curSnap = await getDoc(docRef)
            const curD = (curSnap.exists() ? curSnap.data().d : {}) as Record<string, unknown>
            const existing = curD?.[key] as AttendanceEntry | undefined
            const check = canAdminEditEntry({ visa: worker.visa }, existing)
            if (!check.editable) {
              return NextResponse.json({ error: check.reason || '編集不可' }, { status: 403 })
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
        const entryWithSource = { ...entry, s: 'admin' }
        await setDoc(docRef, { d: { [key]: entryWithSource } }, { merge: true })
      } else {
        // nullまたは無効なエントリ: フィールドを削除
        const { deleteField } = await import('firebase/firestore')
        const { updateDoc } = await import('firebase/firestore')
        await updateDoc(docRef, { [`d.${key}`]: deleteField() })
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
