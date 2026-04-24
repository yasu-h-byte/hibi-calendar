import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { generateLeaveLedger, workbookToBuffer, LeaveLedgerWorker, LeaveLedgerRecord } from '@/lib/export'
import { AttendanceEntry } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const main = await getMainData()

    // 全期間の出面データ (過去3年+当年)
    const now = new Date()
    const currentYear = now.getFullYear()
    const allAtt: Record<string, AttendanceEntry> = {}
    for (let y = currentYear - 3; y <= currentYear; y++) {
      for (let m = 1; m <= 12; m++) {
        const att = await getAttData(ymKey(y, m))
        Object.assign(allAtt, att.d)
      }
    }

    // 対象ワーカー（役員・事務除外）
    const workers: LeaveLedgerWorker[] = main.workers
      .filter(w => w.job !== 'yakuin' && w.job !== 'jimu')
      .map(w => ({
        id: w.id,
        name: w.name,
        org: w.org || '',
        visa: w.visa || 'none',
        hireDate: w.hireDate,
        retired: Boolean(w.retired),
      }))

    const plData = (main.plData || {}) as Record<string, LeaveLedgerRecord[]>

    const wb = generateLeaveLedger({ workers, plData, allAtt })
    const buffer = workbookToBuffer(wb)

    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const filename = `有給管理簿_${dateStr}.xlsx`

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    })
  } catch (error) {
    console.error('Export ledger error:', error)
    return NextResponse.json({ error: 'Server error', detail: String(error) }, { status: 500 })
  }
}
