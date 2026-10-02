import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import { getMainData, type MainData } from '@/lib/compute'
import { getAttendanceDoc, getApprovalForDay, setFinalApprovalForDay } from '@/lib/attendance'
import { approvingForemenOfSite, isProxyApprovalSite } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { getDocs, collection, query, where } from '@/lib/fsdb'
import {
  siteMonthDays, approveDaysForSite, siteRosterFromMain, foremanParentSites, foremanTodoMonths,
  getForemenOfWorkerSites, managerByToken, findStaleAssignments, type ForemanDay,
} from '@/lib/foreman-todo'
import type { AttendanceEntry, Site } from '@/types'
import { todayJstIso } from '@/lib/date-utils'

/**
 * マイページの「承認すること」（2026-10-01 代表依頼）
 *
 * 職長（職種が職長で、その月の現場の職長に登録されている人）:
 *   出面（前月・今月）のまとめ職長承認・有給／帰国申請の職長承認
 * 政仁さん・代表（管理者・事業責任者）:
 *   出面の最終承認（職長承認済みの日）・有給／帰国申請の最終承認・
 *   職長がいない現場（とび・役員が登録）の職長承認の代行・配置の見直し（移動したのに前の現場に残っている人）
 *
 * GET  ?token=
 * POST {token, action:'approve_days' | 'final_days', siteId, ym, days}
 * 有給・帰国申請の承認／却下は既存 API（/api/leave-request・/api/home-long-leave）に token を付けて呼ぶ。
 */

type Mforeman = Record<string, { foreman?: number; wid?: number }>
const ymLabel = (ym: string) => `${Number(ym.slice(4, 6))}月`

interface ForemanBlock {
  siteId: string; siteName: string; ym: string; ymLabel: string
  ready: { day: number; dateISO: string; entered: number }[]
  missing: { day: number; dateISO: string; missingNames: string[] }[]
  /** 配置に残っているが別の現場で入力している人（未入力に数えていない） */
  elsewhereNames: string[]
  /** 配置に入っていないのにこの現場に入力がある人（現場の選び間違いの疑い・2026-10-02） */
  offRoster: { day: number; dateISO: string; names: string[] }[]
  approvedCount: number
  /** 政仁さんが代行する現場か */
  proxy?: boolean
}
interface FinalBlock {
  siteId: string; siteName: string; ym: string; ymLabel: string
  days: { day: number; dateISO: string }[]
  finalCount: number
}

/** 職長承認の一覧（1現場×1か月） */
function foremanBlock(site: Site, ym: string, days: ForemanDay[], todayIso: string, proxy = false): ForemanBlock | null {
  // 非稼働日は入力のあった日だけ。対象は入力した人だけなので（evaluateSiteDay）、入力がそろえば承認に出る
  const open = days.filter(d => !d.approved && (d.isWorkDay || d.entered > 0))
  const ready = open.filter(d => d.total > 0 && d.entered === d.total)
  // 今日はまだ入力の途中なので「そろっていない」に出さない（全員そろえば承認には出る）
  const missing = open.filter(d => d.entered < d.total && d.dateISO < todayIso)
  if (ready.length === 0 && missing.length === 0 && !days.some(d => d.approved) && !days.some(d => d.offRoster.length > 0)) return null
  return {
    siteId: site.id, siteName: site.name, ym, ymLabel: ymLabel(ym),
    ready: ready.map(d => ({ day: d.day, dateISO: d.dateISO, entered: d.entered })),
    missing: missing.map(d => ({ day: d.day, dateISO: d.dateISO, missingNames: d.missingNames })),
    elsewhereNames: [...new Set(open.flatMap(d => d.elsewhere.map(e => e.name)))],
    offRoster: days.filter(d => !d.approved && d.offRoster.length > 0).map(d => ({ day: d.day, dateISO: d.dateISO, names: d.offRoster })),
    approvedCount: days.filter(d => d.approved).length,
    proxy,
  }
}

const parentSites = (main: MainData) =>
  (main.sites as unknown as Site[]).filter(s => !s.archived && !(s as { parentId?: string }).parentId)

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })
  try {
    const worker = await getWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    const manager = await managerByToken(token)

    // 承認欄を出すのは、職種が職長の人と、政仁さん・代表だけ（2026-10-01 代表決定）
    if (!manager && worker.jobType !== 'shokucho') {
      return NextResponse.json({ isForeman: false, role: null, attendance: [], finalAttendance: [], leaveRequests: [], homeLeaves: [], stale: [] })
    }

    const main = await getMainData()
    const sites = main.sites as unknown as Site[]
    const mforeman = (main.mforeman || {}) as Mforeman
    const months = foremanTodoMonths()
    const todayIso = todayJstIso()
    const siteName = (id: string) => sites.find(s => s.id === id)?.name || id

    // 有給・帰国申請は出面と同時に読み始める（管理者は職長承認済みも読む）
    const leaveStatuses = manager ? ['pending', 'foreman_approved'] : ['pending']
    const leavePromise = Promise.all(leaveStatuses.map(st => getDocs(query(collection(db, 'leaveRequests'), where('status', '==', st)))))
    const hlPromise = Promise.all(leaveStatuses.map(st => getDocs(query(collection(db, 'homeLongLeave'), where('status', '==', st)))))

    // ── 出面（2か月を同時に。出面ドキュメントは月ごとに1回だけ読む） ──
    const attByYm = new Map<string, Record<string, AttendanceEntry>>()
    const perMonth = await Promise.all(months.map(async ym => {
      const att = await getAttendanceDoc(ym)
      attByYm.set(ym, att)
      // 職長: 自分の現場／管理者: すべての親現場（職長承認の代行と最終承認）
      const targets = manager ? parentSites(main) : foremanParentSites(worker, sites, mforeman, ym)
      return Promise.all(targets.map(async site => {
        const proxy = isProxyApprovalSite(site, mforeman, ym, main.workers)
        // 管理者が職長承認するのは代行の現場だけ
        const needForeman = !manager || proxy
        // 承認は現場×月まとめて1回の範囲読み・外国人スタッフ0人の現場はカレンダーも読まない（読み取りを減らす・2026-10-01）
        const days = await siteMonthDays(site.id, ym, { att, ...siteRosterFromMain(main, site.id, ym), skipCalendarIfNoWorkers: true })
        const fb = needForeman ? foremanBlock(site, ym, days, todayIso, !!manager && proxy) : null
        let final: FinalBlock | null = null
        if (manager) {
          const waiting = days.filter(d => d.approved && !d.final)
          if (waiting.length > 0) {
            final = {
              siteId: site.id, siteName: site.name, ym, ymLabel: ymLabel(ym),
              days: waiting.map(d => ({ day: d.day, dateISO: d.dateISO })),
              finalCount: days.filter(d => d.final).length,
            }
          }
        }
        return { fb, final }
      }))
    }))
    const attendance: ForemanBlock[] = []
    const finalAttendance: FinalBlock[] = []
    for (const blocks of perMonth) for (const b of blocks) {
      if (b.fb) attendance.push(b.fb)
      if (b.final) finalAttendance.push(b.final)
    }

    // ── 有給申請 ──
    //   職長: 自分の現場の職長確認待ち（自分の申請は除く）
    //   管理者: 職長承認済み（最終承認）＋ 職長がいない現場の確認待ち（代行して最終承認まで）
    const leaveSnaps = await leavePromise
    const leaveRequests: { id: string; workerName: string; date: string; reason: string; siteName: string; stage: 'foreman' | 'final' | 'proxy' }[] = []
    for (const snap of leaveSnaps) snap.forEach(d => {
      const r = d.data() as { workerId: number; workerName: string; date: string; reason?: string; siteId: string; ym: string; status: string }
      if (r.workerId === worker.id) return
      const site = sites.find(s => s.id === r.siteId)
      const approvers = site ? approvingForemenOfSite(site, mforeman, r.ym, main.workers) : []
      let stage: 'foreman' | 'final' | 'proxy' | null = null
      if (manager) stage = r.status === 'foreman_approved' ? 'final' : approvers.length === 0 ? 'proxy' : null
      else stage = r.status === 'pending' && approvers.includes(worker.id) ? 'foreman' : null
      if (stage) leaveRequests.push({ id: d.id, workerName: r.workerName, date: r.date, reason: r.reason || '', siteName: siteName(r.siteId), stage })
    })
    leaveRequests.sort((a, b) => a.date.localeCompare(b.date))

    // ── 帰国申請（同じ決まり） ──
    const hlSnaps = await hlPromise
    type HL = { id: string; workerName: string; startDate: string; endDate: string; reason: string; stage: 'foreman' | 'final' | 'proxy' }
    const homeLeaves = (await Promise.all(hlSnaps.flatMap(s => s.docs).map(async (d): Promise<HL | null> => {
      const r = d.data() as { workerId: number; workerName: string; startDate: string; endDate: string; reason?: string; status: string }
      if (r.workerId === worker.id) return null
      const base = { id: d.id, workerName: r.workerName, startDate: r.startDate, endDate: r.endDate, reason: r.reason || '' }
      if (manager) {
        if (r.status === 'foreman_approved') return { ...base, stage: 'final' }
        return (await getForemenOfWorkerSites(r.workerId)).size === 0 ? { ...base, stage: 'proxy' } : null
      }
      return (await getForemenOfWorkerSites(r.workerId)).has(worker.id) ? { ...base, stage: 'foreman' } : null
    }))).filter((x): x is HL => !!x)
    homeLeaves.sort((a, b) => a.startDate.localeCompare(b.startDate))

    // ── 配置の見直し（管理者だけ。上で読んだ前月・今月の出面を使う） ──
    const stale = manager
      ? findStaleAssignments(main, Object.assign({}, ...[...attByYm.values()]), todayIso)
      : []

    return NextResponse.json({
      isForeman: true, role: manager ? 'manager' : 'foreman',
      attendance, finalAttendance, leaveRequests, homeLeaves, stale,
    })
  } catch (error) {
    console.error('mypage approvals GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, action, siteId, ym, days } = body as { token?: string; action?: string; siteId?: string; ym?: string; days?: number[] }
    if (!token || (action !== 'approve_days' && action !== 'final_days')) {
      return NextResponse.json({ error: 'token and action required' }, { status: 400 })
    }
    if (!siteId || !ym || !/^\d{6}$/.test(ym) || !Array.isArray(days) || days.length === 0 || days.length > 31) {
      return NextResponse.json({ error: '現場・月・日（1〜31件）を指定してください' }, { status: 400 })
    }
    if (!foremanTodoMonths().includes(ym)) {
      return NextResponse.json({ error: '前月と今月の出面だけ承認できます' }, { status: 400 })
    }
    const worker = await getWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    const manager = await managerByToken(token)
    const main = await getMainData()
    const site = parentSites(main).find(s => s.id === siteId)
    if (!site) return NextResponse.json({ error: '現場が見つかりません' }, { status: 404 })
    const mforeman = (main.mforeman || {}) as Mforeman

    if (action === 'approve_days') {
      // 職長: その月にその現場の職長（職種が職長）／管理者: 職長がいない現場の代行だけ
      const isForeman = foremanParentSites(worker, main.sites as unknown as Site[], mforeman, ym).some(s => s.id === siteId)
      const isProxy = !!manager && isProxyApprovalSite(site, mforeman, ym, main.workers)
      if (!isForeman && !isProxy) {
        return NextResponse.json({ error: 'この現場の職長承認はできません' }, { status: 403 })
      }
      const result = await approveDaysForSite(siteId, ym, days, worker.id)
      return NextResponse.json({ success: true, ...result })
    }

    // final_days: 最終承認は管理者・事業責任者だけ。職長承認済みの日だけ（PC の approve_final と同じ条件）
    if (!manager) return NextResponse.json({ error: '最終承認は管理者・事業責任者のみ実行できます' }, { status: 403 })
    const approvedDays: number[] = []
    const skipped: { day: number; reason: string }[] = []
    for (const dd of days) {
      const d = Number(dd)
      if (!Number.isInteger(d) || d < 1 || d > 31) { skipped.push({ day: d, reason: '不正な日付' }); continue }
      const cur = await getApprovalForDay(siteId, ym, d)
      if (!cur?.foreman) { skipped.push({ day: d, reason: '職長承認がまだ' }); continue }
      if (cur.final) { skipped.push({ day: d, reason: '最終承認済み' }); continue }
      await setFinalApprovalForDay(siteId, ym, d, manager.id)
      approvedDays.push(d)
    }
    return NextResponse.json({ success: true, approvedDays, skipped })
  } catch (error) {
    console.error('mypage approvals POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
