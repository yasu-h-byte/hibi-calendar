import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken, mapRawWorkers, hourlyRateOn, isEmployedOn, findWorkerByToken } from '@/lib/workers'
import {
  getAttendanceDoc,
  getApprovalForDay,
  getEntryStatus,
  ymKey,
  attKey,
  formatDateJP,
  formatDateShort,
} from '@/lib/attendance'
import { attendanceDateError, dayApprovalOf, writeAttendanceEntry } from '@/lib/attendance-save'
import { getSites } from '@/lib/sites'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { calendarSiteIdOf, workTypeFamilyIds, familyEntrySiteId, staffEntryTarget, siteNeedsCalendar, type WorkTypeAssignMap } from '@/lib/site-hierarchy'
import { AttendanceEntry, SiteWorkSchedule, withDerivedOvertime } from '@/types'
import { recordAccess, getRequestIp } from '@/lib/accessLog'
import { calcLastUsableDayIso, isLeaveExpiredAsOf, todayJstIso, daysBetween, currentYmJst } from '@/lib/date-utils'
import { getAttData, parseDKey } from '@/lib/compute'
import { sitesOfWorkerForMonth } from '@/lib/roster'
import { isWorkDayOf } from '@/lib/attendance-missing'

export async function GET(request: NextRequest) {
  // auth: スタッフ本人のトークン（getWorkerByToken）
  const token = request.nextUrl.searchParams.get('token')
  const siteIdParam = request.nextUrl.searchParams.get('siteId')

  if (!token) {
    return NextResponse.json({ error: 'URL に必要な情報がありません。会社に連絡してください / Thiếu thông tin trong đường dẫn. Vui lòng liên hệ công ty' }, { status: 400 })
  }

  try {
    // ── 2026-09-02 高速化 ──
    //   main ドキュメント（約260KB）を getWorkerByToken / getStaffSites / getSites /
    //   siteNames / workSchedule がそれぞれ再読しており、読みだけで数秒かかっていた。
    //   1回だけ読んで全てをここから導出する（月初の「入力できない」障害の対処）。
    const mainSnapOnce = await getDoc(doc(db, 'demmen', 'main'))
    const mainRaw = (mainSnapOnce.exists() ? mainSnapOnce.data() : {}) as {
      workers?: unknown[]
      sites?: { id: string; name: string; archived?: boolean; workSchedule?: unknown; parentId?: string; workType?: string }[]
      assign?: Record<string, { workers?: number[]; defaultWorkType?: Record<string, string>; dayWorkType?: Record<string, Record<string, string>> }>
      massign?: Record<string, { workers?: number[] }>
    }
    const allWorkers = mapRawWorkers(mainRaw.workers || [])
    // 退職後は翌月末まで「見るだけ」（lib/workers.ts findWorkerByToken allowGrace・2026-10-02 総合点検）。書く側（POST）は在籍中だけ
    const worker = findWorkerByToken(allWorkers, token, { allowGrace: true })
    if (!worker) {
      return NextResponse.json({ error: 'この URL は無効です。会社に連絡してください / Đường dẫn không hợp lệ. Vui lòng liên hệ công ty' }, { status: 401 })
    }

    // アクセスログ記録（失敗しても処理は続行）
    recordAccess({
      workerId: worker.id,
      workerName: worker.name,
      role: 'staff',
      org: worker.company === 'HFU' ? 'hfu' : 'hibi',
      ip: getRequestIp(request),
    }).catch(() => {})

    // 配置現場。決まりは getAssign（lib/roster.ts・過去12か月の月別配置をさかのぼる）＝ PC の出面画面・職長の名簿と同じ
    //   2026-10-02 総合点検: 旧は `massign[当月] ?? assign` で、月別配置が古い月にしか無い人は最初の現場が食い違っていた
    const curYm0 = currentYmJst()
    const assignedSites = sitesOfWorkerForMonth(
      { sites: mainRaw.sites || [], assign: mainRaw.assign, massign: mainRaw.massign }, worker.id, curYm0,
    )
    // 2026-07-22: 現場未配置（新入社員が配置前にQRを開いた等）でも入口で弾かない。
    //   従来は「未配置かつ現場指定なし」で 404 'No site assigned' を返し、新入社員の
    //   QRが必ずエラーになっていた。配置済みスタッフも元々ドロップダウンで全現場を選べる
    //   ため、未配置でも同じく全現場から選んで使えるようにする（挙動を一貫させる）。
    //   未配置は unassigned フラグで画面に「現場を選んでください」を促す。
    const unassigned = assignedSites.length === 0

    // Get all active (non-archived) sites for the dropdown（main から導出）
    // 工種サイト（鉄骨など）は選択肢に出さない（2026-09-28 代表決定: 工種は本人に選ばせず、
    //   職長・政仁さんが出面画面で決める。保存先は POST で staffEntryTarget が決める）
    const allActiveSites = (mainRaw.sites || []).filter(s2 => !s2.archived && !s2.parentId)

    // Build availableSites: all active sites, with primary flag for assigned ones
    const assignedIds = new Set(assignedSites.map(s => s.id))
    const availableSites = allActiveSites.map(s => ({
      id: s.id,
      name: s.name,
      primary: assignedIds.has(s.id),
    }))
    // Sort: assigned sites first, then alphabetically
    availableSites.sort((a, b) => {
      if (a.primary && !b.primary) return -1
      if (!a.primary && b.primary) return 1
      return a.name.localeCompare(b.name, 'ja')
    })

    // 工種サイトの id が来ても親現場として扱う（古いブックマーク・以前の選択の残り）
    const rawSitesH = (mainRaw.sites || []) as import('@/lib/site-hierarchy').HierarchySite[]
    const siteIdRaw = siteIdParam || (assignedSites.length > 0 ? assignedSites[0].id : allActiveSites[0]?.id)
    const siteId = siteIdRaw ? calendarSiteIdOf(rawSitesH, siteIdRaw) : siteIdRaw
    // 同じ現場（親＋工種）のどこかに入っていれば、その現場の入力とみなす
    const family = siteId ? workTypeFamilyIds(rawSitesH, siteId) : []
    const site = availableSites.find(s => s.id === siteId) || availableSites[0]
    if (!site) {
      return NextResponse.json({ error: '選べる現場がありません。会社に連絡してください / Không có công trường để chọn. Vui lòng liên hệ công ty' }, { status: 404 })
    }

    // 2026-08-27 修正（休暇届総点検）: Vercel は UTC のため、JST 0〜9時に「今日」が
    //   前日になり、欠勤届の初期日付が前日を指して確定済み出勤を上書きし得た
    const { todayJstIso } = await import('@/lib/date-utils')
    const tIso = todayJstIso()
    const now = new Date(tIso + 'T00:00:00')  // 後続の期間計算も JST 当日基準
    const y = Number(tIso.slice(0, 4))
    const m = Number(tIso.slice(5, 7))
    const d = Number(tIso.slice(8, 10))
    const ym = ymKey(y, m)

    // Read attendance data（過去14日の窓が前月にかかる月初は、前月も並列で先読み）
    const prevMonthDate = new Date(y, m - 1, d - 14)
    const prevYmStr = ymKey(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1)
    const [attData, attPrevPre] = await Promise.all([
      getAttendanceDoc(ym),
      prevYmStr !== ym ? getAttendanceDoc(prevYmStr) : Promise.resolve(null),
    ])

    // Today's entry
    const todaySite = familyEntrySiteId(attData, family, worker.id, ym, d) || siteId
    const currentEntry = attData[attKey(todaySite, worker.id, ym, d)] || null

    // Past 5 days (with site name)
    const pastDays: {
      date: string; year: number; month: number; day: number
      entry: AttendanceEntry | null; status: ReturnType<typeof getEntryStatus>
      locked: boolean; dayOffset: number; siteName: string
    }[] = []
    // Build site name lookup + 現在現場の workSchedule 取得（main から導出・再読なし）
    const siteNames: Record<string, string> = {}
    let currentSiteWorkSchedule: unknown = null
    for (const s of mainRaw.sites || []) {
      siteNames[s.id] = (s.name || '').slice(0, 3)
      if (s.id === siteId) currentSiteWorkSchedule = s.workSchedule || null
    }

    // 2026-09-02 高速化: 月をまたぐと att_前月 をループ内で最大4回再読していた
    //（9/1〜9/5 は過去5日の大半が前月）。月単位キャッシュ＋承認の並列取得に変更。
    //   月初にスマホ画面が17秒かかり「入力できない」報告が出た障害の対処。
    const attMonthCache: Record<string, Record<string, AttendanceEntry>> = { [ym]: attData }
    if (attPrevPre) attMonthCache[prevYmStr] = attPrevPre
    const getAttCached = async (pym: string) => {
      if (!(pym in attMonthCache)) attMonthCache[pym] = await getAttendanceDoc(pym)
      return attMonthCache[pym]
    }
    const pastDayInfos = [] as { pd: Date; pym: string; pDay: number; entry: AttendanceEntry | null; entrySiteId: string; off: number }[]
    for (let off = 1; off <= 5; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()
      // 入社前・退職後の日は入力できる日に出さない（保存も POST で弾く・2026-10-02）
      if (!isEmployedOn(worker, `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}-${String(pDay).padStart(2, '0')}`)) continue
      const pAttData = await getAttCached(pym)

      // Check current site (親＋工種) first, then check all sites for this day
      const famSite = familyEntrySiteId(pAttData, family, worker.id, pym, pDay)
      let entry = famSite ? pAttData[attKey(famSite, worker.id, pym, pDay)] || null : null
      let entrySiteId = famSite || siteId
      if (!entry) {
        for (const sid of Object.keys(siteNames)) {
          if (sid === siteId) continue
          const altKey = attKey(sid, worker.id, pym, pDay)
          if (pAttData[altKey]) {
            entry = pAttData[altKey]
            entrySiteId = sid
            break
          }
        }
      }
      pastDayInfos.push({ pd, pym, pDay, entry, entrySiteId, off })
    }
    // ↓承認の取得は missingDays 側とまとめて1回の並列バッチで行う（2026-09-02）
    const pastApprovalsPromise = Promise.all(
      // 承認は親現場の単位（工種サイトのエントリでも親の承認を見る）
      pastDayInfos.map(i => getApprovalForDay(calendarSiteIdOf(rawSitesH, i.entrySiteId), i.pym, i.pDay)))
    const pastApprovals = await pastApprovalsPromise
    pastDayInfos.forEach((i, idx) => {
      pastDays.push({
        date: formatDateShort(i.pd),
        year: i.pd.getFullYear(),
        month: i.pd.getMonth() + 1,
        day: i.pDay,
        entry: i.entry,
        status: getEntryStatus(i.entry),
        locked: !!(pastApprovals[idx]?.foreman),
        dayOffset: i.off,
        siteName: siteNames[i.entrySiteId] || '',
      })
    })

    // ── 未入力の過去稼働日（2026-08-28 追加: 入力督促バナー用）──
    //   入力可能な過去14日のうち、承認済み現場カレンダーの稼働日で、どの現場にも
    //   入力がない日を返す。未入力のまま締めに流れると欠勤扱いになるため、
    //   スマホ画面の先頭で本人に見せて入力させる。
    //   カレンダー未承認の月は日曜のみ非稼働として扱う（職長画面の俯瞰と同じ規則）。
    const missingDays: {
      date: string; year: number; month: number; day: number
      entry: null; status: 'none'; locked: boolean; dayOffset: number; siteName: string
    }[] = []
    {
      const calCache: Record<string, Record<string, string> | null> = {}
      const missingCands = [] as { pd: Date; py: number; pm: number; pDay: number; pym: string; off: number }[]
      for (let off = 1; off <= 14; off++) {
        const pd = new Date(y, m - 1, d - off)
        const py = pd.getFullYear()
        const pm = pd.getMonth() + 1
        const pDay = pd.getDate()
        const pym = ymKey(py, pm)
        // 入社前・退職後の日は督促しない（2026-10-02・入社したばかりの人に入社前の日まで「未入力」と出ていた）
        if (!isEmployedOn(worker, `${py}-${String(pm).padStart(2, '0')}-${String(pDay).padStart(2, '0')}`)) continue
        const pAtt = await getAttCached(pym)   // pastDays と同じ月キャッシュを共有（2026-09-02）

        // 工種サイトは親現場のカレンダー（2026-09-15）
        const rawSitesM = (mainRaw.sites || []) as { id: string; parentId?: string; start?: string; calendarFromYm?: string }[]
        const calParent = rawSitesM.find(x => x.id === siteId)?.parentId
        let calSiteId = calParent || siteId
        // 選んでいる現場がこの月カレンダーを作らない現場（スポットなど）なら、その月に一番多く入力している現場の
        //   カレンダーで判定する（2026-09-30 点検: スポット現場を選ぶと土曜・祝日まで「未入力」と赤く出ていた）
        if (!siteNeedsCalendar(rawSitesM.find(x => x.id === calSiteId), pym)) {
          const { mainSiteOfMonth } = await import('@/lib/attendance-confirm')
          const ms = mainSiteOfMonth(pAtt as Record<string, unknown>, worker.id, pym)
          if (ms) calSiteId = rawSitesM.find(x => x.id === ms)?.parentId || ms
        }
        const calKey = `${calSiteId}_${py}-${String(pm).padStart(2, '0')}`
        if (!(calKey in calCache)) {
          try {
            const calSnap = await getDoc(doc(db, 'siteCalendar', calKey))
            const cal = calSnap.exists() ? calSnap.data() : null
            calCache[calKey] = (cal?.status === 'approved' && cal?.days)
              ? (cal.days as Record<string, string>) : null
          } catch { calCache[calKey] = null }
        }
        const calDays = calCache[calKey]
        if (!isWorkDayOf(calDays, py, pm, pDay)) continue   // 「仕事の日か」は共通（lib/attendance-missing.ts）

        // どの現場かを問わず入力があればスキップ（現場間違いは職長が移動する）
        let hasEntry = false
        for (const sid of Object.keys(siteNames)) {
          if (getEntryStatus(pAtt[attKey(sid, worker.id, pym, pDay)]) !== 'none') {
            hasEntry = true
            break
          }
        }
        if (hasEntry) continue
        missingCands.push({ pd, py, pm, pDay, pym, off })
      }
      const missApprovals = await Promise.all(
        missingCands.map(c => getApprovalForDay(siteId, c.pym, c.pDay)))
      // （today の承認・道具代はこの後の並列ブロックで取得）
      missingCands.forEach((c, idx) => {
        missingDays.push({
          date: formatDateShort(c.pd),
          year: c.py, month: c.pm, day: c.pDay,
          entry: null,
          status: 'none',
          locked: !!(missApprovals[idx]?.foreman),
          dayOffset: c.off,
          siteName: '',
        })
      })
    }

    // Today's approval と 道具代 doc を並列で取得（2026-09-02 高速化）
    const { isToolBudgetEligible } = await import('@/lib/workers')
    const tbEligible = isToolBudgetEligible({ visa: worker.visaType, job: worker.jobType, retired: worker.retired, hireDate: worker.hireDate })
    const [todayApproval, tbSnapPre] = await Promise.all([
      getApprovalForDay(siteId, ym, d),
      tbEligible ? getDoc(doc(db, 'demmen', 'toolBudget')) : Promise.resolve(null),
    ])

    // 道具代情報（技能実習生・特定技能のみ、佐藤さんが手動設定した期間起点から1年サイクル）
    // 2026-04-30 運用開始: データ整備完了に伴いガード撤廃（データが無ければ自然に非表示）
    let toolBudgetRemaining: number | null = null
    let toolBudgetPeriodStart: string | null = null
    let toolBudgetPeriodEnd: string | null = null
    let toolBudgetCarry = 0
    try {
      if (tbEligible && tbSnapPre) {
        const tbSnap = tbSnapPre
        if (tbSnap.exists()) {
          const tbData = tbSnap.data()
          // 期間の計算は道具代の管理画面と共通（lib/tool-budget-period.ts・2026-09-30）。
          //   起点日が未設定のベトナム人は入社日を起点にする。起点日が先（入社前）なら出さない
          const { getCurrentPeriod, toolBudgetAnchorOf } = await import('@/lib/tool-budget-period')
          const anchor = toolBudgetAnchorOf({ id: worker.id, visa: worker.visaType, hireDate: worker.hireDate }, tbData.periodAnchors).anchor
          const period = anchor ? getCurrentPeriod(anchor, now) : null
          if (period) {
            {
              const periodStartStr = period.start
              toolBudgetPeriodStart = period.start
              toolBudgetPeriodEnd = period.end

              const tbKey = `${worker.id}_${periodStartStr}`
              const tbRecord = tbData.records?.[tbKey]
              const { toolBudgetDefaultFor } = await import('@/lib/workers')
              const { toolBudgetCarryIn } = await import('@/lib/tool-budget-period')
              const tbDefault = toolBudgetDefaultFor({ visa: worker.visaType, job: worker.jobType }, tbData)
              const tbBudget = tbRecord?.budget ?? tbDefault
              const tbUsed = (tbRecord?.purchases || []).reduce((s: number, p: { amount: number }) => s + p.amount, 0)
              // 前の期間からの繰越（2026-09-30）。マイナスは使いすぎの持ち越し
              toolBudgetCarry = toolBudgetCarryIn(anchor!, period.index, worker.id, tbData.records || {}, tbDefault)
              toolBudgetRemaining = tbBudget + toolBudgetCarry - tbUsed
            }
          }
        }
      }
    } catch { /* ignore */ }

    // 有給残日数
    // 2026-04-30 運用開始: データ整備完了に伴いガード撤廃（plRecordsが無ければ自然にnullで非表示）
    // Phase 8: FIFO内訳（繰越分・当期付与分の別々表示）
    let plRemaining: number | null = null
    let plExpiryDate: string | null = null  // 当期付与分の有効期限（従来フィールド、後方互換）
    let plCarryOverRemaining: number | null = null
    let plCarryOverExpiryDate: string | null = null
    let plCarryOverExpiryStatus: 'ok' | 'warning' | 'expired' | null = null
    let plGrantRemaining: number | null = null
    let plGrantExpiryDate: string | null = null
    try {
      {
          // 2026-09-02: main の再読をやめ、冒頭で読んだ mainRaw を使う
          const plData: Record<string, { fy?: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; used?: number; _archived?: boolean }[]> =
            ((mainRaw as { plData?: Record<string, never[]> }).plData || {}) as never
          const plRecordsRaw = plData[String(worker.id)] || []
          const plRecords = plRecordsRaw.filter(r => !r._archived)

          // ⚠️ 2026-08-17 修正: 「今日時点で有効な」付与レコードを選ぶこと。
          //   旧コードは grantDate でソートして配列の最後を取っていたため、
          //   **まだ付与日が来ていない未来のレコード**を掴んでいた。
          //   実例: トゥアン(102) は当期(2025-11-01付与・17日)を17日消化して残0日なのに、
          //   未来の 2026-11-01 付与(17日・消化0)を見て「残17日」と表示していた
          //   （有効期限も 2028/10/31 と未来枠のものが出ていた）。
          //   申請時のガードは getLeaveBalance → selectActiveGrantRecord で正しく0と
          //   判定して弾くため、「17日あるのに申請できない」というUX不整合になっていた。
          //   ※ 判定は lib/leave-compute.ts の selectActiveGrantRecord に一元化する。
          //     「配列の最後」「fyの数値比較」で代用しないこと（どちらも未来レコードを掴む）。
          const { selectActiveGrantRecord } = await import('@/lib/leave-compute')
          const latest = selectActiveGrantRecord(plRecords, todayJstIso())

          if (latest) {
            const grant = latest.grantDays ?? latest.grant ?? 0
            const carry = latest.carryOver ?? latest.carry ?? 0
            const adj = latest.adjustment ?? latest.adj ?? 0

            // periodUsed を出面から動的計算（grantDate..+1年の範囲内のPエントリ数）
            //
            // 設計ポリシー（2026-05-18 確定）:
            //   スタッフ画面の残日数は「申請可能な日数」を示す → 未来日付の予定も「使用済み」扱いに含める
            //   （対比: 管理画面/Excelは「実消化日数」基準なので未来日付は除外）
            //
            // 含めるもの:
            //   - 過去P（実際に消化済み）
            //   - 未来P（承認済みの帰国予定など、出面に既に書き込まれている）
            // 含めないもの:
            //   - pending状態の申請（まだ承認されていない、leave-request API側で別途算入）
            //
            // この設計により、スタッフが「あと15日ある」と思って追加申請したら拒否される、
            // という UX 不整合を防ぐ。
            let periodUsed = 0
            if (latest.grantDate) {
              const gdStart = new Date(latest.grantDate + 'T00:00:00')
              if (!isNaN(gdStart.getTime())) {
                const gdEnd = new Date(gdStart); gdEnd.setFullYear(gdEnd.getFullYear() + 1)
                // 2026-09-02 高速化（月初の「入力できない」障害の主犯）:
                //   旧実装は「過去2年+当年 = 36ヶ月」の att を**逐次**読みしており、
                //   これだけで15〜20秒かかっていた（スマホ回線ではタイムアウト）。
                //   数えるのは付与期間 [grantDate, +1年) の P だけなので、
                //   その期間の月（最大13ヶ月）だけを**並列**で読む。
                const attEntries: Record<string, Record<string, unknown>> = {}
                {
                  const periodYms: string[] = []
                  const cur = new Date(gdStart.getFullYear(), gdStart.getMonth(), 1)
                  while (cur < gdEnd && periodYms.length < 14) {
                    periodYms.push(ymKey(cur.getFullYear(), cur.getMonth() + 1))
                    cur.setMonth(cur.getMonth() + 1)
                  }
                  const atts = await Promise.all(periodYms.map(pymL => getAttData(pymL)))
                  for (const att of atts) Object.assign(attEntries, att.d)
                }
                // 同日複数現場の p は1日として数える（他経路と同じ dedup。2026-08-27）
                const seenP = new Set<string>()
                for (const [key, entry] of Object.entries(attEntries)) {
                  if (!entry) continue
                  const e = entry as { p?: number | boolean }
                  if (!e.p) continue
                  const pk = parseDKey(key)
                  if (parseInt(pk.wid) !== worker.id) continue
                  const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                  if (d >= gdStart && d < gdEnd) seenP.add(`${pk.ym}_${pk.day}`)
                }
                periodUsed = seenP.size
              }
            }
            // 買取済み日数も消化側に含める（getLeaveBalance と同じ式。
            //   2026-08-17 総点検で判明: ここだけ買取を無視していたため、退職精算等で
            //   買取した人のスマホ残数が買取分だけ多く表示される）
            // buyoutDays 未キャッシュの移行データは履歴合算へフォールバック（getLeaveBalance と統一・2026-09-02）
            const latestB = latest as { buyoutDays?: number; buyoutHistory?: Array<{ days?: number }> }
            const buyout = latestB.buyoutDays ?? (latestB.buyoutHistory || []).reduce((s2, b) => s2 + (b.days || 0), 0)
            const totalUsed = adj + buyout + periodUsed

            // FIFO 内訳: 繰越分→当期付与分の順に消費
            const fromCarryOver = Math.min(totalUsed, carry)
            const fromGrant = Math.max(0, totalUsed - carry)
            plCarryOverRemaining = Math.max(0, carry - fromCarryOver)
            plGrantRemaining = Math.max(0, grant - fromGrant)
            plRemaining = plCarryOverRemaining + plGrantRemaining

            // 当期付与分の最終利用可能日 = 付与日 + 2年 - 1日
            if (latest.grantDate) {
              const lastUsable = calcLastUsableDayIso(latest.grantDate)
              if (lastUsable) {
                plExpiryDate = lastUsable
                plGrantExpiryDate = plExpiryDate
              }
            }

            // 繰越分の時効 = 前期レコード.grantDate + 2年 - 1日
            if (plCarryOverRemaining > 0 && latest.grantDate) {
              const curTime = new Date(latest.grantDate + 'T00:00:00').getTime()
              const prevCandidates = plRecordsRaw
                .filter(r => r.grantDate)
                .map(r => ({ rec: r, time: new Date(r.grantDate as string + 'T00:00:00').getTime() }))
                .filter(x => !isNaN(x.time) && x.time < curTime)
                .sort((a, b) => a.time - b.time)
              const prev = prevCandidates[prevCandidates.length - 1]
              if (prev && prev.rec.grantDate) {
                const prevGrant = prev.rec.grantDate as string
                const prevLastUsable = calcLastUsableDayIso(prevGrant)
                plCarryOverExpiryDate = prevLastUsable
                const todayStr = todayJstIso()
                if (isLeaveExpiredAsOf(prevGrant, todayStr)) plCarryOverExpiryStatus = 'expired'
                else if (daysBetween(todayStr, prevLastUsable) <= 90) plCarryOverExpiryStatus = 'warning'
                else plCarryOverExpiryStatus = 'ok'
                if (plCarryOverExpiryStatus === 'expired') plCarryOverRemaining = 0
              }
            }
          }
        }
    } catch { /* ignore */ }

    return NextResponse.json({
      worker: { id: worker.id, name: worker.name, nameVi: worker.nameVi, visaType: worker.visaType },
      site: { id: site.id, name: site.name, workSchedule: currentSiteWorkSchedule },
      allSites: assignedSites,
      availableSites,
      unassigned,  // 2026-07-22: 現場未配置（新入社員が配置前）。画面で現場選択を促す
      today: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateJP(now),
      },
      currentEntry,
      currentStatus: getEntryStatus(currentEntry),
      todayLocked: !!(todayApproval?.foreman),
      pastDays,
      missingDays,
      toolBudgetRemaining,
      toolBudgetCarry,
      // 休憩短縮（旧契約の毎日20分など）。出面には記録せず給与計算で足している分を、画面で見せるため（2026-09-30）
      breakShorten: (worker.breakShortenMin ?? 0) > 0 && worker.breakShortenFrom
        ? { min: worker.breakShortenMin, from: worker.breakShortenFrom } : null,
      // 自分の都合で1日休むと減る給料の目安（時給 × 7時間）。新ルールの時給制の人だけ（2026-09-30）
      absenceDayPay: (() => {
        if (!worker.visaType || worker.visaType === 'none' || worker.useOldRules) return null
        const rate = hourlyRateOn(worker, tIso)
        return rate && rate > 0 ? Math.round(rate * 7) : null
      })(),
      toolBudgetPeriodStart,
      toolBudgetPeriodEnd,
      plRemaining,
      plExpiryDate,
      // Phase 8: FIFO内訳
      plCarryOverRemaining,
      plCarryOverExpiryDate,
      plCarryOverExpiryStatus,
      plGrantRemaining,
      plGrantExpiryDate,
    })
  } catch (error) {
    console.error('Staff GET error:', error)
    return NextResponse.json({ error: 'サーバーでエラーが起きました。少し待ってからもう一度お試しください / Lỗi máy chủ. Vui lòng thử lại sau' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { token, siteId: siteIdIn, year, month, day, choice, overtimeHours,
            startTime, endTime, break1, break2, break3,
            restReason, restNote } = await request.json()

    if (!token || !siteIdIn || !year || !month || !day || !choice) {
      return NextResponse.json({ error: '入力に足りないものがあります。画面を開き直してください / Thiếu dữ liệu. Vui lòng mở lại màn hình' }, { status: 400 })
    }

    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'この URL は無効です。会社に連絡してください / Đường dẫn không hợp lệ. Vui lòng liên hệ công ty' }, { status: 401 })
    }

    // Check site exists and is active + 現場の勤務時間設定を取得
    // 2026-09-02 高速化: POST でも main を1回だけ読んで全てを導出
    const mainSnapPost = await getDoc(doc(db, 'demmen', 'main'))
    const mainRawPost = (mainSnapPost.exists() ? mainSnapPost.data() : {}) as {
      sites?: { id: string; name?: string; archived?: boolean; shiftType?: 'day' | 'night'; workSchedule?: { startTime?: string }; parentId?: string }[]
      assign?: WorkTypeAssignMap
    }
    // 工種サイトの id が来ても親現場として扱う（承認・勤務時間・カレンダーは親の単位）
    const siteId = calendarSiteIdOf((mainRawPost.sites || []) as import('@/lib/site-hierarchy').HierarchySite[], String(siteIdIn))
    // 実際に書き込む現場（工種）。下の同日多現場ガードの中で出面を読んだときに決める
    let targetSiteId = siteId
    const allActiveSites = (mainRawPost.sites || []).filter(s2 => !s2.archived).map(s2 => ({ id: s2.id, name: s2.name || '' }))
    if (!allActiveSites.find(s => s.id === siteId)) {
      return NextResponse.json({ error: 'この現場は見つからないか、終わった現場です / Không tìm thấy công trường hoặc công trường đã kết thúc' }, { status: 403 })
    }
    // workSchedule を取得（残業計算用）
    type SiteBreakRaw = { enabled?: boolean; minutes?: number; mandatory?: boolean }
    type SiteWorkScheduleRaw = {
      startTime?: string; endTime?: string
      morningBreak?: SiteBreakRaw; lunchBreak?: SiteBreakRaw; afternoonBreak?: SiteBreakRaw
    }
    let siteWorkSchedule: SiteWorkScheduleRaw | null = null
    {
      const found = (mainRawPost.sites || []).find(s => s.id === siteId)
      siteWorkSchedule = (found?.workSchedule as SiteWorkScheduleRaw | undefined) || null
    }

    // Check approval lock
    const ym = ymKey(year, month)
    // 実在する日か（2026-10-02 総合点検: 旧は確かめず、API を直接呼ぶと `..._202609_31` のような無い日を書けた。PC と同じ共通の決まり）
    {
      const dateErr = attendanceDateError(ym, day)
      if (dateErr) return NextResponse.json({ error: `${dateErr} / Ngày không hợp lệ` }, { status: 400 })
    }
    // 入社前・退職後の日には入れない（2026-10-02 点検: 書けると承認・本人確認の対象外のまま給与に入った）
    {
      const isoP = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (!isEmployedOn(worker, isoP)) {
        return NextResponse.json({ error: 'この日は在籍期間の外です / Ngày này nằm ngoài thời gian làm việc' }, { status: 400 })
      }
    }
    // 職長が確認（承認）した日は本人からは変えられない。判定は共通（lib/attendance-save.ts dayApprovalOf・工種サイトの子で付けた古い承認も見る）
    const approval = await dayApprovalOf((mainRawPost.sites || []) as { id: string; parentId?: string }[], siteId, ym, day)
    if (approval.foreman) {
      return NextResponse.json({ error: 'この日は職長が確認済みのため変更できません。直したいときは職長に相談してください / Ngày này tổ trưởng đã xác nhận nên không thể thay đổi. Hãy trao đổi với tổ trưởng' }, { status: 409 })
    }

    // 2026-06-12 (監査 Sprint2-B): 月次ロック済み月への書込を拒否。
    //   year/month は任意指定できるため、過去のロック済み月（給与確定後）への
    //   遡及入力で支払額とシステムが食い違うのを防ぐ
    {
      // 2026-10-02 総合点検: 旧実装は worker.org を渡していたが、Worker 型に org は無く常に undefined
      //   ＝「両社とも締めたときだけ」拒否になっていた。人員マスタの会社で判定する
      const { checkMonthLockedForWorkers } = await import('@/lib/locks')
      const lockErr = await checkMonthLockedForWorkers(ym, [worker.id])
      if (lockErr) {
        return NextResponse.json({ error: `${lockErr} / Tháng này đã khóa, không thể thay đổi` }, { status: 409 })
      }
    }

    // 2026-08-27 追加（有給総点検・第3回）: 入力可能な日付範囲を制限。
    //   year/month/day は body で任意指定できたため、トークンさえあれば
    //   未来日や遠い過去日へ API 直叩きで書き込めた（UI は今日+過去5日のみ）。
    //   過去は14日前まで。未来日は原則不可だが、**欠勤届(rest)だけは+30日まで許可**
    //   （「明日休みます」の事前届は 2026-07-30 実装の正規機能。当初ガードが
    //   一律拒否で回帰させていたのを同日中に修正）。
    {
      const { todayJstIso, addDaysIso } = await import('@/lib/date-utils')
      const dateIso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
      const today = todayJstIso()
      // 会社都合の休み（comp・2026-09-30）も「明日は現場が休み」と言われた日を先に入れられるよう、休みと同じ30日先まで
      const futureLimit = (choice === 'rest' || choice === 'comp') ? addDaysIso(today, 30) : today
      if (dateIso > futureLimit) {
        return NextResponse.json({ error: (choice === 'rest' || choice === 'comp')
          ? '欠勤届は30日先まで提出できます / Đơn xin nghỉ chỉ nộp được trước tối đa 30 ngày'
          : '未来の日付には入力できません / Không thể nhập cho ngày trong tương lai' }, { status: 400 })
      }
      if (dateIso < addDaysIso(today, -14)) {
        return NextResponse.json({ error: '2週間より前の日付は変更できません。職長に依頼してください / Không thể thay đổi ngày quá 2 tuần trước' }, { status: 400 })
      }
    }

    // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
    // （日勤+夜勤は許容、日勤+日勤や夜勤+夜勤は拒否）
    // 保存前のこの日のエントリ（ガードで読んだ出面を使い回す。次期繰越の再計算を有給の増減に絞るため）
    let prevStaffEntry: AttendanceEntry | null | undefined
    try {
      const { detectMultiSiteConflict, getAttendanceDoc, attKey } = await import('@/lib/attendance')
      const attDoc = await getAttendanceDoc(ym)

      // 2026-08-27 追加（有給総点検・第3回）: 承認済み有給(p)の日をスタッフが
      //   別ステータスで上書きすると、p だけが消えて申請レコードは approved のまま残り、
      //   残数が黙って1日戻っていた（承認↔出面の対の崩れ）。有給の変更は管理者の
      //   取消(revoke)経由に限定する。
      // 保存先の工種: その日の入力がある工種 ＞ その日の工種指定 ＞ 本人の既定 ＞ 親現場（本人には選ばせない）
      targetSiteId = staffEntryTarget(
        (mainRawPost.sites || []) as import('@/lib/site-hierarchy').HierarchySite[],
        mainRawPost.assign, attDoc, siteId, worker.id, ym, Number(day),
      ).targetSiteId
      prevStaffEntry = (attDoc[attKey(targetSiteId, worker.id, ym, day)] as AttendanceEntry | undefined) ?? null

      if (choice !== 'leave') {
        const existing = attDoc[attKey(targetSiteId, worker.id, ym, day)] as { p?: number | boolean } | undefined
        if (existing?.p) {
          return NextResponse.json({
            error: 'この日は有給として登録済みです。変更が必要な場合は管理者に連絡してください / Ngày này đã đăng ký nghỉ phép. Vui lòng liên hệ quản lý nếu cần thay đổi',
          }, { status: 409 })
        }
      }
      // 全現場リスト（アーカイブ済みも含む。過去の現場間違いを検出するため）
      const sitesAll = mainRawPost.sites || []
      const conflict = detectMultiSiteConflict(attDoc, targetSiteId, worker.id, ym, day, sitesAll)
      if (conflict) {
        const found = sitesAll.find(s => s.id === conflict.conflictSiteId)
        const conflictSiteName = found?.name || conflict.conflictSiteId
        const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
        return NextResponse.json({
          error: `既に「${conflictSiteName}」（${shiftLabel}）で同日の出面が登録されています。職長に依頼してください。 / Ngày này đã có chấm công tại "${conflictSiteName}". Vui lòng nhờ tổ trưởng.`,
          conflictSiteId: conflict.conflictSiteId,
          conflictSiteName,
        }, { status: 409 })
      }
    } catch (e) {
      console.error('Multi-site guard error (staff):', e)
      return NextResponse.json({ error: 'ガード判定に失敗しました。もう一度お試しください / Kiểm tra thất bại. Vui lòng thử lại' }, { status: 503 })
    }

    // Build entry
    //
    // ⚠️ 2026-05-09 根本原因対処（c36517b の安全再実装）:
    //   ステータス変更時に古いフィールド（出勤の時刻、休みの理由、残業時間など）が
    //   merge:true で残り続けるバグの根治。
    //   computeAttendanceDeleteFields(entry) で「新エントリに含まれない既知フィールドを
    //   自動算出して削除」することで、漏れなく残骸を消す。
    // 2026-09-30（代表決定）: 有給は前日までに「有給申請」から。出面画面からの直接入力は受け付けない
    //   （旧: 当日・過去14日の日にも有給を入れられ、申請・承認を通らずに有給になった）
    if (choice === 'leave') {
      const { LEAVE_REQUEST_DEADLINE_MESSAGE } = await import('@/lib/leave-rules')
      return NextResponse.json({ error: LEAVE_REQUEST_DEADLINE_MESSAGE + '（有給申請から申請してください / Hãy xin qua mục Xin phép）' }, { status: 400 })
    }
    let entry: AttendanceEntry
    const isTimeBased = !!(startTime && endTime) // 時間ベース入力（202605〜）
    switch (choice) {
      case 'work':
        if (isTimeBased) {
          // 時間ベース入力: 始業/終業/休憩から実労働を算出
          entry = {
            w: 1,
            st: String(startTime),
            et: String(endTime),
            b1: break1 ? 1 : 0,
            b2: break2 ? 1 : 0,
            b3: break3 ? 1 : 0,
            s: 'staff',
          }
          // o（残業h）は保存の共通入口 setAttendanceEntry が現場の休憩設定で付け直す（calcOvertimeHours）。
          //   ここで先に付けておくのは、下の操作ログ等が保存前の entry を見るため
          entry = withDerivedOvertime(entry, (siteWorkSchedule || undefined) as SiteWorkSchedule | undefined)
        } else {
          // レガシー入力（202604以前）
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'staff' }
        }
        break
      case 'rest': {
        const restEntry: AttendanceEntry = { w: 0, r: 1, s: 'staff' }
        if (restReason && String(restReason).trim()) {
          restEntry.rReason = String(restReason).trim()
        }
        if (restNote && String(restNote).trim()) {
          restEntry.rNote = String(restNote).trim()
        }
        entry = restEntry
        break
      }
      // case 'leave' は 2026-09-30 に廃止（有給は前日までに「有給申請」から。switch の手前で弾く）
      case 'site_off':
        entry = { w: 0, h: 1, s: 'staff' }
        break
      case 'comp': {
        // 会社の都合の休み（現場が休みになった日）＝ 0.6補（2026-09-30 追加）。
        //   以前はスマホに選択肢が無く、本人が「その他」＋メモ「60%」で出して欠勤扱いになっていた
        //   （201・2026-08-26）。本人の入力 → 職長の確認、の流れは出勤と同じ。
        //   カレンダーの休みの日は給料の対象外なので入れさせない
        const { isScheduledWorkDay } = await import('@/lib/attendance')
        const compDate = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
        if (!await isScheduledWorkDay(siteId, compDate)) {
          return NextResponse.json(
            { error: 'この日はカレンダーで休みの日です。「会社の都合の休み」は仕事の日だけ選べます / Ngày này là ngày nghỉ theo lịch. Chỉ chọn "nghỉ do công ty" cho ngày làm việc' },
            { status: 400 }
          )
        }
        entry = { w: 0.6, s: 'staff' }
        break
      }
      default:
        return NextResponse.json({ error: '選んだ内容が正しくありません / Lựa chọn không hợp lệ' }, { status: 400 })
    }

    // 保存は共通の入口（変更履歴 → 残骸の掃除つき保存・lib/attendance-save.ts・2026-10-02 総合点検）。
    //   旧: 本人が自分の入力を上書きしても変更履歴（attendanceHistory）に残らなかった
    await writeAttendanceEntry({
      siteId: targetSiteId, workerId: worker.id, ym, day: Number(day), entry, prevEntry: prevStaffEntry, actor: `staff:${worker.id}`,
    })

    return NextResponse.json({ success: true, entry })
  } catch (error) {
    console.error('Staff POST error:', error)
    return NextResponse.json({ error: 'サーバーでエラーが起きました。少し待ってからもう一度お試しください / Lỗi máy chủ. Vui lòng thử lại sau' }, { status: 500 })
  }
}
