import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import { getMainData } from '@/lib/compute'
import { getAttendanceDoc } from '@/lib/attendance'
import { approvingForemenOfSite } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { getDocs, collection, query, where } from '@/lib/fsdb'
import {
  siteMonthDays, approveDaysForSite, foremanParentSites, foremanTodoMonths, getForemenOfWorkerSites,
} from '@/lib/foreman-todo'
import type { Site } from '@/types'
import { todayJstIso } from '@/lib/date-utils'

/**
 * 職長のマイページの「承認すること」（2026-10-01 代表依頼）
 *
 * GET  ?token=  … 担当現場の出面（前月・今月）・有給申請・帰国申請のうち、職長の確認待ちを返す
 * POST {token, action:'approve_days', siteId, ym, days} … 出面のまとめ承認
 *
 * 有給・帰国申請の承認／却下は既存 API（/api/leave-request・/api/home-long-leave）に token を付けて呼ぶ。
 * 職長がするのは「確認」まで。最終承認は事業責任者（政仁さん）が PC で行う（承認フローの原則）。
 */

type Mforeman = Record<string, { foreman?: number; wid?: number }>
const ymLabel = (ym: string) => `${Number(ym.slice(4, 6))}月`

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })
  try {
    const worker = await getWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // 承認欄を出すのは職種が職長の人だけ（職長でない人が現場の職長に登録されている現場は政仁さんが代行・2026-10-01 代表）
    if (worker.jobType !== 'shokucho') return NextResponse.json({ isForeman: false, attendance: [], leaveRequests: [], homeLeaves: [] })

    const main = await getMainData()
    const sites = main.sites as unknown as Site[]
    const mforeman = (main.mforeman || {}) as Mforeman
    const months = foremanTodoMonths()
    const todayIso = todayJstIso()

    // ── 出面: 担当現場 × 前月・今月 ──
    const attendance: {
      siteId: string; siteName: string; ym: string; ymLabel: string
      ready: { day: number; dateISO: string; entered: number }[]
      missing: { day: number; dateISO: string; missingNames: string[] }[]
      approvedCount: number
    }[] = []
    for (const ym of months) {
      const mySites = foremanParentSites(worker, sites, mforeman, ym)
      if (mySites.length === 0) continue
      // 出面ドキュメント（1件200〜300KB）は月ごとに1回だけ読む（CLAUDE.md の読み取りルール）
      const att = await getAttendanceDoc(ym)
      for (const site of mySites) {
        const days = await siteMonthDays(site.id, ym, { att })
        const open = days.filter(d => !d.approved && (d.isWorkDay || d.entered > 0))
        const ready = open.filter(d => d.total > 0 && d.entered === d.total)
        // 今日はまだ入力の途中なので「そろっていない」に出さない（全員そろえば承認には出る）
        const missing = open.filter(d => d.entered < d.total && d.dateISO < todayIso)
        // 誰も配置されていない現場・何も無い月は出さない
        if (ready.length === 0 && missing.length === 0 && !days.some(d => d.approved)) continue
        attendance.push({
          siteId: site.id, siteName: site.name, ym, ymLabel: ymLabel(ym),
          ready: ready.map(d => ({ day: d.day, dateISO: d.dateISO, entered: d.entered })),
          missing: missing.map(d => ({ day: d.day, dateISO: d.dateISO, missingNames: d.missingNames })),
          approvedCount: days.filter(d => d.approved).length,
        })
      }
    }

    // ── 有給申請: 職長の確認待ち（自分の申請は除く・自分で自分は承認できない） ──
    const siteName = (id: string) => sites.find(s => s.id === id)?.name || id
    const leaveSnap = await getDocs(query(collection(db, 'leaveRequests'), where('status', '==', 'pending')))
    const leaveRequests: { id: string; workerName: string; date: string; reason: string; siteName: string }[] = []
    leaveSnap.forEach(d => {
      const r = d.data() as { workerId: number; workerName: string; date: string; reason?: string; siteId: string; ym: string }
      if (r.workerId === worker.id) return
      const site = sites.find(s => s.id === r.siteId)
      if (!site || !approvingForemenOfSite(site, mforeman, r.ym, main.workers).includes(worker.id)) return
      leaveRequests.push({ id: d.id, workerName: r.workerName, date: r.date, reason: r.reason || '', siteName: siteName(r.siteId) })
    })
    leaveRequests.sort((a, b) => a.date.localeCompare(b.date))

    // ── 帰国申請: 職長の確認待ち ──
    const hlSnap = await getDocs(query(collection(db, 'homeLongLeave'), where('status', '==', 'pending')))
    const homeLeaves: { id: string; workerName: string; startDate: string; endDate: string; reason: string }[] = []
    for (const d of hlSnap.docs) {
      const r = d.data() as { workerId: number; workerName: string; startDate: string; endDate: string; reason?: string }
      if (r.workerId === worker.id) continue
      if (!(await getForemenOfWorkerSites(r.workerId)).has(worker.id)) continue
      homeLeaves.push({ id: d.id, workerName: r.workerName, startDate: r.startDate, endDate: r.endDate, reason: r.reason || '' })
    }
    homeLeaves.sort((a, b) => a.startDate.localeCompare(b.startDate))

    return NextResponse.json({ isForeman: true, attendance, leaveRequests, homeLeaves })
  } catch (error) {
    console.error('mypage approvals GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, action, siteId, ym, days } = body as { token?: string; action?: string; siteId?: string; ym?: string; days?: number[] }
    if (!token || action !== 'approve_days') return NextResponse.json({ error: 'token and action required' }, { status: 400 })
    if (!siteId || !ym || !/^\d{6}$/.test(ym) || !Array.isArray(days) || days.length === 0 || days.length > 31) {
      return NextResponse.json({ error: '現場・月・日（1〜31件）を指定してください' }, { status: 400 })
    }
    const worker = await getWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // その月にその現場の職長であること（月別職長込み）。前月・今月以外は受け付けない
    if (!foremanTodoMonths().includes(ym)) {
      return NextResponse.json({ error: '前月と今月の出面だけ承認できます' }, { status: 400 })
    }
    const main = await getMainData()
    const mine = foremanParentSites(worker, main.sites as unknown as Site[], (main.mforeman || {}) as Mforeman, ym)
    if (!mine.some(s => s.id === siteId)) {
      return NextResponse.json({ error: 'この現場の職長ではありません' }, { status: 403 })
    }

    const result = await approveDaysForSite(siteId, ym, days, worker.id)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('mypage approvals POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
