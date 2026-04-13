import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'
import {
  generateHibiAttendance,
  generateHfuAttendance,
  generateSubconConfirmation,
  generateBukakeReport,
  generatePLLedger,
  generateMonthlyExcel,
  generatePerSiteAttendance,
  workbookToBuffer,
} from '@/lib/export'

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

    let buffer: Buffer
    let filename: string

    switch (type) {
      case 'hibi': {
        const wb = generateHibiAttendance({
          ym: ymStr,
          workers: main.workers,
          attD,
          sites: activeSites,
          assign: main.assign,
          massign: main.massign,
        })
        buffer = workbookToBuffer(wb)
        filename = `日比建設_出面一覧_${ymStr}.xlsx`
        break
      }

      case 'hfu': {
        const wb = generateHfuAttendance({
          ym: ymStr,
          workers: main.workers,
          attD,
          sites: activeSites,
          assign: main.assign,
          massign: main.massign,
        })
        buffer = workbookToBuffer(wb)
        filename = `HFU_出面一覧_${ymStr}.xlsx`
        break
      }

      case 'subcon': {
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
        const result = computeMonthly(main, attD, attSD, ymStr, 0, undefined, baseDays)
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
        const result = computeMonthly(main, attD, attSD, ymStr, 0, undefined, baseDays)
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
        const prescribedDays = Number(searchParams.get('prescribedDays')) || 0
        const orgFilter = searchParams.get('org') || 'all'
        const monthlyResult = computeMonthly(main, attD, attSD, ymStr, prescribedDays, undefined, baseDays)
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
