import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, computeMonthly, getSubconRate } from '@/lib/compute'
import { getMonthlyCalendars } from '@/lib/repositories/calendarRepo'
import { getAllActiveHomeLeaves } from '@/lib/homeLeave'
import {
  generateHibiAttendance,
  generateHfuAttendance,
  generateSubconConfirmation,
  generateBukakeReport,
  generatePLLedger,
  generateMonthlyExcel,
  generatePerSiteAttendance,
  generatePlannedShiftExcel,
  generateActualHoursExcel,
  generateConsentLedger,
  workbookToBuffer,
} from '@/lib/export'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, where } from '@/lib/fsdb'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const ym = searchParams.get('ym')
  const subconId = searchParams.get('subconId') // for subcon type

  if (!type) {
    return NextResponse.json({ error: 'type parameter required' }, { status: 400 })
  }

  // pl (有給管理台帳) doesn't require ym
  if (type !== 'pl' && (!ym || !/^\d{6}$/.test(ym))) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const ymStr = ym || ''

    // For types that need attendance data
    let attD: Record<string, import('@/types').AttendanceEntry> = {}
    let attSD: Record<string, { n: number; on: number }> = {}

    if (type !== 'pl' && ymStr) {
      const att = await getAttData(ymStr)
      attD = att.d
      attSD = att.sd
    }

    const activeSites = main.sites.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name }))
    const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20

    // 外国人給与の週残業しきい値を「カレンダー予定日ベース」で判定するための日別カレンダー（監査④）。
    //   給与を計算するケース(monthly / monthlyExcel / bukake)だけで遅延ロードする。
    const loadCalendarDaysMap = async (): Promise<Record<string, Record<string, string>>> => {
      const cals = await getMonthlyCalendars(`${ymStr.slice(0, 4)}-${ymStr.slice(4, 6)}` as Parameters<typeof getMonthlyCalendars>[0])
      const m: Record<string, Record<string, string>> = {}
      for (const c of cals) if (c.days) m[c.siteId] = c.days
      return m
    }

    let buffer: Buffer
    let filename: string

    switch (type) {
      case 'hibi':
      case 'hfu': {
        // カレンダーデータを取得（所定日/休日の判定に使用 — 両方で共通）
        const ym7 = `${ymStr.slice(0, 4)}-${ymStr.slice(4, 6)}`
        const calendars = await getMonthlyCalendars(ym7)
        const calendarDaysMap: Record<string, Record<string, string>> = {}
        for (const cal of calendars) {
          if (cal.days) calendarDaysMap[cal.siteId] = cal.days
        }
        const exportData = {
          ym: ymStr,
          workers: main.workers,
          attD,
          sites: activeSites,
          assign: main.assign,
          massign: main.massign,
          calendarDays: calendarDaysMap,
          baseDays,
        }
        if (type === 'hibi') {
          const wb = generateHibiAttendance(exportData)
          buffer = workbookToBuffer(wb)
          filename = `日比建設_出面一覧_${ymStr}.xlsx`
        } else {
          const wb = generateHfuAttendance(exportData)
          buffer = workbookToBuffer(wb)
          filename = `HFU_出面一覧_${ymStr}.xlsx`
        }
        break
      }

      case 'subcon': {
        // 2026-06-12 (監査): 現場別単価オーバーライド(getSubconRate)を確認書の金額に反映。
        //   旧: 基本単価で再計算 → 原価(site.subCost)・歩掛と金額が食い違っていた
        const buildSiteRates = (scid: string) => {
          const map: Record<string, { rate: number; otRate: number }> = {}
          for (const s of activeSites) map[s.id] = getSubconRate(main, scid, s.id, ymStr)
          return map
        }
        // Find the specific subcon or generate for all
        if (subconId) {
          const subcon = main.subcons.find(s => s.id === subconId)
          if (!subcon) {
            return NextResponse.json({ error: 'Subcon not found' }, { status: 404 })
          }
          const wb = generateSubconConfirmation({
            ym: ymStr,
            subcon,
            attSD,
            sites: activeSites,
            siteRates: buildSiteRates(subcon.id),
          })
          buffer = workbookToBuffer(wb)
          filename = `外注確認書_${subcon.name}_${ymStr}.xlsx`
        } else {
          // Generate for all subcons in one workbook
          // We'll create individual workbooks merged: one sheet per subcon
          const XLSX = await import('xlsx')
          const wb = XLSX.utils.book_new()

          for (const subcon of main.subcons) {
            const subWb = generateSubconConfirmation({
              ym: ymStr,
              subcon,
              attSD,
              sites: activeSites,
              siteRates: buildSiteRates(subcon.id),
            })
            // Copy the first sheet from subWb to wb
            const sheetName = subcon.name.slice(0, 31)
            const ws = subWb.Sheets[subWb.SheetNames[0]]
            XLSX.utils.book_append_sheet(wb, ws, sheetName)
          }

          buffer = workbookToBuffer(wb)
          filename = `外注確認書_全社_${ymStr}.xlsx`
        }
        break
      }

      case 'bukake': {
        // 2026-06-XX 修正: siteWorkDaysMap を画面と統一（/api/monthly と整合性確保）
        // 2026-06-12 修正 (監査C2): 全社所定を 0 固定 → main.workDays[ym] に。
        //   0 のままだと旧ルール継続者(フン等)の給与・原価がこの帳票だけ 0 円になっていた。
        const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ymStr] || {}
        const hasCalendar = Object.keys(siteWorkDaysMap).length > 0
        const calendarDaysMap = await loadCalendarDaysMap()
        const homeLeaves = await getAllActiveHomeLeaves()
        const result = computeMonthly(main, attD, attSD, ymStr, main.workDays[ymStr] || 0, hasCalendar ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves)
        const siteNames: Record<string, string> = {}
        for (const s of main.sites) siteNames[s.id] = s.name

        const wb = generateBukakeReport({
          ym: ymStr,
          sites: result.sites,
          workers: result.workers,
          subcons: result.subcons,
          siteNames,
          defaultRates: main.defaultRates,
          rawSites: main.sites.filter(s => !s.archived),
        })
        buffer = workbookToBuffer(wb)
        filename = `歩掛管理表_${ymStr}.xlsx`
        break
      }

      case 'pl': {
        // 過去2年分の出面データからPL取得日を収集
        const now = new Date()
        const plAttData: Record<string, Record<string, unknown>> = {}
        for (let y = now.getFullYear() - 2; y <= now.getFullYear(); y++) {
          for (let m = 1; m <= 12; m++) {
            const attYm = `${y}${String(m).padStart(2, '0')}`
            const att = await getAttData(attYm)
            if (att.d) Object.assign(plAttData, att.d)
          }
        }
        const plOrg = request.nextUrl.searchParams.get('org') || 'all'
        const wb = generatePLLedger({
          workers: main.workers,
          plData: main.plData,
          attData: plAttData,
          org: plOrg,
        })
        const orgLabel = plOrg === 'hfu' ? '_HFU' : plOrg === 'hibi' ? '_日比建設' : ''
        buffer = workbookToBuffer(wb)
        filename = `有給管理台帳${orgLabel}.xlsx`
        break
      }

      case 'monthly': {
        // Monthly report: return JSON data for client-side print rendering
        // 2026-06-XX 修正: siteWorkDaysMap を画面と統一（/api/monthly と整合性確保）
        // 2026-06-12 修正 (監査C2): 全社所定を 0 固定 → main.workDays[ym] に（bukake と同様）
        const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ymStr] || {}
        const hasCalendar = Object.keys(siteWorkDaysMap).length > 0
        const calendarDaysMap = await loadCalendarDaysMap()
        const homeLeaves = await getAllActiveHomeLeaves()
        const result = computeMonthly(main, attD, attSD, ymStr, main.workDays[ymStr] || 0, hasCalendar ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves)
        const siteNames: Record<string, string> = {}
        for (const s of main.sites) siteNames[s.id] = s.name

        return NextResponse.json({
          workers: result.workers,
          subcons: result.subcons,
          sites: result.sites,
          totals: result.totals,
          siteNames,
          ym: ymStr,
        })
      }

      case 'monthlyExcel': {
        // 2026-06-12 修正 (監査C3): 所定日数をクエリ（画面の未保存入力値）から取らず、
        //   サーバ保存値 main.workDays[ym] を使用。画面(/api/monthly)と同一ソースにし、
        //   「画面で確認した金額」と「Excelの金額」が食い違う事故経路を遮断。
        const prescribedDays = main.workDays[ymStr] || 0
        const orgFilter = searchParams.get('org') || 'all'
        // 2026-06-XX 修正: siteWorkDaysMap を画面と統一（/api/monthly と整合性確保）
        const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ymStr] || {}
        const hasCalendar = Object.keys(siteWorkDaysMap).length > 0
        const calendarDaysMap = await loadCalendarDaysMap()
        const homeLeaves = await getAllActiveHomeLeaves()
        const monthlyResult = computeMonthly(main, attD, attSD, ymStr, prescribedDays, hasCalendar ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves)
        const monthSiteNames: Record<string, string> = {}
        for (const s of main.sites) monthSiteNames[s.id] = s.name

        let filteredWorkers = monthlyResult.workers
        let filteredSubcons = monthlyResult.subcons
        if (orgFilter === 'hibi') {
          filteredWorkers = monthlyResult.workers.filter((w: { org: string }) => w.org === 'hibi')
          filteredSubcons = []
        } else if (orgFilter === 'hfu') {
          filteredWorkers = monthlyResult.workers.filter((w: { org: string }) => w.org === 'hfu')
          filteredSubcons = []
        } else if (orgFilter === 'subcon') {
          filteredWorkers = []
        }

        const tabLabel = orgFilter === 'hfu' ? '_HFU' : orgFilter === 'hibi' ? '_日比建設' : orgFilter === 'subcon' ? '_外注' : ''
        const wb = generateMonthlyExcel({
          ym: ymStr,
          workers: filteredWorkers,
          subcons: filteredSubcons,
          siteNames: monthSiteNames,
          prescribedDays,
        })
        buffer = workbookToBuffer(wb)
        filename = `月次集計${tabLabel}_${ymStr}.xlsx`
        break
      }

      case 'perSite': {
        const allSites = main.sites.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name }))
        const wb = generatePerSiteAttendance({
          ym: ymStr,
          workers: main.workers,
          attD,
          sites: allSites,
          assign: main.assign,
          massign: main.massign,
        })
        buffer = workbookToBuffer(wb)
        filename = `現場別出面一覧_${ymStr}.xlsx`
        break
      }

      // 2026-06-XX 追加: 社労士提出用シフト表 (勤務予定)
      // 2026-06-XX 修正: 会社別 (org=hibi/hfu/all) フィルタ対応
      case 'plannedShift': {
        const orgFilter = (searchParams.get('org') || 'all') as 'hibi' | 'hfu' | 'all'
        const orgLabel = orgFilter === 'hibi' ? '_日比建設' : orgFilter === 'hfu' ? '_HFU' : ''
        // siteCalendar のドキュメント ym フィールドは "YYYY-MM" 形式
        const ymDash = `${ymStr.slice(0, 4)}-${ymStr.slice(4, 6)}`
        const calQuery = query(collection(db, 'siteCalendar'), where('ym', '==', ymDash))
        const calSnap = await getDocs(calQuery)
        const siteCalendars: Record<string, Record<string, string>> = {}
        calSnap.forEach(d => {
          const data = d.data()
          if (data.siteId && data.days) {
            siteCalendars[data.siteId] = data.days
          }
        })
        const wb = generatePlannedShiftExcel({
          ym: ymStr,
          workers: main.workers,
          assign: main.assign,
          massign: main.massign,
          sites: main.sites.map(s => ({
            id: s.id,
            name: s.name,
            archived: s.archived,
            workSchedule: (s as { workSchedule?: unknown }).workSchedule as Parameters<typeof generatePlannedShiftExcel>[0]['sites'][number]['workSchedule'],
          })),
          siteCalendars,
          org: orgFilter,
        })
        buffer = workbookToBuffer(wb)
        filename = `勤務予定シフト${orgLabel}_${ymStr}.xlsx`
        break
      }

      // 2026-06-XX 追加: 社労士提出用 実労働時間明細
      // 2026-06-XX 修正: 会社別 (org=hibi/hfu/all) フィルタ対応
      case 'actualHours': {
        const orgFilter = (searchParams.get('org') || 'all') as 'hibi' | 'hfu' | 'all'
        const orgLabel = orgFilter === 'hibi' ? '_日比建設' : orgFilter === 'hfu' ? '_HFU' : ''
        const wb = generateActualHoursExcel({
          ym: ymStr,
          workers: main.workers,
          attD,
          sites: main.sites.map(s => ({
            id: s.id,
            name: s.name,
            workSchedule: (s as { workSchedule?: unknown }).workSchedule as Parameters<typeof generateActualHoursExcel>[0]['sites'][number]['workSchedule'],
          })),
          org: orgFilter,
        })
        buffer = workbookToBuffer(wb)
        filename = `実労働時間明細${orgLabel}_${ymStr}.xlsx`
        break
      }

      // 2026-06-XX 追加: 変形労働 カレンダー周知・同意台帳
      //   「誰が・いつ・どの現場の・どの月のカレンダーを承認したか」の台帳（社労士・労基署提出用）。
      //   正本は永続アーカイブ calendarSignLog（承認取消/初期化でも消えない・任意の過去月を出力可）。
      //   現行ロスター情報（未署名者の把握）のため loadCalendarMatrix も併用して和集合を取る。
      case 'consentLedger': {
        const ymDash = `${ymStr.slice(0, 4)}-${ymStr.slice(4, 6)}`
        const m = await loadCalendarMatrix(ymDash)

        type LogRow = {
          workerId: number; siteId: string; signedAt?: string; method?: string; ipHash?: string
          resignCount?: number; event?: string; signedDays?: Record<string, string>; calendarApprovedAt?: string
          consentName?: string
        }
        // 永続アーカイブから当月の署名イベントを取得 → (worker,site) ごとに最新を採用
        const logSnap = await getDocs(query(collection(db, 'calendarSignLog'), where('ym', '==', ymDash)))
        const latest: Record<string, LogRow> = {}
        const siteIdsInLog = new Set<string>()
        const workerIdsInLog = new Set<number>()
        const approvedAtFromLog: Record<string, string> = {}
        logSnap.forEach(d => {
          const x = d.data() as LogRow
          if (x.event && x.event !== 'sign' && x.event !== 'resign') return
          siteIdsInLog.add(x.siteId)
          workerIdsInLog.add(Number(x.workerId))
          if (x.calendarApprovedAt && !approvedAtFromLog[x.siteId]) approvedAtFromLog[x.siteId] = x.calendarApprovedAt
          const key = `${x.workerId}_${x.siteId}`
          const prev = latest[key]
          if (!prev || String(x.signedAt || '') > String(prev.signedAt || '')) latest[key] = x
        })

        const siteName = (id: string) => main.sites.find(s => s.id === id)?.name || id
        const workerName = (id: number) => main.workers.find(w => w.id === id)?.name || `ID:${id}`

        // 承認済み現場 = 現行で承認済み ∪ ログに署名がある現場（過去月の復元）
        const approvedFromMatrix = m.sitesWithWorkers
          .filter(sw => m.siteCalendars[sw.site.id]?.status === 'approved')
          .map(sw => sw.site.id)
        const siteIdSet = new Set<string>([...approvedFromMatrix, ...siteIdsInLog])
        const approvedSites = [...siteIdSet].map(id => ({
          siteId: id,
          siteName: siteName(id),
          approvedAt: m.siteCalendars[id]?.approvedAt || approvedAtFromLog[id] || null,
          approvedBy: m.siteCalendars[id]?.approvedBy ?? null,
        }))

        // 対象スタッフ = 現行の署名対象 ∪ ログに記録のあるスタッフ
        const workerIdSet = new Set<number>([...m.eligibleForeignWorkers.map(w => w.id), ...workerIdsInLog])
        const workers = [...workerIdSet].map(id => ({ id, name: workerName(id) }))

        const signs: Record<string, { signedAt?: string; method?: string; ipHash?: string; resignCount?: number; workCount?: number | null; consentName?: string }> = {}
        for (const key of Object.keys(latest)) {
          const x = latest[key]
          const workCount = x.signedDays ? Object.values(x.signedDays).filter(v => v === 'work').length : null
          signs[key] = {
            signedAt: x.signedAt,
            method: x.method,
            ipHash: x.ipHash,
            resignCount: typeof x.resignCount === 'number' ? x.resignCount : 0,
            workCount,
            consentName: x.consentName || '',
          }
        }

        const wb = generateConsentLedger({
          ym: ymStr,
          generatedAt: new Date().toISOString(),
          approvedSites,
          workers,
          signs,
        })
        buffer = workbookToBuffer(wb)
        filename = `カレンダー周知同意台帳_${ymStr}.xlsx`
        break
      }

      default:
        return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
    }

    // Return xlsx binary
    const uint8 = new Uint8Array(buffer)
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': String(buffer.length),
      },
    })
  } catch (error) {
    console.error('Export API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Failed to generate export', detail: errMsg }, { status: 500 })
  }
}
