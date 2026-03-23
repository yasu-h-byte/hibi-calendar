import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { AttendanceEntry } from '@/types'
import { ymKey } from './attendance'

// ────────────────────────────────────────
//  Firestoreデータ読み込み
// ────────────────────────────────────────

export interface MainData {
  workers: RawWorker[]
  sites: RawSite[]
  subcons: RawSubcon[]
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
  billing: Record<string, number[]>
  workDays: Record<string, number>
  locks: Record<string, boolean>
  plData: Record<string, PLRecord[]>
  defaultRates: { tobiRate?: number; dokoRate?: number }
}

export interface RawWorker {
  id: number; name: string; org: string; visa: string; job: string
  rate: number; otMul: number; hireDate: string; retired?: string; token: string
}

export interface RawSite {
  id: string; name: string; start: string; end: string
  foreman: number; archived: boolean
  tobiRate?: number; dokoRate?: number
  rates?: { period: string; tobiRate: number; dokoRate: number }[]
}

export interface RawSubcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
}

export interface PLRecord {
  fy: string
  grantDate: string
  grantDays: number
  carryOver: number
  adjustment: number
  used: number
}

export async function getMainData(): Promise<MainData> {
  const docSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!docSnap.exists()) throw new Error('Main doc not found')
  const d = docSnap.data()
  return {
    workers: (d.workers || []) as RawWorker[],
    sites: (d.sites || []) as RawSite[],
    subcons: (d.subcons || []) as RawSubcon[],
    assign: (d.assign || {}) as Record<string, { workers?: number[]; subcons?: string[] }>,
    massign: (d.massign || {}) as Record<string, { workers?: number[]; subcons?: string[] }>,
    billing: (d.billing || {}) as Record<string, number[]>,
    workDays: (d.workDays || {}) as Record<string, number>,
    locks: (d.locks || {}) as Record<string, boolean>,
    plData: (d.plData || {}) as Record<string, PLRecord[]>,
    defaultRates: (d.defaultRates || {}) as { tobiRate?: number; dokoRate?: number },
  }
}

export async function getAttData(ym: string): Promise<{
  d: Record<string, AttendanceEntry>
  sd: Record<string, { n: number; on: number }>
  approvals?: Record<string, boolean>
}> {
  const docSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
  if (!docSnap.exists()) return { d: {}, sd: {} }
  const data = docSnap.data()
  return {
    d: (data.d || {}) as Record<string, AttendanceEntry>,
    sd: (data.sd || {}) as Record<string, { n: number; on: number }>,
    approvals: (data.approvals || undefined) as Record<string, boolean> | undefined,
  }
}

// ────────────────────────────────────────
//  月次集計エンジン
// ────────────────────────────────────────

export interface WorkerMonthly {
  id: number
  name: string
  org: string
  visa: string
  job: string
  rate: number
  otMul: number
  sites: string[]
  workDays: number
  otHours: number
  plDays: number
  restDays: number
  siteOffDays: number
  cost: number
  otCost: number
  totalCost: number
}

export interface SubconMonthly {
  id: string
  name: string
  type: string
  rate: number
  otRate: number
  sites: string[]
  workDays: number
  otCount: number
  cost: number
}

export interface SiteSummary {
  id: string
  name: string
  workDays: number
  subWorkDays: number
  cost: number
  subCost: number
  billing: number
  profit: number
  profitRate: number
}

export function computeMonthly(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
): {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  sites: SiteSummary[]
  totals: { workDays: number; subWorkDays: number; cost: number; subCost: number; billing: number; profit: number; otHours: number }
} {
  const activeSites = main.sites.filter(s => !s.archived)

  // Worker monthly
  const workerMap = new Map<number, WorkerMonthly>()
  for (const w of main.workers) {
    if (w.retired) continue
    workerMap.set(w.id, {
      id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      rate: w.rate, otMul: w.otMul, sites: [],
      workDays: 0, otHours: 0, plDays: 0, restDays: 0, siteOffDays: 0,
      cost: 0, otCost: 0, totalCost: 0,
    })
  }

  // Subcon monthly
  const subconMap = new Map<string, SubconMonthly>()
  for (const sc of main.subcons) {
    subconMap.set(sc.id, {
      id: sc.id, name: sc.name, type: sc.type, rate: sc.rate, otRate: sc.otRate,
      sites: [], workDays: 0, otCount: 0, cost: 0,
    })
  }

  // Site summary
  const siteMap = new Map<string, SiteSummary>()
  for (const s of activeSites) {
    siteMap.set(s.id, {
      id: s.id, name: s.name,
      workDays: 0, subWorkDays: 0, cost: 0, subCost: 0,
      billing: 0, profit: 0, profitRate: 0,
    })
  }

  // Process attendance data
  for (const [key, entry] of Object.entries(attD)) {
    const parts = key.split('_')
    if (parts.length < 4) continue
    const siteId = parts[0]
    const wid = parseInt(parts[1])
    const entryYm = parts[2]
    if (entryYm !== ym) continue

    const wm = workerMap.get(wid)
    if (!wm) continue

    if (entry.w && entry.w > 0) {
      wm.workDays += entry.w
      if (entry.o && entry.o > 0) wm.otHours += entry.o
      if (!wm.sites.includes(siteId)) wm.sites.push(siteId)

      const site = siteMap.get(siteId)
      if (site) site.workDays += entry.w
    }
    if (entry.p) wm.plDays += 1
    if (entry.r) wm.restDays += 1
    if (entry.h) wm.siteOffDays += 1
  }

  // Process subcon data
  for (const [key, entry] of Object.entries(attSD)) {
    const parts = key.split('_')
    if (parts.length < 4) continue
    const siteId = parts[0]
    const scid = parts[1]
    const entryYm = parts[2]
    if (entryYm !== ym) continue

    const sc = subconMap.get(scid)
    if (!sc) continue

    if (entry.n > 0) {
      sc.workDays += entry.n
      sc.otCount += entry.on || 0
      if (!sc.sites.includes(siteId)) sc.sites.push(siteId)

      const site = siteMap.get(siteId)
      if (site) site.subWorkDays += entry.n
    }
  }

  // Calculate costs
  Array.from(workerMap.values()).forEach(wm => {
    wm.cost = wm.workDays * wm.rate
    wm.otCost = wm.otHours * (wm.rate / 8) * wm.otMul
    wm.totalCost = wm.cost + wm.otCost

    // Add to site costs
    for (const sid of wm.sites) {
      const site = siteMap.get(sid)
      if (site) site.cost += wm.totalCost / wm.sites.length
    }
  })

  Array.from(subconMap.values()).forEach(sc => {
    sc.cost = sc.workDays * sc.rate + sc.otCount * sc.otRate

    for (const sid of sc.sites) {
      const site = siteMap.get(sid)
      if (site) site.subCost += sc.cost / sc.sites.length
    }
  })

  // Billing & profit
  Array.from(siteMap.values()).forEach(site => {
    const billingKey = `${site.id}_${ym}`
    const billings = main.billing[billingKey] || []
    site.billing = billings.reduce((sum, v) => sum + v, 0)
    site.profit = site.billing - site.cost - site.subCost
    site.profitRate = site.billing > 0 ? (site.profit / site.billing) * 100 : 0
  })

  // Round all floating point values to avoid JavaScript precision issues
  const r1 = (v: number) => Math.round(v * 10) / 10
  const r0 = (v: number) => Math.round(v)

  const workers = Array.from(workerMap.values()).filter(w => w.workDays > 0 || w.plDays > 0)
  workers.forEach(w => {
    w.workDays = r1(w.workDays)
    w.otHours = r1(w.otHours)
    w.cost = r0(w.cost)
    w.otCost = r0(w.otCost)
    w.totalCost = r0(w.totalCost)
  })

  const subcons = Array.from(subconMap.values()).filter(sc => sc.workDays > 0)
  subcons.forEach(sc => {
    sc.workDays = r1(sc.workDays)
    sc.cost = r0(sc.cost)
  })

  const sites = Array.from(siteMap.values())
  sites.forEach(s => {
    s.workDays = r1(s.workDays)
    s.subWorkDays = r1(s.subWorkDays)
    s.cost = r0(s.cost)
    s.subCost = r0(s.subCost)
    s.profit = r0(s.profit)
    s.profitRate = r1(s.profitRate)
  })

  const totals = {
    workDays: r1(workers.reduce((s, w) => s + w.workDays, 0)),
    subWorkDays: r1(subcons.reduce((s, sc) => s + sc.workDays, 0)),
    cost: r0(workers.reduce((s, w) => s + w.totalCost, 0)),
    subCost: r0(subcons.reduce((s, sc) => s + sc.cost, 0)),
    billing: r0(sites.reduce((s, st) => s + st.billing, 0)),
    profit: r0(sites.reduce((s, st) => s + st.profit, 0)),
    otHours: r1(workers.reduce((s, w) => s + w.otHours, 0)),
  }

  return { workers, subcons, sites, totals }
}

// ────────────────────────────────────────
//  ヘルパー
// ────────────────────────────────────────

export function formatCurrency(value: number): string {
  if (Math.abs(value) >= 10000) {
    return `¥${(value / 10000).toFixed(1)}万`
  }
  return `¥${value.toLocaleString()}`
}

export function formatYen(value: number): string {
  return `¥${value.toLocaleString()}`
}

export function isLocked(locks: Record<string, boolean>, ym: string): boolean {
  return !!locks[ym]
}

export function getYmOptions(count: number = 6): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    result.push({ ym: ymKey(y, m), label: `${y}年${m}月` })
  }
  return result
}
