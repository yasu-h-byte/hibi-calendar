import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiRole, isManagerRole } from '@/lib/auth'
import {
  orderSitesWithWorkTypes, isWorkTypeSite, workTypeSitesOf, parentAndWorkTypeSiteIds,
  findWorkTypeDuplicates, planDayWorkTypeMoves, type WorkTypeDuplicate,
} from '@/lib/site-hierarchy'
import { getMainData, getAttData, getAssign, invalidateAttDataCache } from '@/lib/compute'
import { getApprovalForDay } from '@/lib/attendance'
import { isStillActiveForMonth } from '@/lib/workers'
import { AttendanceEntry, DayType } from '@/types'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from '@/lib/fsdb'

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
    // 運転記録: att_ドキュメントの drv マップ（`${siteId}_${ym}_${day}` → {am,pm}）から
    // この現場の分だけ day キーに直して返す
    const driversForSite: Record<number, { am: number[]; pm: number[] }> = {}
    for (const [k, v] of Object.entries((att as { drv?: Record<string, { am?: number[]; pm?: number[] }> }).drv || {})) {
      const prefix = `${siteId}_${ym}_`
      if (!k.startsWith(prefix)) continue
      const day = Number(k.slice(prefix.length))
      if (Number.isFinite(day)) driversForSite[day] = { am: v.am || [], pm: v.pm || [] }
    }

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
        canDrive: (w as { canDrive?: boolean }).canDrive,
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

    // ── 工種サイト（鉄骨・仮設など単価が違う工事の出し分け・2026-09-25）──
    //   親現場に非アーカイブの工種サイトがある場合だけ、配置（誰が働くか）は親のものを
    //   使ったまま、入力済みエントリは「親 + 工種サイト」の全 id を合わせて見せる（union）。
    //   同一リクエスト内で既に読んだ att ドキュメント（att.d / att.sd）だけで組み立てるので
    //   追加の Firestore 読み取りは発生しない。工種の無い現場・工種サイト自体を選んだ場合は
    //   このブロックが丸ごとスキップされ、これまでと完全に同じ挙動になる。
    const workTypeChildren = isWorkTypeSite(site)
      ? []
      : workTypeSitesOf(main.sites, siteId).filter(s => !s.archived)
    let workTypeSites: { id: string; name: string; workType: string }[] = []
    let defaultWorkType: Record<string, string> = {}
    let defaultWorkTypeSubcon: Record<string, string> = {}
    /** その月の日ごとの工種指定（day（文字列）→ 工種サイト id）。日の指定 > 作業員の既定 > 親 */
    let dayWorkType: Record<string, string> = {}
    const entrySiteByWorkerDay: Record<string, Record<number, string>> = {}
    const entrySiteBySubconDay: Record<string, Record<number, string>> = {}
    let workTypeDuplicates: WorkTypeDuplicate[] = []

    if (workTypeChildren.length > 0) {
      workTypeSites = workTypeChildren.map(s => ({ id: s.id, name: s.name, workType: s.workType || s.name }))
      const allIds = parentAndWorkTypeSiteIds(main.sites, siteId)
      dayWorkType = { ...(main.assign[siteId]?.dayWorkType?.[ym] || {}) }
      defaultWorkType = { ...(main.assign[siteId]?.defaultWorkType || {}) }
      defaultWorkTypeSubcon = { ...(main.assign[siteId]?.defaultWorkTypeSubcon || {}) }

      // 配置は「親現場の配置」を主に使うが、工種を後から足した現場では工種サイト側だけに
      // 配置済みの作業員・外注がいることがある（移行ギャップの対策）。取りこぼさないよう
      // 各工種サイトの配置も合わせる（main は既に取得済みなので追加読み取りにはならない）
      const mergedWorkerIds = new Set<number>(filteredWorkerIds)
      const mergedSubconIds = new Set<string>(subconIds)
      for (const child of workTypeChildren) {
        const cAssign = getAssign(main, child.id, ym)
        for (const wid of cAssign.workers) mergedWorkerIds.add(wid)
        for (const sid of cAssign.subcons) mergedSubconIds.add(sid)
      }

      const existingWorkerIdSet = new Set(workers.map(w => w.id))
      for (const w of main.workers) {
        if (!mergedWorkerIds.has(w.id) || existingWorkerIdSet.has(w.id)) continue
        if (!isStillActiveForMonth(w.retired, ym)) continue
        workers.push({
          id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
          retired: w.retired || undefined,
          useOldRules: (w as { useOldRules?: boolean }).useOldRules || undefined,
          canDrive: (w as { canDrive?: boolean }).canDrive,
        })
        workerEntries[w.id] = {}
      }
      const existingSubconIdSet = new Set(subcons.map(sc => sc.id))
      for (const sc of main.subcons) {
        if (!mergedSubconIds.has(sc.id) || existingSubconIdSet.has(sc.id)) continue
        subcons.push({ id: sc.id, name: sc.name, type: sc.type })
        subconEntries[sc.id] = {}
      }

      // union: 各 worker/subcon の各日について、親 + 工種サイトのどれかにエントリがあれば
      // 採用する（複数の id に入っていれば workTypeDuplicates で別途フラグを立てる。
      // 代表値は allIds の並び＝親→工種の順で最初に見つかったもの）。
      // ⚠️ ここより前の「親現場だけの初期スキャン」で workerEntries[w.id] が
      //   既に埋まっている日もあるが、それがどの id 由来か（=親現場）を
      //   entrySiteByWorkerDay に残す必要があるため、att.d を直接見て作り直す
      //   （読み取りは増えない。既に取得済みの att をメモリ上でなぞるだけ）。
      for (const w of workers) {
        const perDay: Record<number, string> = {}
        for (let d = 1; d <= daysInMonth; d++) {
          for (const sid of allIds) {
            const key = `${sid}_${w.id}_${ym}_${String(d)}`
            if (att.d[key]) {
              workerEntries[w.id][d] = att.d[key]
              perDay[d] = sid
              break
            }
          }
        }
        entrySiteByWorkerDay[String(w.id)] = perDay
      }
      for (const sc of subcons) {
        const perDay: Record<number, string> = {}
        for (let d = 1; d <= daysInMonth; d++) {
          for (const sid of allIds) {
            const key = `${sid}_${sc.id}_${ym}_${String(d)}`
            if (att.sd[key]) {
              subconEntries[sc.id][d] = att.sd[key]
              perDay[d] = sid
              break
            }
          }
        }
        entrySiteBySubconDay[sc.id] = perDay
      }

      workTypeDuplicates = [
        ...findWorkTypeDuplicates(att.d, allIds, ym, 'worker'),
        ...findWorkTypeDuplicates(att.sd, allIds, ym, 'subcon'),
      ]
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
    //   工種サイトは親現場のカレンダーを使う（2026-09-15）
    const { calendarSiteIdOf } = await import('@/lib/site-hierarchy')
    const calYm = `${String(y)}-${String(m).padStart(2, '0')}`
    const calDocId = `${calendarSiteIdOf(main.sites, siteId)}_${calYm}`
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
    // 2026-09-15: 取引先マスタ化。元請・一次だけの会社は外注として配置できないので出さない
    //   （既に配置済みの会社は外せるように残す）
    const { canBorrowFrom } = await import('@/lib/companies')
    const assignedScIds = new Set<string>(subconIds || [])
    const allSubcons = (main.subcons || [])
      .filter(sc => canBorrowFrom(sc as { id: string; name: string; roles?: string[] }) || assignedScIds.has(sc.id))
      .map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

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
      site: { id: site.id, name: site.name, workType: site.workType || undefined, foreman: effectiveForeman, foremanName, foremanNote },
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
      // 夜勤が発生した日（台風待機など）。この日だけスタッフのセルに夜勤バッジが出る
      nightDays: main.nightDays?.[`${siteId}_${ym}`] || [],
      // 運転記録（day → {am,pm}）。運転手当（2026-10施行）の元データ
      drivers: driversForSite,
      allWorkers,
      allSubcons,
      // 工種サイトは親現場の直後に並べる（2026-09-15）
      sites: orderSitesWithWorkTypes(main.sites).map(s => ({ id: s.id, name: s.name, archived: s.archived, parentId: s.parentId })),
      calendarDays,
      homeLeaves,
      // 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25）。
      // workTypeSites が空 = この現場には工種が無い（今までどおりの画面のまま）
      workTypeSites,
      dayWorkType,
      defaultWorkType,
      defaultWorkTypeSubcon,
      entrySiteByWorkerDay,
      entrySiteBySubconDay,
      workTypeDuplicates,
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

    const { doc, setDoc, getDoc } = await import('@/lib/fsdb')
    const { db } = await import('@/lib/firebase')

    // ⚠️ 担当現場チェック（2026-09-15 追加）
    //   職長承認・出面保存は「担当現場の職長」に限る。UI だけの制限で API 直叩きなら他現場を
    //   承認・上書きできた。個人パスワードの職長のみ判定可（共通パスワード経由は識別不可で従来どおり）。
    //   詳細・限界は lib/attendance-authz.ts。main は 30秒キャッシュ経由（読み取り回数を増やさない）
    {
      const { isForemanScopedGridAction, checkGridForemanScope } = await import('@/lib/attendance-authz')
      if (isForemanScopedGridAction(action)) {
        const scope = await checkGridForemanScope(request, await getMainData(), body.siteId, body.ym)
        if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })
      }
    }

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

    // ⚠️ 有給残数チェック（2026-08-04 追加 / グエン ミン トゥアン事案）
    //   出面へ有給(p)を直接入力する経路には残数チェックが一切なく、当期17日枠に対し
    //   21日が消化された（うち11日がこの経路からの直接入力）。申請経路だけ塞いでも
    //   ここから同じことが起きるため、書き込みの入口で必ず残数を見る。
    //
    //   方針は「警告付き上書き」: 超過する入力は既定で拒否するが、前借り等の正当な
    //   運用を止めないよう allowOverdraft:true で明示的に上書きできる。
    //   上書きした場合は誰がいつ超過させたかを activityLog に必ず残す。
    if (isAttendanceWriteAction && body.entry?.p && body.workerId !== undefined && body.ym && body.day) {
      const targetDate = `${body.ym.slice(0, 4)}-${body.ym.slice(4, 6)}-${String(body.day).padStart(2, '0')}`
      const { getLeaveBalance } = await import('@/lib/leave-balance')
      // その日自身の p は除外して数える（同じ日を編集し直したときの二重計上を防ぐ）
      const bal = await getLeaveBalance(Number(body.workerId), targetDate, targetDate)

      if (bal.remaining < 1 && !body.allowOverdraft) {
        const main = await getMainData()
        const wName = main.workers.find(ww => ww.id === Number(body.workerId))?.name || `ID:${body.workerId}`
        return NextResponse.json({
          error: bal.noGrant
            ? `${wName} さんは有給が付与されていません（付与レコードなし）`
            : `${wName} さんの有給残は 0 日です（枠 ${bal.total}日 / 消化 ${bal.used}日）`,
          code: 'LEAVE_OVERDRAFT',
          balance: bal,
          workerName: wName,
        }, { status: 409 })
      }

      if (bal.remaining < 1 && body.allowOverdraft) {
        const main = await getMainData()
        const wName = main.workers.find(ww => ww.id === Number(body.workerId))?.name || `ID:${body.workerId}`
        const { logActivity } = await import('@/lib/activity')
        await logActivity('admin', 'leave.overdraft',
          `${wName} ${targetDate} 有給を残数超過で登録（枠 ${bal.total}日 / 消化 ${bal.used}日）`)
      }

      // ── 退職日・稼働日ガード（2026-09-02 追加・有給総点検 第4回）──
      //   申請・スタッフ・職長経路にはあるのに PC グリッドだけ無く、日曜・所定休や退職後の日に
      //   p を置くと「20日枠超の有給日給」が過払いになっていた（2026-06 社労士対応の取り残し）。
      //   管理者用の画面なので、非稼働日は確認つきで上書き可（activityLog に残す）。退職後は不可。
      {
        const main = await getMainData()
        const w = main.workers.find(ww => ww.id === Number(body.workerId))
        const wName = w?.name || `ID:${body.workerId}`
        if (w?.retired && targetDate > w.retired) {
          return NextResponse.json({
            error: `${wName} さんは ${w.retired} で退職済みのため、それ以降の日に有給は登録できません`,
            code: 'RETIRED',
          }, { status: 409 })
        }
        const { isScheduledWorkDay } = await import('@/lib/attendance')
        if (body.siteId && !await isScheduledWorkDay(String(body.siteId), targetDate)) {
          if (!body.allowNonWorkingDay) {
            return NextResponse.json({
              error: `${targetDate} は現場カレンダーの非稼働日です（休日・所定休に有給を入れると有給日給の過払いになります）`,
              code: 'NON_WORKING_DAY',
              workerName: wName,
            }, { status: 409 })
          }
          const { logActivity } = await import('@/lib/activity')
          await logActivity('admin', 'leave.nonWorkingDay', `${wName} ${targetDate} 非稼働日に有給を登録（確認のうえ上書き）`)
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

    // Action: 夜勤が発生した日の指定（台風待機など）
    //
    //   nightDays[siteId_ym] = [11, 12] のように日のリストを持つ。指定された日だけ
    //   出面画面のセルに夜勤バッジが出る。誰が夜勤したかはエントリ側の ns が持つので、
    //   ここは入力対象日を絞るためのUIフィルタでしかない（給与計算・所定日数に影響しない）。
    //
    //   ⚠️ 空配列を書くケースがあるが、これは top-level field `nightDays` の
    //      子フィールド（配列）の置換であり、マップを空にする 2026-05-07 事故の
    //      パターンには当たらない（配列は要素の追加削除が正常な操作）。
    if (action === 'saveNightDays') {
      const { ym: nym, siteId: nsid, days } = body
      if (!nym || !nsid) return NextResponse.json({ error: 'ym and siteId required' }, { status: 400 })
      if (!Array.isArray(days) || days.some(d => !Number.isInteger(d) || d < 1 || d > 31)) {
        return NextResponse.json({ error: '日の指定が不正です' }, { status: 400 })
      }
      const sorted = Array.from(new Set(days as number[])).sort((a, b) => a - b)
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, { nightDays: { [`${nsid}_${nym}`]: sorted } }, { merge: true })
      try {
        const { logActivity } = await import('@/lib/activity')
        await logActivity('admin', 'attendance.nightDays', `${nsid}/${nym} 夜勤日 → [${sorted.join(',')}]`)
      } catch { /* ログ失敗は本体処理に影響させない */ }
      return NextResponse.json({ success: true, nightDays: sorted })
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
    if (action === 'saveDrivers') {
      // 便ごとの運転者を保存。`drv.<siteId>_<ym>_<day>` へのドット記法更新なので
      // 他の日・他の現場のキーには触れない（Firestore安全ルール準拠）
      const { ym: dym, siteId: dsid, day, am, pm } = body
      if (!dym || !dsid || !day) return NextResponse.json({ error: 'ym, siteId, day required' }, { status: 400 })
      // 2026-08-27 追加（給与総点検）: 入力検証と月次ロックガード。
      //   運転記録は運転手当（給与）の元データなのに、ロックチェックの対象外だった。
      //   締め済み月の drv を書き換えると確定済み給与の運転手当が黙って変わるため、
      //   出面エントリ保存と同じく締め済み月は拒否する
      const dayNum = Number(day)
      if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) {
        return NextResponse.json({ error: 'day は 1〜31 で指定してください' }, { status: 400 })
      }
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const lockErr = await checkMonthLocked(String(dym))
        if (lockErr) return NextResponse.json({ error: `${lockErr}（運転記録は運転手当の元データのため、締め済み月は変更できません）` }, { status: 409 })
      }
      const clean = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isFinite))] : []
      const amIds = clean(am); const pmIds = clean(pm)
      const key = `drv.${dsid}_${dym}_${Number(day)}`
      const { doc, updateDoc, deleteField } = await import('@/lib/fsdb')
      const { ensureDocExists } = await import('@/lib/firestore-safe')
      const attRef = doc(db, 'demmen', `att_${dym}`)
      await ensureDocExists(attRef)
      if (amIds.length === 0 && pmIds.length === 0) {
        await updateDoc(attRef, { [key]: deleteField() })
      } else {
        await updateDoc(attRef, { [key]: { am: amIds, pm: pmIds } })
      }
      const { logActivity } = await import('@/lib/activity')
      await logActivity('admin', 'attendance.drivers', `${dsid}/${dym}/${day}日 運転者: 行き[${amIds.join(',')}] 帰り[${pmIds.join(',')}]`)
      return NextResponse.json({ success: true })
    }

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

    // Action: 工種の既定を保存（2026-09-25・鉄骨/仮設など単価が違う工種の出し分け）
    //
    //   作業員（または外注先）ごとに「新しく入力した日はどの工種サイトに保存するか」の
    //   既定を、親現場の assign[siteId] の下に持つ。saveAssign（配置の保存）はこのキーを
    //   spread で保持するので基本的には壊れないが、それとは無関係に単独でも安全に更新
    //   できるよう、ここでは assign.{siteId}.defaultWorkType.{workerId} のような
    //   ドット記法の狭い更新にする（Firestore 書き込みの安全ルール）。
    if (action === 'saveDefaultWorkType') {
      const { siteId: parentSiteId, workerId: dwtWorkerId, subconId: dwtSubconId, workTypeSiteId } = body
      if (!parentSiteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
      if (dwtWorkerId === undefined && dwtSubconId === undefined) {
        return NextResponse.json({ error: 'workerId または subconId が必要です' }, { status: 400 })
      }
      const main = await getMainData()
      const children = workTypeSitesOf(main.sites, parentSiteId).filter(s => !s.archived)
      if (children.length === 0) {
        return NextResponse.json({ error: 'この現場には工種がありません' }, { status: 400 })
      }
      if (workTypeSiteId && !children.some(c => c.id === workTypeSiteId)) {
        return NextResponse.json({ error: '指定した工種が見つかりません' }, { status: 400 })
      }
      const { updateDoc, deleteField } = await import('@/lib/fsdb')
      const { ensureDocExists } = await import('@/lib/firestore-safe')
      const mainRef = doc(db, 'demmen', 'main')
      await ensureDocExists(mainRef)
      const field = dwtWorkerId !== undefined
        ? `assign.${parentSiteId}.defaultWorkType.${dwtWorkerId}`
        : `assign.${parentSiteId}.defaultWorkTypeSubcon.${dwtSubconId}`
      // workTypeSiteId が無ければ「親現場に戻す」= マップから削除（既定=親、という従来の状態）
      await updateDoc(mainRef, { [field]: workTypeSiteId || deleteField() })
      return NextResponse.json({ success: true })
    }

    // Action: 日ごとの工種指定（2026-09-25・社長「鉄骨は毎日あるとは限らない」）
    //
    //   「26〜30日は鉄骨工事」のように、日付単位（複数日も可）で工種を決める。
    //   1) assign.{親}.dayWorkType.{ym}.{day} に工種サイト id を保存（親に戻すなら deleteField）
    //      → その日の新しい入力はここに保存される（作業員の既定より優先）
    //   2) その日に既に入っている全員（作業員・外注）のエントリを、同じ工種へまとめて移動
    //      （lib/site-hierarchy.ts planDayWorkTypeMoves。2箇所に入っている人は移さず報告）
    //   出面ドキュメントは1回読み・1回書き（同一リクエストで二度読まない）。
    if (action === 'setDayWorkType') {
      const { siteId: parentSiteId, ym: sdwYm, toSiteId } = body
      const daysRaw: unknown[] = Array.isArray(body.days) ? body.days : [body.day]
      const days: number[] = Array.from(new Set(daysRaw.map(v => Number(v))))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 31)
        .sort((a, b) => a - b)
      if (!parentSiteId || !sdwYm || !toSiteId || days.length === 0) {
        return NextResponse.json({ error: 'siteId, ym, days, toSiteId は必須です' }, { status: 400 })
      }
      const { checkMonthLocked } = await import('@/lib/locks')
      const lockErr = await checkMonthLocked(String(sdwYm))
      if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })

      const main = await getMainData()
      const children = workTypeSitesOf(main.sites, parentSiteId).filter(s => !s.archived)
      if (children.length === 0) {
        return NextResponse.json({ error: 'この現場には工種がありません' }, { status: 400 })
      }
      const allIds = [parentSiteId, ...children.map(c => c.id)]
      if (!allIds.includes(toSiteId)) {
        return NextResponse.json({ error: '指定した工種が見つかりません' }, { status: 400 })
      }
      const toParent = toSiteId === parentSiteId

      const attData = await getAttData(String(sdwYm))
      const { updateDoc, deleteField } = await import('@/lib/fsdb')
      const { ensureDocExists } = await import('@/lib/firestore-safe')

      const attUpdates: Record<string, unknown> = {}
      const mainUpdates: Record<string, unknown> = {}
      const skipped: { kind: 'worker' | 'subcon'; id: string; name: string; day: number }[] = []
      let moved = 0
      for (const day of days) {
        mainUpdates[`assign.${parentSiteId}.dayWorkType.${sdwYm}.${day}`] = toParent ? deleteField() : toSiteId
        const plan = planDayWorkTypeMoves(attData.d, attData.sd, allIds, String(sdwYm), day, toSiteId)
        for (const m of plan.moves) {
          const map = m.kind === 'worker' ? 'd' : 'sd'
          const src = m.kind === 'worker' ? attData.d[m.fromKey] : attData.sd[m.fromKey]
          if (!src || Object.keys(src).length === 0) continue   // 空マップは書かない（安全ルール）
          attUpdates[`${map}.${m.toKey}`] = src
          attUpdates[`${map}.${m.fromKey}`] = deleteField()
          moved++
        }
        for (const s of plan.skipped) {
          const name = s.kind === 'worker'
            ? main.workers.find(w => String(w.id) === s.id)?.name || `ID:${s.id}`
            : main.subcons.find(sc => sc.id === s.id)?.name || s.id
          skipped.push({ kind: s.kind, id: s.id, name, day })
        }
      }

      const mainRef = doc(db, 'demmen', 'main')
      await ensureDocExists(mainRef)
      await updateDoc(mainRef, mainUpdates)
      if (Object.keys(attUpdates).length > 0) {
        const attRef = doc(db, 'demmen', `att_${sdwYm}`)
        await ensureDocExists(attRef)
        await updateDoc(attRef, attUpdates)
        invalidateAttDataCache(String(sdwYm))
      }
      try {
        const { logActivity } = await import('@/lib/activity')
        const label = toParent ? '親現場' : (children.find(c => c.id === toSiteId)?.workType || toSiteId)
        await logActivity('admin', 'attendance.setDayWorkType',
          `${parentSiteId} ${sdwYm} ${days.join(',')}日 → ${label}（${moved}件移動${skipped.length ? `・${skipped.length}件は重複のため未移動` : ''}）`)
      } catch { /* ログ失敗は本体処理に影響させない */ }
      return NextResponse.json({ success: true, days, toSiteId, moved, skipped })
    }

    // Action: 工種の切り替え（2026-09-25）
    //
    //   1日分の出面エントリを、親現場 ⇄ 工種サイトの間で「移動」する。
    //   lib/attendance.ts の setAttendanceEntry + computeAttendanceDeleteFields で
    //   移動先へ書き込み、移動元は d.{key}（外注なら sd.{key}）を deleteField で消す
    //   （app/api/attendance/foreman/route.ts の fix_site と同じ考え方）。
    //   重複（同じ人・同じ日が既に2箇所に入っている）はクライアント側の事前チェックだけに
    //   頼らず、ここでも必ず拒否する。
    if (action === 'moveWorkType') {
      const {
        siteId: parentSiteId, ym: mwtYm, day: mwtDay,
        workerId: mwtWorkerId, subconId: mwtSubconId, toSiteId,
      } = body
      if (!parentSiteId || !mwtYm || !mwtDay || !toSiteId || (mwtWorkerId === undefined && mwtSubconId === undefined)) {
        return NextResponse.json({ error: 'siteId, ym, day, workerId/subconId, toSiteId は必須です' }, { status: 400 })
      }
      const { checkMonthLocked } = await import('@/lib/locks')
      const lockErr = await checkMonthLocked(String(mwtYm))
      if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })

      const main = await getMainData()
      const children = workTypeSitesOf(main.sites, parentSiteId).filter(s => !s.archived)
      const allowedIds = new Set([parentSiteId, ...children.map(c => c.id)])
      if (!allowedIds.has(toSiteId)) {
        return NextResponse.json({ error: '移動先の工種が見つかりません' }, { status: 400 })
      }

      const mwtDayNum = Number(mwtDay)
      const attData = await getAttData(String(mwtYm))
      const { updateDoc, deleteField } = await import('@/lib/fsdb')
      const attRef = doc(db, 'demmen', `att_${mwtYm}`)

      if (mwtWorkerId !== undefined) {
        const wid = Number(mwtWorkerId)
        const foundSiteIds = Array.from(allowedIds).filter(sid => !!attData.d[`${sid}_${wid}_${mwtYm}_${mwtDayNum}`])
        if (foundSiteIds.length === 0) {
          return NextResponse.json({ error: '移動元のエントリが見つかりません' }, { status: 404 })
        }
        if (foundSiteIds.length > 1) {
          return NextResponse.json({ error: 'この日はすでに複数の工種に入力されています。先に重複を解消してください。' }, { status: 409 })
        }
        const fromSiteId = foundSiteIds[0]
        if (fromSiteId === toSiteId) {
          return NextResponse.json({ success: true, entry: attData.d[`${fromSiteId}_${wid}_${mwtYm}_${mwtDayNum}`] })
        }
        const toKey = `${toSiteId}_${wid}_${mwtYm}_${mwtDayNum}`
        if (attData.d[toKey]) {
          return NextResponse.json({ error: '移動先の工種に既にエントリがあります。先にそちらを確認してください。' }, { status: 409 })
        }
        const sourceEntry = attData.d[`${fromSiteId}_${wid}_${mwtYm}_${mwtDayNum}`] as AttendanceEntry
        const movedEntry: AttendanceEntry = { ...sourceEntry }
        const { computeAttendanceDeleteFields, setAttendanceEntry } = await import('@/lib/attendance')
        const deleteFields = computeAttendanceDeleteFields(movedEntry)
        await setAttendanceEntry(toSiteId, wid, String(mwtYm), mwtDayNum, movedEntry, { deleteFields })
        await updateDoc(attRef, { [`d.${fromSiteId}_${wid}_${mwtYm}_${mwtDayNum}`]: deleteField() })
        try {
          const { logActivity } = await import('@/lib/activity')
          const wname = main.workers.find(w => w.id === wid)?.name || `ID:${wid}`
          await logActivity('admin', 'attendance.moveWorkType', `${wname} ${mwtYm}/${mwtDayNum} 工種切替: ${fromSiteId} → ${toSiteId}`)
        } catch { /* ログ失敗は本体処理に影響させない */ }
        return NextResponse.json({ success: true, entry: movedEntry })
      }

      // 外注（subcon）の移動
      const scid = String(mwtSubconId)
      const foundSiteIds = Array.from(allowedIds).filter(sid => !!attData.sd[`${sid}_${scid}_${mwtYm}_${mwtDayNum}`])
      if (foundSiteIds.length === 0) {
        return NextResponse.json({ error: '移動元のエントリが見つかりません' }, { status: 404 })
      }
      if (foundSiteIds.length > 1) {
        return NextResponse.json({ error: 'この日はすでに複数の工種に入力されています。先に重複を解消してください。' }, { status: 409 })
      }
      const fromSiteId = foundSiteIds[0]
      if (fromSiteId === toSiteId) {
        return NextResponse.json({ success: true, entry: attData.sd[`${fromSiteId}_${scid}_${mwtYm}_${mwtDayNum}`] })
      }
      const toKey = `${toSiteId}_${scid}_${mwtYm}_${mwtDayNum}`
      if (attData.sd[toKey]) {
        return NextResponse.json({ error: '移動先の工種に既にエントリがあります。先にそちらを確認してください。' }, { status: 409 })
      }
      const sourceEntry = attData.sd[`${fromSiteId}_${scid}_${mwtYm}_${mwtDayNum}`]
      await updateDoc(attRef, { [`sd.${toKey}`]: sourceEntry })
      await updateDoc(attRef, { [`sd.${fromSiteId}_${scid}_${mwtYm}_${mwtDayNum}`]: deleteField() })
      try {
        const { logActivity } = await import('@/lib/activity')
        const scname = main.subcons.find(s => s.id === scid)?.name || scid
        await logActivity('admin', 'attendance.moveWorkType', `${scname}（外注） ${mwtYm}/${mwtDayNum} 工種切替: ${fromSiteId} → ${toSiteId}`)
      } catch { /* ログ失敗は本体処理に影響させない */ }
      return NextResponse.json({ success: true, entry: sourceEntry })
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
      // 最終承認は管理者・事業責任者のみ（職長は職長承認まで）。UI の canFinalize と一致させ、
      //   サーバ側でロール強制する（監査: checkApiAuth のみで事務・他現場職長が最終承認できた穴を塞ぐ）。
      const role = await getApiRole(request)
      if (!role || !isManagerRole(role.role)) {
        return NextResponse.json({ error: '最終承認の権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
      }
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
      // 最終承認の解除も管理者・事業責任者のみ
      const role = await getApiRole(request)
      if (!role || !isManagerRole(role.role)) {
        return NextResponse.json({ error: '最終承認解除の権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
      }
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
      // 2026-09-02 高速化: この後の履歴退避（prevEntry）と同じ doc を2度読みしていたので
      //   1回の読みを共有する（オートセーブは1セルごとに走るため塵も積もる）
      let sharedCurD: Record<string, AttendanceEntry> | null = null
      if (entry && typeof entry === 'object') {
        try {
          const { canAdminEditEntry, detectMultiSiteConflict } = await import('@/lib/attendance')
          const main = await getMainData()
          const worker = main.workers.find(w => w.id === Number(workerId))
          if (worker) {
            const curSnap = await getDoc(docRef)
            const curD = (curSnap.exists() ? curSnap.data().d : {}) as Record<string, AttendanceEntry>
            sharedCurD = curD
            const existing = curD?.[key]
            // 事後申請性ステータス（有給/帰国中/現場都合休み w=0.6）は ガード例外許容のため newEntry を渡す
            // ※ 2026-06-XX: w=0.6 (補償日) を例外に追加（lib/attendance.ts canAdminEditEntry 参照）
            const check = canAdminEditEntry({ visa: worker.visa }, existing, entry as AttendanceEntry)
            if (!check.editable) {
              return NextResponse.json({ error: check.reason || '編集不可' }, { status: 403 })
            }
            // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
            const conflict = detectMultiSiteConflict(curD, siteId, Number(workerId), ym, Number(day), main.sites,
              entry as AttendanceEntry)  // 合計人工判定（0.5+0.5 の2現場は許可・2026-08-31）
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

      // 2026-08-28 追加: 既存エントリを壊す前に中身を履歴へ退避する。
      //   操作ログには「削除した」事実しか残らず、日次バックアップは当日分を救えないため、
      //   誤削除・誤上書きからの復元手段がなかった（8/27 IHI の事故）。
      let prevEntry: AttendanceEntry | undefined
      try {
        if (sharedCurD) {
          prevEntry = sharedCurD[key]   // ガードで読んだ doc を共有（再読しない）
        } else {
          const prevSnap = await getDoc(docRef)
          const prevD = (prevSnap.exists() ? (prevSnap.data().d || {}) : {}) as Record<string, AttendanceEntry>
          prevEntry = prevD[key]
        }
      } catch { /* 読めなくても本体処理は続行（履歴が残らないだけ） */ }

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
        try {
          const { recordAttendanceChange } = await import('@/lib/attendance-history')
          await recordAttendanceChange({
            siteId, workerId: Number(workerId), ym, day, before: prevEntry, after: entryWithSource, actor: 'admin',
          })
        } catch { /* 履歴は保険。失敗しても本体は続行 */ }
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
            : entryWithSource.ns ? `${entryWithSource.nonly ? '夜勤のみ' : '日勤+夜勤'} ${entryWithSource.nst}-${entryWithSource.net}${entryWithSource.nnote ? `(${entryWithSource.nnote})` : ''}`
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
        try {
          const { recordAttendanceChange } = await import('@/lib/attendance-history')
          await recordAttendanceChange({
            siteId, workerId: Number(workerId), ym, day, before: prevEntry, after: null, actor: 'admin',
          })
        } catch { /* 履歴は保険。失敗しても本体は続行 */ }
        const { deleteField } = await import('@/lib/fsdb')
        const { updateDoc } = await import('@/lib/fsdb')
        await updateDoc(docRef, { [`d.${key}`]: deleteField() })
        // 有給を消した場合は次期レコードの繰越を追随再計算（2026-09-02）
        if ((prevEntry as { p?: number | boolean } | undefined)?.p) {
          try {
            const { recomputeNextCarryOver } = await import('@/lib/leave-carry')
            await recomputeNextCarryOver(Number(workerId), `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`)
          } catch (e) { console.warn('[grid] 繰越再計算に失敗:', e) }
        }
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
        const { deleteField, updateDoc } = await import('@/lib/fsdb')
        await updateDoc(docRef, { [`sd.${key}`]: deleteField() })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Grid POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
