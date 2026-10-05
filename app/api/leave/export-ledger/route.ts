import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, requireCap, callerCan } from '@/lib/auth'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import type { LeaveLedgerWorker, LeaveLedgerRecord } from '@/lib/export'
import { generateLeaveLedger, leaveLedgerToBuffer, leaveLedgerFilename, parseLedgerScope, parseLedgerRange } from '@/lib/leave-ledger'
import { AttendanceEntry } from '@/types'
import { currentYearJst, todayJstIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // 2026-09-26: 読み取りも権限表どおり（lib/permissions.ts leave.view）。旧: ログインしていれば職長でも読めた
  { const denied = await requireCap(request, 'leave.view'); if (denied) return denied }

  try {
    const main = await getMainData()

    // 全期間の出面データ (過去3年+当年+来年)
    // 2026-10-02 総合点検: 来年分も読む。承認済みの来年1〜2月（テト帰国）の有給が、休暇管理の残（来年分まで読む）には
    //   引かれ、管理簿には引かれていなかった
    const currentYear = currentYearJst()
    const allAtt: Record<string, AttendanceEntry> = {}
    for (let y = currentYear - 3; y <= currentYear + 1; y++) {
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
        // 2026-06-XX: retired は YYYY-MM-DD 文字列。空 → 未退職
        retired: w.retired || '',
      }))

    const plDataRaw = (main.plData || {}) as Record<string, LeaveLedgerRecord[]>
    // 有給買取の金額（精勤賞与の額）は給与を見られる人だけ（給与の鍵・2026-10-02 総点検）
    const canSeePay = await callerCan(request, 'pay.view')
    const plData = canSeePay ? plDataRaw : Object.fromEntries(Object.entries(plDataRaw).map(([k, recs]) => [k, recs.map(r => ({
      ...r, buyoutHistory: r.buyoutHistory?.map(h => ({ ...h, amount: undefined })),
    }))]))

    // 出し分け（2026-10-05）: scope = hibi / hfu（会社ごと）・jp（日本人）・vn（ベトナム人など外国人）・省略時は全社。
    //   range = all で全期間（既定は今の期と前の期）。旧 ?org=hibi|hfu も受ける
    const sp = request.nextUrl.searchParams
    const scope = parseLedgerScope(sp.get('scope') || sp.get('org'))
    const range = parseLedgerRange(sp.get('range'))
    const todayIso = todayJstIso()
    const wb = generateLeaveLedger({ workers, plData, allAtt }, { scope, range, todayIso })
    const buffer = leaveLedgerToBuffer(wb)
    const filename = leaveLedgerFilename(scope, range, todayIso)

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
