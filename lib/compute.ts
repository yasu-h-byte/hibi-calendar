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
  assign: Record<string, { workers?: number[]; subcons?: string[]; dispatch?: number[]; subconRates?: Record<string, { rate?: number; otRate?: number }> }>
  massign: Record<string, { workers?: number[]; subcons?: string[]; dispatch?: number[] }>
  billing: Record<string, number[]>
  workDays: Record<string, number>
  siteWorkDays: Record<string, Record<string, number>> // { YYYYMM: { siteId: count } }
  locks: Record<string, boolean>
  plData: Record<string, PLRecord[]>
  defaultRates: { tobiRate?: number; dokoRate?: number }
  mforeman: Record<string, { foreman?: number; wid?: number; note?: string }>
}

export interface RawWorker {
  id: number; name: string; org: string; visa: string; job: string
  rate: number; hourlyRate?: number; otMul: number; hireDate: string; retired?: string; token: string
  salary?: number; memo?: string; grantMonth?: number
}

export interface RawSite {
  id: string; name: string; start: string; end: string
  foreman: number; archived: boolean
  tobiRate?: number; dokoRate?: number
  rates?: { from: string; tobiRate: number; dokoRate: number }[]
}

export interface RawSubcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
}

export interface PLRecord {
  fy: string | number
  grantDate: string
  grantDays: number
  carryOver: number
  adjustment: number
  used: number
  // Legacy fields from old app
  grant?: number
  carry?: number
  adj?: number
}

/** Convert old billing format (single number) to new format (array) */
function normalizeBilling(raw: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') {
      result[k] = [v]
    } else if (Array.isArray(v)) {
      result[k] = v as number[]
    }
  }
  return result
}

export async function getMainData(): Promise<MainData> {
  const docSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!docSnap.exists()) throw new Error('Main doc not found')
  const d = docSnap.data()
  return {
    workers: (d.workers || []) as RawWorker[],
    sites: (d.sites || []) as RawSite[],
    subcons: (d.subcons || []) as RawSubcon[],
    assign: (d.assign || {}) as MainData['assign'],
    massign: (d.massign || {}) as Record<string, { workers?: number[]; subcons?: string[] }>,
    billing: normalizeBilling((d.billing || {}) as Record<string, unknown>),
    workDays: (d.workDays || {}) as Record<string, number>,
    siteWorkDays: (d.siteWorkDays || {}) as Record<string, Record<string, number>>,
    locks: (d.locks || {}) as Record<string, boolean>,
    plData: (d.plData || {}) as Record<string, PLRecord[]>,
    defaultRates: (d.defaultRates || {}) as { tobiRate?: number; dokoRate?: number },
    mforeman: (d.mforeman || {}) as Record<string, { foreman?: number; wid?: number; note?: string }>,
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

/** 複数月の出面データを読み込み・結合 */
export async function getMultiMonthAttData(ymList: string[]): Promise<{
  d: Record<string, AttendanceEntry>
  sd: Record<string, { n: number; on: number }>
  perMonth: Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>
}> {
  const merged = { d: {} as Record<string, AttendanceEntry>, sd: {} as Record<string, { n: number; on: number }> }
  const perMonth = new Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>()
  const results = await Promise.all(ymList.map(ym => getAttData(ym)))
  for (let i = 0; i < ymList.length; i++) {
    const att = results[i]
    Object.assign(merged.d, att.d)
    Object.assign(merged.sd, att.sd)
    perMonth.set(ymList[i], { d: att.d, sd: att.sd })
  }
  return { ...merged, perMonth }
}

// ────────────────────────────────────────
//  キー解析（旧アプリのparseDKeyと同等）
//  キー形式: {siteId}_{workerId}_{ym}_{day}
//  siteIdにアンダースコアが含まれる可能性あり（例: yaesu_night）
// ────────────────────────────────────────
export function parseDKey(k: string): { sid: string; wid: string; ym: string; day: string } {
  const p = k.split('_')
  const day = p[p.length - 1]
  const ym = p[p.length - 2]
  const wid = p[p.length - 3]
  const sid = p.slice(0, p.length - 3).join('_')
  return { sid, wid, ym, day }
}

// ────────────────────────────────────────
//  配置情報取得（旧アプリのgetAssignと同等）
//  massignを最大12ヶ月遡って検索し、見つからなければ
//  グローバルassignにフォールバック
// ────────────────────────────────────────
export function getAssign(
  main: MainData,
  siteId: string,
  ym: string,
): { workers: number[]; subcons: string[]; dispatch: number[] } {
  const mk = `${siteId}_${ym}`
  if (main.massign[mk]) {
    return {
      workers: main.massign[mk].workers || [],
      subcons: main.massign[mk].subcons || [],
      dispatch: main.massign[mk].dispatch || main.assign[siteId]?.dispatch || [],
    }
  }
  let y = parseInt(ym.slice(0, 4))
  let m = parseInt(ym.slice(4, 6))
  for (let i = 0; i < 12; i++) {
    m--
    if (m < 1) { m = 12; y-- }
    const pk = `${siteId}_${ymKey(y, m)}`
    if (main.massign[pk]) {
      return {
        workers: main.massign[pk].workers || [],
        subcons: main.massign[pk].subcons || [],
        dispatch: main.massign[pk].dispatch || main.assign[siteId]?.dispatch || [],
      }
    }
  }
  const a = main.assign[siteId]
  return { workers: a?.workers || [], subcons: a?.subcons || [], dispatch: a?.dispatch || [] }
}

// 出向判定: 指定社員が指定現場で出向扱いかチェック
export function isDispatched(main: MainData, workerId: number, siteId: string, ym: string): boolean {
  const assign = getAssign(main, siteId, ym)
  return assign.dispatch.includes(workerId)
}

// ────────────────────────────────────────
//  外注の現場別単価取得（旧アプリのgetSubconRateと同等）
// ────────────────────────────────────────
export function getSubconRate(
  main: MainData,
  scid: string,
  siteId?: string,
): { rate: number; otRate: number } {
  const sc = main.subcons.find(x => x.id === scid)
  const base = { rate: sc ? sc.rate : 0, otRate: sc ? sc.otRate : 0 }
  if (!siteId) return base
  const a = main.assign[siteId]
  if (!a || !a.subconRates || !a.subconRates[scid]) return base
  const ov = a.subconRates[scid]
  const r = ov.rate || base.rate
  const o = ov.otRate || (r ? Math.round(r / 8 * 1.25) : base.otRate)
  return { rate: r, otRate: o }
}

// ────────────────────────────────────────
//  現場の常用単価・85%単価・換算係数取得
//  （旧アプリのgetSiteRatesと同等）
// ────────────────────────────────────────
export function getSiteRates(
  main: MainData,
  siteId?: string,
  ym?: string,
): { tobiRate: number; dokoRate: number; tobiBase: number; dokoBase: number; dokoRatio: number } {
  const defTobi = main.defaultRates.tobiRate || 36000
  const defDoko = main.defaultRates.dokoRate || 28000
  const defTobiBase = Math.round(defTobi * 0.85)
  const defDokoRatio = defTobiBase > 0 ? Math.round(defDoko * 0.85) / defTobiBase : 0.778

  if (!siteId) {
    return {
      tobiRate: defTobi, dokoRate: defDoko,
      tobiBase: defTobiBase, dokoBase: Math.round(defDoko * 0.85),
      dokoRatio: defDokoRatio,
    }
  }

  const s = main.sites.find(x => x.id === siteId)
  if (!s || !s.rates || s.rates.length === 0) {
    return {
      tobiRate: defTobi, dokoRate: defDoko,
      tobiBase: defTobiBase, dokoBase: Math.round(defDoko * 0.85),
      dokoRatio: defDokoRatio,
    }
  }

  // 期間別: from が <= ym の最後のエントリ
  let ap = s.rates[0]
  if (ym) {
    for (const r of s.rates) {
      if (r.from <= ym) ap = r; else break
    }
  } else {
    ap = s.rates[s.rates.length - 1]
  }

  const tr = ap.tobiRate || defTobi
  const dr = ap.dokoRate || defDoko
  const tb = Math.round(tr * 0.85)
  const db = Math.round(dr * 0.85)
  return {
    tobiRate: tr, dokoRate: dr, tobiBase: tb, dokoBase: db,
    dokoRatio: tb > 0 ? db / tb : defDokoRatio,
  }
}

// ────────────────────────────────────────
//  鳶換算人工の計算（旧アプリのcalcTobiEquivと同等）
// ────────────────────────────────────────
export function calcTobiEquiv(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ymList: { y: number; m: number }[],
  siteId?: string,
): { tobiWork: number; dokoWork: number; tobiOtEq: number; dokoOtEq: number; equiv: number; tobiBase: number } {
  let tobiWork = 0, dokoWork = 0, tobiOtEq = 0, dokoOtEq = 0
  const ymSet = new Set(ymList.map(x => ymKey(x.y, x.m)))

  // 月別に集計（期間別レート適用のため）
  const monthly: Record<string, { tw: number; dw: number; toe: number; doe: number }> = {}

  // 出向者リスト（全現場分をキャッシュ）
  const dispatchCache: Record<string, number[]> = {}
  function getDispatchList(sid: string, ym: string): number[] {
    const ck = `${sid}_${ym}`
    if (!(ck in dispatchCache)) {
      const a = getAssign(main, sid, ym)
      dispatchCache[ck] = a.dispatch
    }
    return dispatchCache[ck]
  }

  // 個人
  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    if (!ymSet.has(pk.ym)) continue
    if (siteId && pk.sid !== siteId) continue
    if (v.p || !v.w) continue
    const w = main.workers.find(x => x.id === parseInt(pk.wid))
    if (!w) continue
    // 出向者: 鳶換算人工から除外
    const dispList = getDispatchList(pk.sid, pk.ym)
    if (dispList.includes(w.id)) continue
    // 休業補償(0.6): 外国人の会社都合休業 → 鳶換算から除外
    const isComp = (v.w === 0.6 && w.visa !== 'none')
    if (isComp) continue
    const stdH = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h（変形労働時間制）
    const oe = (v.o || 0) / stdH
    if (!monthly[pk.ym]) monthly[pk.ym] = { tw: 0, dw: 0, toe: 0, doe: 0 }
    if (w.job === 'doko') {
      monthly[pk.ym].dw += v.w; monthly[pk.ym].doe += oe; dokoWork += v.w; dokoOtEq += oe
    } else {
      monthly[pk.ym].tw += v.w; monthly[pk.ym].toe += oe; tobiWork += v.w; tobiOtEq += oe
    }
  }

  // 外注
  for (const [k, v] of Object.entries(attSD)) {
    if (!v) continue
    const pk = parseDKey(k)
    if (!ymSet.has(pk.ym)) continue
    if (siteId && pk.sid !== siteId) continue
    const sc = main.subcons.find(x => x.id === pk.wid)
    if (!sc) continue
    const soe = v.on / 8 // 外注は8h換算
    if (!monthly[pk.ym]) monthly[pk.ym] = { tw: 0, dw: 0, toe: 0, doe: 0 }
    if (sc.type === '土工業者') {
      monthly[pk.ym].dw += v.n; monthly[pk.ym].doe += soe; dokoWork += v.n; dokoOtEq += soe
    } else {
      monthly[pk.ym].tw += v.n; monthly[pk.ym].toe += soe; tobiWork += v.n; tobiOtEq += soe
    }
  }

  // 月ごとにdokoRatioを取得して換算人工を合算
  let equiv = 0
  for (const [ym, md] of Object.entries(monthly)) {
    const rates = siteId ? getSiteRates(main, siteId, ym) : getSiteRates(main)
    equiv += (md.tw + md.toe) + (md.dw + md.doe) * rates.dokoRatio
  }

  // tobiBaseは最新レートから取得（KPI基準線用）
  const latestRates = siteId ? getSiteRates(main, siteId) : getSiteRates(main)
  const tobiBase = latestRates.tobiBase

  return { tobiWork, dokoWork, tobiOtEq, dokoOtEq, equiv, tobiBase }
}

// ────────────────────────────────────────
//  メイン集計エンジン（旧アプリのcompute()と同等）
//  ★ ダッシュボード・原価・月次集計の全ページで共用
// ────────────────────────────────────────

export interface ComputeResult {
  sites: Record<string, { work: number; ot: number; otEq: number; cost: number; subWork: number; subOT: number; subOtEq: number; subCost: number }>
  daily: Record<string, number>  // key: ym_day
  dailySite: Record<string, number>  // key: ym_day_siteId
  monthly: Record<string, number>  // key: ym
  workers: Record<number, { work: number; ot: number; cost: number; plUsed: number; compDays: number; sites: string[] }>
  subcons: Record<string, { work: number; ot: number; cost: number; sites: string[] }>
  siteWorkers: Record<string, { work: number; ot: number; cost: number; plUsed: number }>
  siteSubcons: Record<string, { work: number; ot: number; cost: number }>
  totalWork: number
  totalOT: number
  totalOtEq: number
  totalCost: number
  totalSubWork: number
  totalSubOT: number
  totalSubOtEq: number
  totalSubCost: number
}

export function compute(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ymList?: { y: number; m: number }[],
): ComputeResult {
  const ymSet = ymList ? new Set(ymList.map(x => ymKey(x.y, x.m))) : null
  const result: ComputeResult = {
    sites: {},
    daily: {}, dailySite: {}, monthly: {},
    workers: {}, subcons: {}, siteWorkers: {}, siteSubcons: {},
    totalWork: 0, totalOT: 0, totalOtEq: 0, totalCost: 0,
    totalSubWork: 0, totalSubOT: 0, totalSubOtEq: 0, totalSubCost: 0,
  }

  // サイトの初期化
  main.sites.forEach(s => {
    result.sites[s.id] = { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0 }
  })

  // ─── 個人の出面データ処理 ───
  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    const sid = pk.sid
    const wid = parseInt(pk.wid)
    const entryYm = pk.ym
    const dayS = pk.day

    if (ymSet && !ymSet.has(entryYm)) continue
    const w = main.workers.find(x => x.id === wid)
    if (!w) continue

    const swk = `${sid}_${w.id}`

    // 有給: 人工としてはカウントしないがworker集計に有給日数を記録
    if (v.p) {
      if (!result.workers[w.id]) {
        result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [] }
      }
      result.workers[w.id].plUsed = (result.workers[w.id].plUsed || 0) + 1
      if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
      if (!result.siteWorkers[swk]) result.siteWorkers[swk] = { work: 0, ot: 0, cost: 0, plUsed: 0 }
      result.siteWorkers[swk].plUsed = (result.siteWorkers[swk].plUsed || 0) + 1
      continue  // ★ 有給は人工にカウントしない → 即continue
    }

    if (!v.w) continue

    // 休業補償(0.6): 外国人の会社都合休業 → 原価のみ計上、人工数には含めない
    const isComp = (v.w === 0.6 && w.visa !== 'none')
    const otDivisor = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    const otCost = (v.o || 0) * (w.rate / otDivisor) * w.otMul
    const cost = v.w * w.rate + otCost
    const workCount = isComp ? 0 : v.w  // 休業補償は人工0
    const stdH = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h（変形労働時間制）
    const oe = isComp ? 0 : (v.o || 0) / stdH  // 残業→人工換算

    result.totalWork += workCount
    result.totalOT += (isComp ? 0 : (v.o || 0))
    result.totalOtEq += oe
    result.totalCost += cost

    if (result.sites[sid]) {
      result.sites[sid].work += workCount
      result.sites[sid].ot += (isComp ? 0 : (v.o || 0))
      result.sites[sid].otEq += oe
      result.sites[sid].cost += cost
    }

    const day = parseInt(dayS)
    const dailyKey = `${entryYm}_${day}`
    result.daily[dailyKey] = (result.daily[dailyKey] || 0) + workCount
    const dsKey = `${dailyKey}_${sid}`
    result.dailySite[dsKey] = (result.dailySite[dsKey] || 0) + workCount
    result.monthly[entryYm] = (result.monthly[entryYm] || 0) + workCount

    if (!result.workers[w.id]) {
      result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [] }
    }
    result.workers[w.id].work += workCount
    result.workers[w.id].ot += (isComp ? 0 : (v.o || 0))
    result.workers[w.id].cost += cost
    if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
    if (isComp) result.workers[w.id].compDays = (result.workers[w.id].compDays || 0) + 1

    // 現場×個人
    if (!result.siteWorkers[swk]) result.siteWorkers[swk] = { work: 0, ot: 0, cost: 0, plUsed: 0 }
    result.siteWorkers[swk].work += workCount
    result.siteWorkers[swk].ot += (isComp ? 0 : (v.o || 0))
    result.siteWorkers[swk].cost += cost
  }

  // ─── 外注の出面データ処理 ───
  for (const [k, v] of Object.entries(attSD)) {
    if (!v) continue
    const pk = parseDKey(k)
    const sid = pk.sid
    const scid = pk.wid
    const entryYm = pk.ym
    const dayS = pk.day

    if (ymSet && !ymSet.has(entryYm)) continue
    const sc = main.subcons.find(x => x.id === scid)
    if (!sc) continue

    // ★ 現場別単価を使用（旧アプリのgetSubconRateと同等）
    const scR = getSubconRate(main, scid, sid)
    const cost = v.n * scR.rate + v.on * scR.otRate
    const soe = v.on / 8  // 外注は8h換算

    result.totalSubWork += v.n
    result.totalSubOT += v.on
    result.totalSubOtEq += soe
    result.totalSubCost += cost

    if (result.sites[sid]) {
      result.sites[sid].subWork += v.n
      result.sites[sid].subOT += v.on
      result.sites[sid].subOtEq += soe
      result.sites[sid].subCost += cost
    }

    const day = parseInt(dayS)
    const dailyKey = `${entryYm}_${day}`
    result.daily[dailyKey] = (result.daily[dailyKey] || 0) + v.n
    const dsKey = `${dailyKey}_${sid}`
    result.dailySite[dsKey] = (result.dailySite[dsKey] || 0) + v.n
    result.monthly[entryYm] = (result.monthly[entryYm] || 0) + v.n

    if (!result.subcons[scid]) result.subcons[scid] = { work: 0, ot: 0, cost: 0, sites: [] }
    result.subcons[scid].work += v.n
    result.subcons[scid].ot += v.on
    result.subcons[scid].cost += cost
    if (!result.subcons[scid].sites.includes(sid)) result.subcons[scid].sites.push(sid)

    // 現場×外注
    const ssk = `${sid}_${scid}`
    if (!result.siteSubcons[ssk]) result.siteSubcons[ssk] = { work: 0, ot: 0, cost: 0 }
    result.siteSubcons[ssk].work += v.n
    result.siteSubcons[ssk].ot += v.on
    result.siteSubcons[ssk].cost += cost
  }

  return result
}

// ────────────────────────────────────────
//  請求額合計取得
// ────────────────────────────────────────
export function getBillTotal(main: MainData, siteId: string, ym: string): number {
  const arr = main.billing[`${siteId}_${ym}`]
  return arr ? arr.reduce((s, v) => s + (v || 0), 0) : 0
}

// ────────────────────────────────────────
//  出面概算：過去N月の確定請求から1鳶換算人工あたり売上平均を算出
//  （旧アプリのgetAvgRevenuePerEquivと同等）
// ────────────────────────────────────────
export function getAvgRevenuePerEquiv(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  baseYM: string,
  siteId?: string,
  months: number = 3,
): number | null {
  let sumBilling = 0
  let sumEquiv = 0
  let hasData = false

  let y = parseInt(baseYM.slice(0, 4))
  let m = parseInt(baseYM.slice(4, 6))

  for (let i = 0; i < months; i++) {
    m--
    if (m < 1) { m = 12; y-- }
    const mStr = ymKey(y, m)

    // Check billing for this month
    let mBill = 0
    if (siteId) {
      mBill = getBillTotal(main, siteId, mStr)
    } else {
      for (const site of main.sites) {
        mBill += getBillTotal(main, site.id, mStr)
      }
    }
    if (mBill <= 0) continue

    // Calculate tobiEquiv for this month
    const mTobiEq = calcTobiEquiv(main, attD, attSD, [{ y, m }], siteId)
    if (mTobiEq.equiv <= 0) continue

    sumBilling += mBill
    sumEquiv += mTobiEq.equiv
    hasData = true
  }

  if (!hasData || sumEquiv <= 0) return null
  return sumBilling / sumEquiv
}

// ────────────────────────────────────────
//  期間管理（旧アプリのbuildYMList/stepPeriod/buildPeriodLabelと同等）
// ────────────────────────────────────────

export function getFiscalYear(y: number, m: number): number {
  return m >= 10 ? y : y - 1
}

export function buildYMList(mode: string, y: number, m: number): { y: number; m: number }[] {
  const list: { y: number; m: number }[] = []
  if (mode === 'month') {
    list.push({ y, m })
  } else if (mode === 'fy') {
    const fy = getFiscalYear(y, m)
    const now = new Date()
    const nowYM = ymKey(now.getFullYear(), now.getMonth() + 1)
    for (let i = 0; i < 12; i++) {
      const mm = ((10 - 1 + i) % 12) + 1
      const yy = mm >= 10 ? fy : fy + 1
      list.push({ y: yy, m: mm })
      if (ymKey(yy, mm) > nowYM) break
    }
  } else {
    const n = mode === '3m' ? 3 : mode === '6m' ? 6 : 12
    let ty = y, tm = m
    for (let i = 0; i < n; i++) {
      list.unshift({ y: ty, m: tm })
      tm--
      if (tm < 1) { tm = 12; ty-- }
    }
  }
  return list
}

export function buildPeriodLabel(mode: string, y: number, m: number): string {
  const list = buildYMList(mode, y, m)
  if (list.length === 1) return `${list[0].y}年${list[0].m}月`
  if (mode === 'fy') {
    const fy = getFiscalYear(y, m)
    const f = list[0], l = list[list.length - 1]
    return `第${fy}期（${f.m}月〜${l.m}月）${list.length < 12 ? '進行中' : ''}`
  }
  const f = list[0], l = list[list.length - 1]
  return `${f.y}年${f.m}月 〜 ${l.y}年${l.m}月`
}

export function stepPeriod(mode: string, y: number, m: number, dir: number): { y: number; m: number } {
  if (mode === 'month') {
    m += dir
    if (m > 12) { m = 1; y++ }
    if (m < 1) { m = 12; y-- }
  } else if (mode === 'fy') {
    y += dir
  } else {
    const n = mode === '3m' ? 3 : mode === '6m' ? 6 : 12
    for (let i = 0; i < n; i++) {
      m += dir
      if (m > 12) { m = 1; y++ }
      if (m < 1) { m = 12; y-- }
    }
  }
  return { y, m }
}

// ────────────────────────────────────────
//  月次集計（computeMonthly）— 月次集計ページ用
//  compute()の結果を使いつつ、ワーカー別の詳細表示に整形
// ────────────────────────────────────────

export interface WorkerMonthly {
  id: number
  name: string
  org: string
  visa: string
  job: string
  rate: number
  hourlyRate?: number
  otMul: number
  salary?: number
  sites: string[]
  workDays: number
  actualWorkDays: number
  compDays: number
  workAll: number
  halfDays?: number
  otHours: number
  plDays: number
  plUsed: number
  restDays: number
  siteOffDays: number
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  // Salary calc fields (variable working hours system)
  prescribedHours?: number
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
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
  archived: boolean
  workDays: number
  subWorkDays: number
  otHours: number
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
  prescribedDays: number = 0,
  siteWorkDaysMap?: Record<string, number>,  // siteId -> workDays (from calendar)
): {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  sites: SiteSummary[]
  totals: { workDays: number; subWorkDays: number; cost: number; subCost: number; billing: number; profit: number; otHours: number }
} {
  // Worker monthly map
  const workerMap = new Map<number, WorkerMonthly>()
  for (const w of main.workers) {
    if (w.retired) continue
    workerMap.set(w.id, {
      id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      rate: w.rate, hourlyRate: w.hourlyRate, otMul: w.otMul, salary: w.salary, sites: [],
      workDays: 0, actualWorkDays: 0, compDays: 0, workAll: 0, otHours: 0,
      plDays: 0, plUsed: 0, restDays: 0, siteOffDays: 0,
      cost: 0, otCost: 0, totalCost: 0,
      absence: 0, absentCost: 0, netPay: 0,
    })
  }

  // Subcon monthly map
  const subconMap = new Map<string, SubconMonthly>()
  for (const sc of main.subcons) {
    subconMap.set(sc.id, {
      id: sc.id, name: sc.name, type: sc.type, rate: sc.rate, otRate: sc.otRate,
      sites: [], workDays: 0, otCount: 0, cost: 0,
    })
  }

  // Site summary map
  const siteMap = new Map<string, SiteSummary>()
  for (const s of main.sites) {
    siteMap.set(s.id, {
      id: s.id, name: s.name, archived: s.archived,
      workDays: 0, subWorkDays: 0, otHours: 0, cost: 0, subCost: 0,
      billing: 0, profit: 0, profitRate: 0,
    })
  }

  // Process attendance data
  for (const [key, entry] of Object.entries(attD)) {
    if (!entry) continue
    const pk = parseDKey(key)
    const siteId = pk.sid
    const wid = parseInt(pk.wid)
    if (pk.ym !== ym) continue

    const wm = workerMap.get(wid)
    if (!wm) continue

    // ★ 有給は人工にカウントしない → 即continue
    if (entry.p) {
      wm.plDays += 1
      wm.plUsed += 1
      if (!wm.sites.includes(siteId)) wm.sites.push(siteId)
      continue
    }
    if (entry.r) { wm.restDays += 1; continue }
    if (entry.h) { wm.siteOffDays += 1; continue }
    if (!entry.w) continue

    // ★ 休業補償(0.6)のロジック
    const isComp = (entry.w === 0.6 && wm.visa !== 'none')
    const workCount = isComp ? 0 : entry.w  // 補償は人工0

    wm.workDays += workCount
    wm.actualWorkDays += 1
    if (isComp) wm.compDays += 1
    if (entry.o && entry.o > 0 && !isComp) wm.otHours += entry.o
    if (!wm.sites.includes(siteId)) wm.sites.push(siteId)

    // ★ サイト別コストは直接エントリごとに加算
    const otDiv = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    const otCost = (isComp ? 0 : (entry.o || 0)) * (wm.rate / otDiv) * wm.otMul
    const entryCost = entry.w * wm.rate + otCost
    const site = siteMap.get(siteId)
    if (site) {
      site.workDays += workCount
      site.otHours += (isComp ? 0 : (entry.o || 0))
      site.cost += entryCost
    }
  }

  // Process subcon data
  for (const [key, entry] of Object.entries(attSD)) {
    if (!entry) continue
    const pk = parseDKey(key)
    const siteId = pk.sid
    const scid = pk.wid
    if (pk.ym !== ym) continue

    const sc = subconMap.get(scid)
    if (!sc) continue

    if (entry.n > 0) {
      sc.workDays += entry.n
      sc.otCount += entry.on || 0
      if (!sc.sites.includes(siteId)) sc.sites.push(siteId)

      // ★ 現場別単価を使用
      const scR = getSubconRate(main, scid, siteId)
      const scCost = entry.n * scR.rate + (entry.on || 0) * scR.otRate
      const site = siteMap.get(siteId)
      if (site) {
        site.subWorkDays += entry.n
        site.subCost += scCost
      }
    }
  }

  // Calculate worker costs
  for (const wm of workerMap.values()) {
    wm.workAll = wm.workDays + wm.compDays * 0.6  // 出勤日数（0.6含む）
    wm.cost = wm.workDays * wm.rate + (wm.compDays * 0.6 * wm.rate)  // 補償分も原価に含む
    const otDiv2 = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    wm.otCost = wm.otHours * (wm.rate / otDiv2) * wm.otMul
    wm.totalCost = wm.cost + wm.otCost

    // スタッフごとの所定日数: カレンダー(siteWorkDaysMap)があればそちらを優先
    let workerPrescribedDays = prescribedDays
    if (siteWorkDaysMap && wm.sites.length > 0) {
      // スタッフが配置されている現場の所定日数の最大値を採用
      const siteDays = wm.sites.map(sid => siteWorkDaysMap[sid] || 0).filter(d => d > 0)
      if (siteDays.length > 0) {
        workerPrescribedDays = Math.max(...siteDays)
      }
    }

    if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0 && workerPrescribedDays > 0) {
      // 月給制の外国人（時給ベース）: variable working hours system
      const prescribedH = workerPrescribedDays * 7
      const actualWorkH = wm.actualWorkDays * 7 + wm.otHours
      const legalOt = Math.max(0, actualWorkH - prescribedH)
      const basePay = Math.round(wm.hourlyRate * prescribedH)
      const otAllowance = Math.round(wm.hourlyRate * 1.25 * legalOt)
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed)
      const absentDeduction = Math.round(wm.hourlyRate * 7 * absentDays)
      const salaryNet = basePay - absentDeduction + otAllowance

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(legalOt * 10) / 10
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.salaryNetPay = salaryNet

      // Also set legacy absence fields
      wm.absence = absentDays
      wm.absentCost = absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa !== 'none' && wm.salary && wm.salary > 0 && workerPrescribedDays > 0) {
      // 月給制の外国人（旧salary方式、hourlyRate未設定）: salary-based calculation
      const prescribedH = workerPrescribedDays * 7
      const actualWorkH = wm.actualWorkDays * 7 + wm.otHours
      const legalOt = Math.max(0, actualWorkH - prescribedH)
      const hourlyRate = wm.salary / prescribedH
      const basePay = wm.salary
      const otAllowance = Math.round(hourlyRate * 1.25 * legalOt)
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed)
      const absentDeduction = Math.round(wm.salary / workerPrescribedDays * absentDays)
      const salaryNet = basePay - absentDeduction + otAllowance

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(legalOt * 10) / 10
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.salaryNetPay = salaryNet

      // Also set legacy absence fields
      wm.absence = absentDays
      wm.absentCost = absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa === 'none') {
      // 日給月給制の日本人: daily-rate based
      // 基本給 = 日額(rate) × 実出勤日数
      // 残業手当 = (日額 ÷ 8h) × otMul × 残業時間
      // 支給額 = 基本給 + 残業手当
      const basePay = Math.round(wm.workDays * wm.rate + (wm.compDays * 0.6 * wm.rate))
      const otPay = Math.round(wm.otHours * (wm.rate / 8) * wm.otMul)
      wm.basePay = basePay
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.otAllowance = otPay
      wm.salaryNetPay = basePay + otPay
      wm.netPay = wm.totalCost
    } else if (workerPrescribedDays > 0) {
      wm.absence = Math.max(0, workerPrescribedDays - wm.workDays - wm.compDays - wm.plUsed)  // 0.6は1日出勤扱い
      wm.absentCost = Math.round(wm.absence * wm.rate)
      wm.netPay = wm.totalCost - wm.absentCost
    } else {
      wm.netPay = wm.totalCost
    }
  }

  // Calculate subcon costs
  for (const sc of subconMap.values()) {
    sc.cost = sc.workDays * sc.rate + sc.otCount * sc.otRate
  }

  // Billing & profit
  for (const site of siteMap.values()) {
    const billingKey = `${site.id}_${ym}`
    const billings = main.billing[billingKey] || []
    site.billing = billings.reduce((sum, v) => sum + (v || 0), 0)
    site.profit = site.billing - site.cost - site.subCost
    site.profitRate = site.billing > 0 ? (site.profit / site.billing) * 100 : 0
  }

  // Round
  const r1 = (v: number) => Math.round(v * 10) / 10
  const r0 = (v: number) => Math.round(v)

  const workers = Array.from(workerMap.values()).filter(w => w.workDays > 0 || w.plDays > 0 || w.compDays > 0)
  workers.forEach(w => {
    w.workDays = r1(w.workDays); w.workAll = r1(w.workAll); w.otHours = r1(w.otHours)
    w.cost = r0(w.cost); w.otCost = r0(w.otCost); w.totalCost = r0(w.totalCost)
    w.absentCost = r0(w.absentCost); w.netPay = r0(w.netPay)
  })

  const subcons = Array.from(subconMap.values()).filter(sc => sc.workDays > 0)
  subcons.forEach(sc => { sc.workDays = r1(sc.workDays); sc.cost = r0(sc.cost) })

  const sites = Array.from(siteMap.values())
  sites.forEach(s => {
    s.workDays = r1(s.workDays); s.subWorkDays = r1(s.subWorkDays); s.otHours = r1(s.otHours)
    s.cost = r0(s.cost); s.subCost = r0(s.subCost); s.profit = r0(s.profit); s.profitRate = r1(s.profitRate)
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
