import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'
import {
  generateHibiAttendance,
  generateHfuAttendance,
  generateSubconConfirmation,
  generateBukakeReport,
  generatePLLedger,
  workbookToBuffer,
} from '@/lib/export'

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
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
        const result = computeMonthly(main, attD, attSD, ymStr)
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
        const wb = generatePLLedger({
          workers: main.workers,
          plData: main.plData,
        })
        buffer = workbookToBuffer(wb)
        filename = '有給管理台帳.xlsx'
        break
      }

      case 'monthly': {
        // Monthly report: return JSON data for client-side print rendering
        const result = computeMonthly(main, attD, attSD, ymStr)
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

      default:
        return NextResponse.json({ error: 'Unknown type. Valid: hibi, hfu, subcon, bukake, monthly, pl' }, { status: 400 })
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
    return NextResponse.json({ error: 'Failed to generate export' }, { status: 500 })
  }
}
