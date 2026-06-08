import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { AttendanceEntry, calcActualHours } from '@/types'
import { ymKey, isWorkingDay } from './attendance'
import { isStillActiveForMonth } from './workers'
import { isTobiGroup, isDokoGroup } from './jobs'

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
  // 2026-05-13: 旧 main.homeLeaves 配列は廃止（homeLongLeave コレクションに統合）
  //   フィールド自体は demmen/main 上に空配列として残るが、production 読み取りはしない。
}

export interface RawWorker {
  id: number; name: string; org: string; visa: string; job: string
  rate: number; hourlyRate?: number; otMul: number; hireDate: string; retired?: string; token: string
  salary?: number; memo?: string; grantMonth?: number
  visaExpiry?: string  // 在留期限 YYYY-MM-DD
  dispatchTo?: string  // 出向先名（空なら通常勤務）
  dispatchFrom?: string  // 出向開始月 YYYY-MM（空なら全期間出向扱い）
  useOldRules?: boolean  // 旧ルール（変形労働制以前）給与計算を継続するフラグ（個別対応）
}

export interface RawSite {
  id: string; name: string; start: string; end: string
  foreman: number; archived: boolean
  tobiRate?: number; dokoRate?: number
  rates?: { from: string; tobiRate: number; dokoRate: number }[]
  workSchedule?: {
    startTime?: string; endTime?: string
    morningBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
    lunchBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
    afternoonBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
  }
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

// 指定YM時点でワーカーが出向中かを判定
//   - dispatchTo が空 → 出向していない
//   - dispatchFrom が空 → 全期間出向扱い（後方互換）
//   - dispatchFrom が設定済み → ym >= dispatchFrom のときのみ出向扱い
// ym は YYYYMM 形式、dispatchFrom は YYYY-MM 形式
/**
 * スタッフ1人の日額換算単価を取得（2026-06-XX 新設・C1 修正）
 *
 * 旧バグ: 月給制日本人 (rate=0, salary>0) でサイト原価が w.rate=0 で
 *   ゼロ計上される問題（compute.ts:461 と 913）
 *
 * 統一ロジック:
 *   - 月給制日本人 (visa==='none' && salary>0): salary / 20 (月所定日数前提)
 *   - その他: w.rate（時給制ベトナム人もrateは時給×7で自動セット済）
 *
 * 注: ベース20日固定は概算用。中途入退社按分は computeMonthly() 側で対応済み。
 *     より精密な日割りが必要な場合は呼出側で workerPrescribedDays を考慮する。
 */
export function getWorkerDailyRate(w: { visa?: string; rate?: number; salary?: number }): number {
  if (w.visa === 'none' && w.salary && w.salary > 0) {
    return w.salary / 20
  }
  return w.rate || 0
}

export function isDispatchedAt(w: RawWorker | undefined, ym: string): boolean {
  if (!w?.dispatchTo) return false
  if (!w.dispatchFrom) return true
  const fromYm = w.dispatchFrom.replace(/-/g, '')  // YYYY-MM → YYYYMM
  return ym >= fromYm
}

// 出向判定: 指定社員が指定現場・指定YMで出向扱いかチェック
//   1) ワーカー自身の dispatchTo（開始月以降）→ 全現場で出向扱い
//   2) 現場ごとの dispatch 配列に含まれていれば出向扱い
export function isDispatched(main: MainData, workerId: number, siteId: string, ym: string): boolean {
  const w = main.workers.find(x => x.id === workerId)
  if (isDispatchedAt(w, ym)) return true
  const assign = getAssign(main, siteId, ym)
  return assign.dispatch.includes(workerId)
}

// ワーカーが指定YM時点で常時出向中かを判定
export function isWorkerDispatched(main: MainData, workerId: number, ym: string): boolean {
  const w = main.workers.find(x => x.id === workerId)
  return isDispatchedAt(w, ym)
}

// ────────────────────────────────────────
//  外注の現場別単価取得（旧アプリのgetSubconRateと同等）
// ────────────────────────────────────────
export function getSubconRate(
  main: MainData,
  scid: string,
  siteId?: string,
  ym?: string,
): { rate: number; otRate: number } {
  const sc = main.subcons.find(x => x.id === scid)
  const base = { rate: sc ? sc.rate : 0, otRate: sc ? sc.otRate : 0 }
  if (!siteId) return base
  // 2026-06-XX 修正 (I7): 月別 overrides (massign[siteId_ym].subconRates) を優先参照
  //   旧: main.assign[siteId].subconRates のみ参照 → 月別単価変更を反映できない
  //   新: massign を優先、なければ assign にフォールバック
  let ov: { rate?: number; otRate?: number } | undefined
  if (ym) {
    const massignKey = `${siteId}_${ym}`
    const mAssign = (main as { massign?: Record<string, { subconRates?: Record<string, { rate?: number; otRate?: number }> }> }).massign?.[massignKey]
    if (mAssign?.subconRates?.[scid]) ov = mAssign.subconRates[scid]
  }
  if (!ov) {
    const a = main.assign[siteId]
    if (a?.subconRates?.[scid]) ov = a.subconRates[scid]
  }
  if (!ov) return base
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
    // ⚠️ 2026-05-09: 残骸データ対策（休み/現場休/帰国中/試験 を鳶換算から除外）
    if ((v.r ?? 0) > 0 || (v.h ?? 0) > 0 || (v.hk ?? 0) > 0 || ((v as { exam?: number }).exam ?? 0) > 0) continue
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
    // 2026-06-XX 修正 (C6): 単一の真理ソース isTobiGroup/isDokoGroup を使用
    //   旧: doko 以外は全部鳶側 → 事務(jimu)等も鳶換算に混入
    //   新: isTobiGroup (tobi/tobi_apprentice/shokucho/yakuin) と isDokoGroup のみ集計
    //       その他 (jimu 等) は除外
    if (isDokoGroup(w.job)) {
      monthly[pk.ym].dw += v.w; monthly[pk.ym].doe += oe; dokoWork += v.w; dokoOtEq += oe
    } else if (isTobiGroup(w.job)) {
      monthly[pk.ym].tw += v.w; monthly[pk.ym].toe += oe; tobiWork += v.w; tobiOtEq += oe
    }
    // 上記以外 (jimu 等) は鳶換算対象外
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
  sites: Record<string, { work: number; ot: number; otEq: number; cost: number; subWork: number; subOT: number; subOtEq: number; subCost: number; dispatchDeduction: number }>
  daily: Record<string, number>  // key: ym_day
  dailySite: Record<string, number>  // key: ym_day_siteId
  monthly: Record<string, number>  // key: ym
  workers: Record<number, { work: number; ot: number; cost: number; plUsed: number; compDays: number; sites: string[]; isDispatched?: boolean; dispatchTo?: string; dispatchDeduction?: number }>
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
  totalDispatchDeduction: number
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
    totalDispatchDeduction: 0,
  }

  // サイトの初期化
  main.sites.forEach(s => {
    result.sites[s.id] = { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0, dispatchDeduction: 0 }
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
    // 2026-06-XX 修正 (C2): 退職済みワーカーは原価集計から除外
    //   旧: 退職済みでも出面残骸が残っていれば原価計上 → 過去月の数字が変動
    //   新: computeMonthly() と同じく isStillActiveForMonth でガード
    if (!isStillActiveForMonth(w.retired, entryYm)) continue

    const swk = `${sid}_${w.id}`

    // この社員がこの月時点で出向中か（dispatchFrom 以降のみ true）
    const dispatchedThisYm = isDispatchedAt(w, entryYm)

    // 有給: 人工としてはカウントしないがworker集計に有給日数を記録
    if (v.p) {
      if (!result.workers[w.id]) {
        result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [], isDispatched: dispatchedThisYm, dispatchTo: w.dispatchTo || '', dispatchDeduction: 0 }
      } else if (dispatchedThisYm && !result.workers[w.id].isDispatched) {
        result.workers[w.id].isDispatched = true
      }
      result.workers[w.id].plUsed = (result.workers[w.id].plUsed || 0) + 1
      if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
      if (!result.siteWorkers[swk]) result.siteWorkers[swk] = { work: 0, ot: 0, cost: 0, plUsed: 0 }
      result.siteWorkers[swk].plUsed = (result.siteWorkers[swk].plUsed || 0) + 1
      continue  // ★ 有給は人工にカウントしない → 即continue
    }

    // 試験: 人工にも原価にもカウントしない（compute() レベルでは無視）。
    //   給与計算上の扱い (欠勤控除から除外) は computeMonthly() の examDays で別途処理
    if (v.exam) continue

    // ⚠️ 2026-05-09: 残骸データ対策
    //   {w:1, r:1, o:5} のような残骸（出勤入力後に「休み」へ変更したが o/w が残っている）
    //   を「出勤」としてカウントしないよう、r/h/hk フラグを早期除外する。
    //   p/exam は上で個別処理済み。w==0 も下の `if (!v.w)` で除外される。
    if ((v.r ?? 0) > 0 || (v.h ?? 0) > 0 || (v.hk ?? 0) > 0) continue

    if (!v.w) continue

    // 休業補償(0.6): 外国人の会社都合休業 → 原価のみ計上、人工数には含めない
    const isComp = (v.w === 0.6 && w.visa !== 'none')
    const otDivisor = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    // 2026-06-XX 修正 (C1): 月給制日本人 (rate=0, salary>0) のサイト原価ゼロ問題
    //   旧: w.rate を直接使用 → rate=0 だとサイト原価=0 で過小計上
    //   新: getWorkerDailyRate() で月給制も日額換算（salary/20）
    const dailyRate = getWorkerDailyRate(w)
    const otCost = (v.o || 0) * (dailyRate / otDivisor) * w.otMul
    const cost = v.w * dailyRate + otCost
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
      result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [], isDispatched: dispatchedThisYm, dispatchTo: w.dispatchTo || '', dispatchDeduction: 0 }
    } else if (dispatchedThisYm && !result.workers[w.id].isDispatched) {
      result.workers[w.id].isDispatched = true
    }
    result.workers[w.id].work += workCount
    result.workers[w.id].ot += (isComp ? 0 : (v.o || 0))
    result.workers[w.id].cost += cost
    if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
    if (isComp) result.workers[w.id].compDays = (result.workers[w.id].compDays || 0) + 1

    // 出向者: 控除額をワーカー・サイト・全体で集計（dispatchFrom 以降のみ）
    if (dispatchedThisYm) {
      result.workers[w.id].dispatchDeduction = (result.workers[w.id].dispatchDeduction || 0) + cost
      if (result.sites[sid]) result.sites[sid].dispatchDeduction += cost
      result.totalDispatchDeduction += cost
    }

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
    // 2026-06-XX 修正 (I7): 月別単価 (massign) を優先するため entryYm を渡す
    const scR = getSubconRate(main, scid, sid, entryYm)
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
  // 2026-06-XX 追加: 旧ルール継続フラグ（人員マスタの個別設定）
  //   下流（PayrollAuditModal / Excel出力）で表示分岐するために必要
  useOldRules?: boolean
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
  examDays: number     // 試験日数（給与計算では欠勤控除対象から除外、原価には計上しない）
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  // 2026-06-XX 追加 (C8): 同一日複数現場の actualWorkDays 重複排除用
  //   内部利用のみ。集計後の表示には使わない（リファクタ時に削除可）
  _actualDaySeen?: Set<string>
  // 出向情報
  isDispatched?: boolean         // 常時出向中（Worker.dispatchTo が設定済み）
  dispatchTo?: string            // 出向先名
  dispatchDeduction?: number     // 出向控除額（実出勤×日額＋残業 = totalCost と同等）
  // Salary calc fields (variable working hours system)
  prescribedHours?: number
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
  // 3層構造 fields (A+X案: 2026年5月〜)
  fixedBasePay?: number        // 基本給（固定）= 時給 × ベース日数 × 7h
  additionalAllowance?: number // 追加所定手当 = 時給 × MAX(0, 実出勤日数 − ベース日数) × 7h
  legalLimit?: number          // 法定上限時間 = 暦日数 × 40 ÷ 7
  // ── 法令準拠の詳細支給項目 (2026-05-13 追加、新ルール=変形労働時間制) ──
  legalHolidayHours?: number      // 法定休日(日曜)の実労働時間
  legalHolidayDays?: number       // 法定休日(日曜)に実労働があった日数
  legalHolidayAllowance?: number  // 法定休日手当 = 時間 × 時給 × 1.35
  nightHours?: number             // 深夜(22:00-5:00)の実労働時間
  nightAllowance?: number         // 深夜手当 = 時間 × 時給 × 0.25
  compAllowance?: number          // 休業手当 = 補償日数 × 時給 × 7h × 0.6
  regularWorkDays?: number        // 通常出勤日数（日曜出勤を除く、追加所定の対象）
  // 2026-06-XX 追加: スタッフ固有の所定日数（配置現場の calendar から算出）
  //   新ルール: MAX(配置現場の siteWorkDays) — 笹塚なら 23 など
  //   旧ルール: 全社所定 (main.workDays[ym]) — 23 など
  //   基本給ベース日数 (baseDays=20) とは別概念。UI 表示で混同しないため明示保持。
  workerPrescribedDays?: number
  dailyStatutoryOT?: number       // 日単位の法定外残業（1日8h超）
  weeklyStatutoryOT?: number      // 週単位の法定外残業（週40h超、日単位分除く）
  monthlyStatutoryOT?: number     // 月単位の法定外残業（法定上限超、日/週分除く）
  // ── 2026-06-XX 追加: 所定外労働手当（法定内・割増なし） ──
  // 残業欄入力時間のうち、3層判定で法定外残業に該当しなかった分を
  // 通常賃金で支払う必要がある（労基法24条 賃金全額払い）。
  // 例: 出勤18日+有給2日+残業18.5h、statutoryOT=1.0h
  //     → nonStatutoryOTHours = 17.5h、手当 = 時給×17.5h
  nonStatutoryOTHours?: number    // 所定外労働時間（法定内・割増なし）
  nonStatutoryOTAllowance?: number // 所定外労働手当 = 時給 × nonStatutoryOTHours
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
  dispatchDeduction?: number  // 出向控除額（人件費から差引、売上は既に控除済みの値が入力されている）
}

export function computeMonthly(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  prescribedDays: number = 0,
  siteWorkDaysMap?: Record<string, number>,  // siteId -> workDays (from calendar)
  baseDays: number = 20,  // 3層構造の基本給ベース日数（管理者設定）
): {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  sites: SiteSummary[]
  totals: { workDays: number; subWorkDays: number; cost: number; subCost: number; billing: number; profit: number; otHours: number }
} {
  // Worker monthly map
  // ★ この月時点で出向中かどうかを ym で判定（dispatchFrom 以降のみ true）
  const workerMap = new Map<number, WorkerMonthly>()
  // 現場ごとの workSchedule マップを構築（時間ベース入力での実労働時間計算に使用）
  // ※ RawSite では一部フィールドが optional のため、SiteWorkSchedule への代入時に補完が必要
  const siteScheduleMap = new Map<string, RawSite['workSchedule']>()
  for (const s of main.sites) {
    siteScheduleMap.set(s.id, s.workSchedule)
  }

  // 月の実労働時間累積（時間ベース入力対応）。新ルールの法定上限判定に使用。
  const actualWorkHoursAccumByWid = new Map<number, number>()

  // 完全月給者（日本人 salary>0 = 政仁・濱上等）の現場別出勤日数。
  //   原価は「固定給」を出勤実績で各現場へ配賦するため、エントリ単位の概算(salary/20)は
  //   site.cost に積まず、ここに日数を貯めて後段で固定給を比例配賦する。
  const fullMonthlySiteDays = new Map<number, Map<string, number>>()

  for (const w of main.workers) {
    // 2026-06-XX: 退職月のスタッフ（例: 6/30 退職予定）も当月は集計対象に含める
    // （旧: `if (w.retired) continue` は退職日が入った瞬間に当月も除外する事故）
    // 該当月の月初以降に退職する場合は在籍中とみなす
    if (!isStillActiveForMonth(w.retired, ym)) continue
    const dispatchedThisMonth = isDispatchedAt(w, ym)
    workerMap.set(w.id, {
      id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      rate: w.rate, hourlyRate: w.hourlyRate, otMul: w.otMul, salary: w.salary,
      // 2026-06-XX 追加: 下流の表示層が「フン等の個別旧ルール継続者」を判別できるようにする
      useOldRules: w.useOldRules,
      sites: [],
      workDays: 0, actualWorkDays: 0, compDays: 0, workAll: 0, otHours: 0,
      plDays: 0, plUsed: 0, restDays: 0, siteOffDays: 0, examDays: 0,
      cost: 0, otCost: 0, totalCost: 0,
      absence: 0, absentCost: 0, netPay: 0,
      isDispatched: dispatchedThisMonth,
      dispatchTo: dispatchedThisMonth ? (w.dispatchTo || '') : '',
      dispatchDeduction: 0,
    })
    actualWorkHoursAccumByWid.set(w.id, 0)
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
    // ★ 試験は人工にカウントしないが、給与計算では出勤と同等扱い (examDays として集計)
    if (entry.exam) {
      wm.examDays += 1
      if (!wm.sites.includes(siteId)) wm.sites.push(siteId)
      continue
    }
    // ★ 帰国中は実出勤にも欠勤にもカウントしない
    if (entry.hk) continue
    if (entry.r) { wm.restDays += 1; continue }
    if (entry.h) { wm.siteOffDays += 1; continue }
    if (!entry.w) continue

    // ★ 休業補償(0.6)のロジック
    const isComp = (entry.w === 0.6 && wm.visa !== 'none')
    const workCount = isComp ? 0 : entry.w  // 補償は人工0

    wm.workDays += workCount
    // 2026-06-XX 修正 (C8): 同一日複数現場の actualWorkDays 二重カウント解消
    //   旧: エントリ単位で += 1 → 1日に2現場勤務(各 w=0.5)で actualWorkDays += 2 となり
    //       「1日なのに2日出勤」扱い、欠勤判定が過少に
    //   新: ワーカーごとに日単位でユニーク化（Set<ym_day>）
    if (!isComp) {
      const dayKey = `${pk.ym}_${pk.day}`
      if (!wm._actualDaySeen) wm._actualDaySeen = new Set<string>()
      if (!wm._actualDaySeen.has(dayKey)) {
        wm._actualDaySeen.add(dayKey)
        wm.actualWorkDays += 1
      }
    }
    if (isComp) wm.compDays += 1
    if (entry.o && entry.o > 0 && !isComp) wm.otHours += entry.o
    if (!wm.sites.includes(siteId)) wm.sites.push(siteId)

    // ⏱️ 実労働時間を正確に集計（新ルール=5月以降の法定上限判定に使用）
    //   - 時間ベース入力（st/et あり）: calcActualHours で実時間（休憩控除済み・残業含む）を取得
    //   - レガシー（st/et なし）: w * 7h + entry.o（5月以降の例外的レガシー入力にも対応）
    //   - 補償日 (isComp) は実労働時間に含めない（新ルールの法定上限から除外）
    if (!isComp) {
      let dayHours = 0
      if (entry.st && entry.et) {
        // 時間ベース: 現場の workSchedule に従って実労働を計算
        // ※ RawSite の workSchedule は optional だが、calcActualHours は内部で `?.` でアクセスするので安全
        dayHours = calcActualHours(entry, siteScheduleMap.get(siteId) as Parameters<typeof calcActualHours>[1])
      } else {
        // レガシー: 1日所定（=7h）+ 残業
        dayHours = (entry.w || 0) * 7 + (entry.o || 0)
      }
      const accum = actualWorkHoursAccumByWid.get(wid) || 0
      actualWorkHoursAccumByWid.set(wid, accum + dayHours)
    }

    // ★ サイト別コストは直接エントリごとに加算
    // 2026-06-XX 修正 (C1): 月給制日本人 (rate=0) のサイト原価ゼロ問題
    //   getWorkerDailyRate で月給制も日額換算（salary/20）
    const otDiv = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    const entryDailyRate = getWorkerDailyRate({ visa: wm.visa, rate: wm.rate, salary: wm.salary })
    const otCost = (isComp ? 0 : (entry.o || 0)) * (entryDailyRate / otDiv) * wm.otMul
    const entryCost = entry.w * entryDailyRate + otCost
    // 完全月給者（日本人 salary>0）は原価=固定給。エントリ単位の概算は site.cost に積まず、
    // 出勤日数だけ記録して後段で固定給を比例配賦する（GAP2: 固定給を原価にする方針）。
    const isFullMonthly = wm.visa === 'none' && !!wm.salary && wm.salary > 0
    const site = siteMap.get(siteId)
    if (site) {
      site.workDays += workCount
      site.otHours += (isComp ? 0 : (entry.o || 0))
      if (isFullMonthly) {
        if (workCount > 0) {
          let m = fullMonthlySiteDays.get(wid)
          if (!m) { m = new Map<string, number>(); fullMonthlySiteDays.set(wid, m) }
          m.set(siteId, (m.get(siteId) || 0) + workCount)
        }
      } else {
        site.cost += entryCost
        // 出向者の人件費はサイトの出向控除額に積む（後段で売上・人件費から差引）
        if (wm.isDispatched) {
          site.dispatchDeduction = (site.dispatchDeduction || 0) + entryCost
        }
      }
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

      // ★ 現場別単価を使用（月別overrides も考慮）
      const scR = getSubconRate(main, scid, siteId, ym)
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
    // 月給制の日本人は rate が 0 でも salary から日額換算で原価計算（現場別配賦のため）
    // 月給/月所定日数（20日固定で簡便。実所定日数は後段で計算するが、原価配賦は概算で十分）
    const effectiveDailyRate = (wm.visa === 'none' && wm.salary && wm.salary > 0)
      ? wm.salary / 20
      : wm.rate
    wm.cost = wm.workDays * effectiveDailyRate + (wm.compDays * 0.6 * effectiveDailyRate)  // 補償分も原価に含む
    const otDiv2 = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    wm.otCost = wm.otHours * (effectiveDailyRate / otDiv2) * wm.otMul
    wm.totalCost = wm.cost + wm.otCost
    // 出向者: 控除額 = totalCost（人件費から差引）
    if (wm.isDispatched) {
      wm.dispatchDeduction = wm.totalCost
    }

    // スタッフごとの所定日数:
    //   - 新ルール（変形労働制 ym>=202605）: 現場の就業カレンダー(siteWorkDaysMap)を使用
    //     → 現場が土曜も休む等で月20日設定なら、その値で給与計算
    //   - 旧ルール (useOldRules=true や 4月以前): 全社所定 prescribedDays を使用
    //     → 「日曜のみ休み(+祝日) = 月23日」が原則。現場 calendar とは独立。
    //
    // 2026-06-XX 修正: 旧ルール継続者(フン 104 等)に対して誤って site calendar の値が
    //   採用されていたバグを修正。例: フンが IH 現場(土曜休み20日設定)のみ配置の場合、
    //   旧ルールでは 23日所定のはずが 20日扱いで欠勤控除が発生しない問題があった。
    const workerWmEarly = main.workers.find(x => x.id === wm.id)
    const isOldRulesWorker = ym < '202605' || workerWmEarly?.useOldRules === true
    let workerPrescribedDays = prescribedDays
    if (!isOldRulesWorker && siteWorkDaysMap && wm.sites.length > 0) {
      // 新ルールのみ: スタッフが配置されている現場の所定日数の最大値を採用
      const siteDays = wm.sites.map(sid => siteWorkDaysMap[sid] || 0).filter(d => d > 0)
      if (siteDays.length > 0) {
        workerPrescribedDays = Math.max(...siteDays)
      }
    }

    // 2026-06-XX 追加 (I-7): 中途入退社月の baseDays / 所定日数 を在籍期間で按分
    //   旧: baseDays/prescribedDays が常に20固定で、中途入退社月では実労働<20で
    //       過大な欠勤控除が発生していた
    //   新: 在籍日数の割合で baseDays/prescribedDays を縮小
    //       例: 6/15入社 → 在籍 16/30 = 53% → baseDays = round(20 × 0.53) = 11日
    const rawWorker = main.workers.find(x => x.id === wm.id)
    let proratedBaseDays = baseDays
    let proratedPrescribedDays = workerPrescribedDays
    if (rawWorker) {
      const ymY = parseInt(ym.slice(0, 4))
      const ymM = parseInt(ym.slice(4, 6))
      const monthStartIso = `${ymY}-${String(ymM).padStart(2, '0')}-01`
      const monthEndIso = `${ymY}-${String(ymM).padStart(2, '0')}-${String(new Date(ymY, ymM, 0).getDate()).padStart(2, '0')}`
      const totalDaysInMonth = new Date(ymY, ymM, 0).getDate()

      const hireDate = rawWorker.hireDate || ''
      const retiredDate = rawWorker.retired || ''

      // 在籍期間の開始日 = max(月初, 入社日)
      const startIso = hireDate && hireDate > monthStartIso ? hireDate : monthStartIso
      // 在籍期間の終了日 = min(月末, 退職日)
      const endIso = retiredDate && retiredDate < monthEndIso ? retiredDate : monthEndIso

      if (startIso <= endIso) {
        // 在籍日数を計算
        const startD = parseInt(startIso.slice(8, 10))
        const endD = parseInt(endIso.slice(8, 10))
        const activeDays = endD - startD + 1
        if (activeDays < totalDaysInMonth) {
          // 按分が必要なケース（中途入社 or 中途退職）
          const ratio = activeDays / totalDaysInMonth
          proratedBaseDays = Math.round(baseDays * ratio)
          proratedPrescribedDays = Math.round(workerPrescribedDays * ratio)
        }
      }
    }
    // 後段の計算で proratedBaseDays / proratedPrescribedDays を使う
    // 一旦 workerPrescribedDays を上書き
    workerPrescribedDays = proratedPrescribedDays

    // 2026-06-XX 追加: UI 表示用に workerPrescribedDays を保存
    //   PayrollAuditModal で「所定日数(配置現場)」として表示。
    //   baseDays (=20, 基本給ベース) と区別して見せるための情報。
    wm.workerPrescribedDays = workerPrescribedDays

    // ベトナム人スタッフの給与計算は2026年5月を境に旧ルール／新ルールが切り替わる
    // - 4月以前: 月の所定時間ベース（旧ロジック）
    //            基本給=時給×所定時間, 残業=実労働>所定時間, 欠勤=所定日数下回り分
    // - 5月以降: 3層構造 + 法定上限ベース（新ロジック）
    //            基本給固定=時給×20日×7h, 追加所定=20日超分, 残業=実労働>法定上限
    //
    // 2026-05-12 追加: ワーカー個別に useOldRules=true が立っている場合、5月以降も旧ルールを継続。
    //   本人が新ルール移行を拒否したケース（例: フン 104, 2027/01 退職予定）に対応。
    //   退職後は retired により自動的に給与計算対象外になる。
    const workerWm = main.workers.find(x => x.id === wm.id)
    const useNewRules = ym >= '202605' && !workerWm?.useOldRules

    if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0 && useNewRules) {
      // ── 5月以降: 法令準拠（変形労働時間制） ──
      // 計算内容（calculateVietnameseSalary が一括処理）:
      //   1. 基本給(固定)     = 時給 × baseDays × 7h
      //   2. 追加所定手当     = 時給 × (regularWorkDays − baseDays) × 7h  ※法定休日を除いた出勤日
      //   3. 法定外残業手当   = 3層判定(日/週/月) × 時給 × 1.25
      //   4. 法定休日手当     = 日曜の実労働 × 時給 × 1.35
      //   5. 深夜手当         = 22:00-5:00 の重なり × 時給 × 0.25
      //   6. 休業手当         = 補償日 × 時給 × 7h × 0.6
      //   7. 欠勤控除         = 欠勤日 × 時給 × 7h
      // 所定休日(土・カレンダーoff)労働は別枠1.25倍を支払わず、週40h超過分のみ
      // 法定外残業として1.25倍が自動適用される（法令最低・最適コスト）。
      // 2026-06-XX 修正 (I-7): 中途入退社時は proratedBaseDays を使用
      const v = calculateVietnameseSalary(
        wm.id, ym, wm.hourlyRate, proratedBaseDays, attD, main.sites,
        wm.plUsed, wm.compDays, wm.examDays,
      )

      wm.fixedBasePay = v.fixedBasePay
      wm.additionalAllowance = v.additionalAllowance
      wm.nonStatutoryOTHours = v.nonStatutoryOTHours
      wm.nonStatutoryOTAllowance = v.nonStatutoryOTAllowance
      wm.otAllowance = v.otAllowance
      wm.legalHolidayHours = v.legalHolidayHours
      wm.legalHolidayDays = v.legalHolidayDays
      wm.legalHolidayAllowance = v.legalHolidayAllowance
      wm.nightHours = v.nightHours
      wm.nightAllowance = v.nightAllowance
      wm.compAllowance = v.compAllowance
      wm.absentDeduction = v.absentDeduction
      wm.salaryNetPay = v.salaryNet
      wm.regularWorkDays = v.regularWorkDays
      wm.dailyStatutoryOT = v.dailyStatutoryOT
      wm.weeklyStatutoryOT = v.weeklyStatutoryOT
      wm.monthlyStatutoryOT = v.monthlyStatutoryOT
      wm.legalLimit = v.legalLimit
      wm.prescribedHours = baseDays * 7
      wm.actualWorkHours = v.actualWorkHours
      wm.legalOtHours = v.statutoryOT
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = v.fixedBasePay  // legacy: UI互換のため
      wm.absence = v.absentDays
      wm.absentCost = v.absentDeduction
      wm.netPay = v.salaryNet
      // 2026-06-XX 修正 (I-10): 出向控除を実支給額ベースに置換
      //   旧: totalCost (rate×days の粗い原価) → 実支給額と乖離 → 出向先請求と不整合
      if (wm.isDispatched) wm.dispatchDeduction = v.salaryNet
    } else if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0 && workerPrescribedDays > 0) {
      // ── 4月以前: 旧ルール（通常の労働時間制）── 時給ベース ──
      // 設計（2026-05-08 ユーザー確定）:
      //   1日所定 = 6時間40分（= 20/3h）。週6日×6h40m = 40h で法定上限内。
      //   基本給   = 時給 × 月の所定時間（=月所定日数 × 6h40min、固定）
      //   休業補償 = 補償日数 × 時給 × 6h40min × 0.6 （別項目で加算）
      //   残業手当 = 月の残業時間合計（= 各日の o の合計） × 時給 × 1.25
      //              ※ 旧ルールは1日単位での残業判定。月単位の所定超過判定はしない。
      //   欠勤控除 = 真の欠勤日数 × 時給 × 6h40min
      //              ※ 0.6補償・有給・試験は出勤扱いで欠勤に含めない。
      //   支給額  = 基本給 + 休業補償 + 残業手当 − 欠勤控除
      const dailyHoursOld = 20 / 3  // = 6.667h
      const prescribedH = workerPrescribedDays * dailyHoursOld

      // 基本給
      const basePay = Math.round(wm.hourlyRate * prescribedH)

      // 休業補償（補償日 = 0.6保証）
      const compAllowance = Math.round(wm.hourlyRate * dailyHoursOld * 0.6 * wm.compDays)

      // 残業手当（日単位の積み上げ）
      const otAllowance = Math.round(wm.hourlyRate * 1.25 * wm.otHours)

      // 真の欠勤日数（有給・試験は出勤扱い、補償日は欠勤扱いで60%休業手当のみ支給）
      // 2026-06-XX 修正: 補償日を欠勤に算入（労基法26条準拠で60%支給のみ）
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed - wm.examDays)
      const absentDeduction = Math.round(wm.hourlyRate * dailyHoursOld * absentDays)

      // 表示用: 実労働時間（補償も0.6相当でカウント）
      const actualWorkH = wm.actualWorkDays * dailyHoursOld + wm.compDays * 0.6 * dailyHoursOld + wm.otHours

      const salaryNet = basePay + compAllowance + otAllowance - absentDeduction

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(wm.otHours * 10) / 10  // 旧ルールは月の残業時間合計と同じ
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      // additionalAllowance を「休業補償」として流用（UI/Excel 側で旧ルール用ラベル "休業補償" に切替）
      wm.additionalAllowance = compAllowance
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.salaryNetPay = salaryNet

      wm.absence = absentDays
      wm.absentCost = absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa !== 'none' && wm.salary && wm.salary > 0 && useNewRules) {
      // ── 5月以降: 法令準拠（salary方式: 月給から時給を逆算） ──
      // hourlyRate版と同じ計算式を使用。基本給だけは月給固定値で上書き。
      // 2026-06-XX 修正 (I-7/I-9): 中途入退社時は基本給を proratedBaseDays で按分
      //   月給制でも在籍期間に応じて basePay を縮小（労基法の日割り原則）
      const proratedSalary = baseDays > 0 ? Math.round(wm.salary * (proratedBaseDays / baseDays)) : wm.salary
      const derivedHourlyRate = wm.salary / (baseDays * 7)  // 単価は固定（按分前の月給ベース）
      const v = calculateVietnameseSalary(
        wm.id, ym, derivedHourlyRate, proratedBaseDays, attD, main.sites,
        wm.plUsed, wm.compDays, wm.examDays,
      )
      // 基本給は月給値を採用（時給からの再計算による丸め誤差を避ける）
      // 2026-06-XX 修正 (I-7): 中途入退社時は按分した値を採用
      const fixedBase = proratedSalary
      // 2026-06-XX 修正: 所定外労働手当 (nonStatutoryOTAllowance) も加算
      const salaryNet = fixedBase + v.additionalAllowance + v.nonStatutoryOTAllowance + v.otAllowance
                      + v.legalHolidayAllowance + v.nightAllowance + v.compAllowance
                      - v.absentDeduction

      wm.fixedBasePay = fixedBase
      wm.additionalAllowance = v.additionalAllowance
      wm.nonStatutoryOTHours = v.nonStatutoryOTHours
      wm.nonStatutoryOTAllowance = v.nonStatutoryOTAllowance
      wm.otAllowance = v.otAllowance
      wm.legalHolidayHours = v.legalHolidayHours
      wm.legalHolidayDays = v.legalHolidayDays
      wm.legalHolidayAllowance = v.legalHolidayAllowance
      wm.nightHours = v.nightHours
      wm.nightAllowance = v.nightAllowance
      wm.compAllowance = v.compAllowance
      wm.absentDeduction = v.absentDeduction
      wm.salaryNetPay = salaryNet
      wm.regularWorkDays = v.regularWorkDays
      wm.dailyStatutoryOT = v.dailyStatutoryOT
      wm.weeklyStatutoryOT = v.weeklyStatutoryOT
      wm.monthlyStatutoryOT = v.monthlyStatutoryOT
      wm.legalLimit = v.legalLimit
      wm.prescribedHours = baseDays * 7
      wm.actualWorkHours = v.actualWorkHours
      wm.legalOtHours = v.statutoryOT
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = fixedBase
      // 2026-06-XX 修正 (I-10): 出向控除を実支給額ベースに置換
      if (wm.isDispatched) wm.dispatchDeduction = salaryNet
      wm.absence = v.absentDays
      wm.absentCost = v.absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa !== 'none' && wm.salary && wm.salary > 0 && workerPrescribedDays > 0) {
      // ── 4月以前: 旧ルール（salary方式: 月給からの逆算） ──
      // 設計はhourlyRate版と同じ（1日6h40m, 残業=日単位積み上げ, 補償別枠, 補償・有給・試験は出勤扱い）
      const dailyHoursOld = 20 / 3
      const prescribedH = workerPrescribedDays * dailyHoursOld
      const hourlyRate = wm.salary / prescribedH  // 月給からベース時給を逆算

      const basePay = wm.salary
      const compAllowance = Math.round(hourlyRate * dailyHoursOld * 0.6 * wm.compDays)
      const otAllowance = Math.round(hourlyRate * 1.25 * wm.otHours)
      // 2026-06-XX 修正: 補償日も欠勤扱いに（労基法26条準拠で60%支給）
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed - wm.examDays)
      // ⚠️ 2026-05-08 修正: hourlyRate版と式を統一（旧: salary/days*absentDays、新: hourlyRate*dailyHoursOld*absentDays）
      //   数学的には等価だが、Math.roundの中間誤差による1〜数円のズレを解消。
      const absentDeduction = Math.round(hourlyRate * dailyHoursOld * absentDays)
      const actualWorkH = wm.actualWorkDays * dailyHoursOld + wm.compDays * 0.6 * dailyHoursOld + wm.otHours
      const salaryNet = basePay + compAllowance + otAllowance - absentDeduction

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(wm.otHours * 10) / 10
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      wm.additionalAllowance = compAllowance  // 「休業補償」として使用（UI/Excel側でラベル切替）
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.salaryNetPay = salaryNet

      wm.absence = absentDays
      wm.absentCost = absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa === 'none' && wm.salary && wm.salary > 0) {
      // ── 月給制の日本人: 月給固定 + 残業時給換算 ──
      // 基本給 = 月給(固定)
      // 時給換算 = 月給 ÷ 月所定時間（月所定日数×8h、未設定なら 20日×8h=160h）
      // 残業手当 = 時給換算 × otMul × 残業時間
      // 支給額 = 基本給 + 残業手当
      // ※ 出勤日数に関わらず基本給は固定（労基法上の月給制）
      const prescribedDaysForCalc = workerPrescribedDays > 0 ? workerPrescribedDays : 20
      const prescribedH = prescribedDaysForCalc * 8
      const hourlyEquivalent = wm.salary / prescribedH
      const basePay = wm.salary
      const otPay = Math.round(hourlyEquivalent * wm.otMul * wm.otHours)
      wm.basePay = basePay
      wm.prescribedHours = prescribedH
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.otAllowance = otPay
      wm.salaryNetPay = basePay + otPay
      // netPay: 給与支給額（=月給+残業）。totalCost は使わない（出勤日数 × rate で誤算するため）。
      wm.netPay = basePay + otPay
      // GAP2: 完全月給の原価は固定給。エントリループで積んだ salary/20 概算を上書きし、
      //   原価(totalCost) = 固定給 + 残業 = 支給額。site.cost への配賦は後段で実施。
      wm.cost = basePay
      wm.otCost = otPay
      wm.totalCost = basePay + otPay
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
    } else if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0) {
      // ⚠️ 2026-05-09: 防御的フォールバック
      //   外国人 (hourlyRate あり) なのに workerPrescribedDays が0の場合は、
      //   月所定日数が未設定で給与計算ができない状態。
      //   4月以前なら main.workDays['YYYYMM'] を 26日（日曜以外）等で設定する必要あり。
      //   サイレント失敗を防ぐため、console.error と最低限の情報を残す。
      console.error(`[compute] 警告: ${wm.name} (${ym}) の月所定日数が未設定です。main.workDays['${ym}'] を確認してください。`)
      wm.basePay = 0
      wm.salaryNetPay = 0
      wm.netPay = 0
    } else if (workerPrescribedDays > 0) {
      wm.absence = Math.max(0, workerPrescribedDays - wm.workDays - wm.compDays - wm.plUsed - wm.examDays)  // 0.6は1日出勤扱い、試験も給与計算上は出勤扱い
      wm.absentCost = Math.round(wm.absence * wm.rate)
      wm.netPay = wm.totalCost - wm.absentCost
    } else {
      wm.netPay = wm.totalCost
    }
  }

  // GAP2: 完全月給者の固定給(=totalCost)を、出勤日数比で各現場の原価へ配賦する。
  //   エントリループでは site.cost に積んでいないため、ここで現場別に上乗せする。
  //   出勤実績のない月（全休等）でも固定給は発生するため、配置現場の先頭へ計上する。
  for (const wm of workerMap.values()) {
    if (!(wm.visa === 'none' && wm.salary && wm.salary > 0)) continue
    const cost = wm.totalCost || 0
    if (cost <= 0) continue
    const dayMap = fullMonthlySiteDays.get(wm.id)
    const totalDays = dayMap ? Array.from(dayMap.values()).reduce((a, b) => a + b, 0) : 0
    if (dayMap && totalDays > 0) {
      const rows = Array.from(dayMap.entries())
      let allocated = 0
      rows.forEach(([sid, days], i) => {
        const site = siteMap.get(sid)
        if (!site) return
        // 端数は最後の現場で吸収して合計＝固定給に一致させる
        const share = i === rows.length - 1 ? (cost - allocated) : Math.round(cost * days / totalDays)
        site.cost += share
        allocated += share
        if (wm.isDispatched) site.dispatchDeduction = (site.dispatchDeduction || 0) + share
      })
    } else if (wm.sites.length > 0) {
      const site = siteMap.get(wm.sites[0])
      if (site) {
        site.cost += cost
        if (wm.isDispatched) site.dispatchDeduction = (site.dispatchDeduction || 0) + cost
      }
    }
  }

  // Calculate subcon costs
  for (const sc of subconMap.values()) {
    sc.cost = sc.workDays * sc.rate + sc.otCount * sc.otRate
  }

  // Billing & profit
  // 出向者の人件費のみ差引（売上は既に控除済みの値が入力されているためそのまま）
  for (const site of siteMap.values()) {
    const billingKey = `${site.id}_${ym}`
    const billings = main.billing[billingKey] || []
    site.billing = billings.reduce((sum, v) => sum + (v || 0), 0)
    const dd = site.dispatchDeduction || 0
    // 人件費のみ出向控除（売上はそのまま → 粗利は増える方向）
    site.cost = Math.max(0, site.cost - dd)
    site.profit = site.billing - site.cost - site.subCost
    site.profitRate = site.billing > 0 ? (site.profit / site.billing) * 100 : 0
  }

  // Round
  const r1 = (v: number) => Math.round(v * 10) / 10
  const r0 = (v: number) => Math.round(v)

  // 2026-06-XX 修正: 月給制日本人・月給制外国人はゼロ出勤月でも表示する
  //   理由: 月給制は基本給が固定で支払われるため、出勤ゼロでも給与明細に出さないと
  //         労基法24条（賃金全額払い）違反になる。
  //   従来: w.workDays > 0 || w.plDays > 0 || w.compDays > 0 のいずれかが必要だった
  //   → これだと月給制スタッフが「丸ごと有給の月」「丸ごと欠勤の月」に画面から消えていた
  const workers = Array.from(workerMap.values()).filter(w =>
    w.workDays > 0 || w.plDays > 0 || w.compDays > 0 ||
    (w.salary !== undefined && w.salary > 0)
  )
  workers.forEach(w => {
    w.workDays = r1(w.workDays); w.workAll = r1(w.workAll); w.otHours = r1(w.otHours)
    w.cost = r0(w.cost); w.otCost = r0(w.otCost); w.totalCost = r0(w.totalCost)
    w.absentCost = r0(w.absentCost); w.netPay = r0(w.netPay)
    if (w.dispatchDeduction !== undefined) w.dispatchDeduction = r0(w.dispatchDeduction)
  })

  const subcons = Array.from(subconMap.values()).filter(sc => sc.workDays > 0)
  subcons.forEach(sc => { sc.workDays = r1(sc.workDays); sc.cost = r0(sc.cost) })

  const sites = Array.from(siteMap.values())
  sites.forEach(s => {
    s.workDays = r1(s.workDays); s.subWorkDays = r1(s.subWorkDays); s.otHours = r1(s.otHours)
    s.cost = r0(s.cost); s.subCost = r0(s.subCost); s.profit = r0(s.profit); s.profitRate = r1(s.profitRate)
    if (s.dispatchDeduction !== undefined) s.dispatchDeduction = r0(s.dispatchDeduction)
  })

  // 合計人件費は出向控除を引いた値（KPI整合のため）
  const totalDispatchDeduction = workers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
  const rawTotalCost = workers.reduce((s, w) => s + w.totalCost, 0)
  const totals = {
    workDays: r1(workers.reduce((s, w) => s + w.workDays, 0)),
    subWorkDays: r1(subcons.reduce((s, sc) => s + sc.workDays, 0)),
    cost: r0(rawTotalCost - totalDispatchDeduction),  // 出向控除済み
    subCost: r0(subcons.reduce((s, sc) => s + sc.cost, 0)),
    billing: r0(sites.reduce((s, st) => s + st.billing, 0)),  // sites.billing は既に控除済み
    profit: r0(sites.reduce((s, st) => s + st.profit, 0)),
    otHours: r1(workers.reduce((s, w) => s + w.otHours, 0)),
  }

  return { workers, subcons, sites, totals }
}

// ────────────────────────────────────────
//  3段階残業判定（1ヶ月単位の変形労働時間制）
//  キャシュモ向け: 日→週→月の段階的法定外労働時間計算
// ────────────────────────────────────────

export interface DailyWorkRecord {
  day: number             // 日（1〜31）
  dayOfWeek: number       // 曜日（0=日, 1=月, ..., 6=土）
  weekNum: number         // 週番号（月曜起算）
  prescribed: number      // 所定時間（カレンダー出勤日=7, 休日=0）
  actual: number          // 実労働時間（所定+残業、0なら不在）
  overtime: number        // 出面入力の残業時間（生データ）
  isWorkDay: boolean      // カレンダー上の出勤日か
  isLegalHoliday: boolean // 法定休日（日曜日）か
  isPaidLeave: boolean    // 有給か
  dailyStatutoryOT: number // 第1段階: 日単位の法定外残業
}

export interface WeeklyOTResult {
  weekNum: number
  weekPrescribed: number  // 週の所定時間合計
  weekActual: number      // 週の実労働時間合計
  weeklyStatutoryOT: number // 第2段階: 週単位の法定外残業（日単位分を除く）
}

export interface OvertimeSummary {
  // 所定情報
  prescribedHours: number      // 月の所定労働時間合計
  prescribedDays: number       // 月の所定労働日数
  // 実績
  actualHours: number          // 月の実労働時間合計
  actualDays: number           // 月の実労働日数
  // 残業区分
  nonStatutoryOT: number       // 所定外労働時間（所定を超えるが法定内）
  statutoryOT: number          // 法定外労働時間（3段階判定の合計）
  dailyStatutoryOT: number     // 第1段階: 日単位の法定外
  weeklyStatutoryOT: number    // 第2段階: 週単位の法定外
  monthlyStatutoryOT: number   // 第3段階: 月単位の法定外
  // 休日労働
  legalHolidayHours: number    // 法定休日に働いた時間
  prescribedHolidayHours: number // 所定休日に働いた時間
  // 基本給
  hourlyRate: number           // 時間給
  fixedBasePay: number         // 基本給（固定）= 時給 × ベース日数 × 7h
  // 日次詳細
  dailyRecords: DailyWorkRecord[]
  weeklyResults: WeeklyOTResult[]
}

/**
 * 3段階残業判定を実行
 *
 * @param ym YYYYMM形式
 * @param workerId ワーカーID
 * @param hourlyRate 時間給
 * @param baseDays ベース日数（デフォルト20）
 * @param attD 出面データ
 * @param sites 現場リスト
 * @param calendarDays カレンダー日種別（siteId → { "1": "work", ... }）
 */
export function calculateOvertimeSummary(
  ym: string,
  workerId: number,
  hourlyRate: number,
  baseDays: number,
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string; workSchedule?: RawSite['workSchedule'] }[],
  calendarDays: Record<string, Record<string, string>>,
): OvertimeSummary {
  // ⚠️ 2026-05-09: この関数は「変形労働時間制（5月以降）」専用。
  //   1日所定 7h・法定上限 = 暦日数×40÷7・3段階残業判定 を前提とした計算をする。
  //   4月以前（旧ルール: 6h40min・所定日数ベース）にこの関数を呼ぶと不正な値が出るため、
  //   呼び出し側 (lib/export.ts) では `if (ym >= '202605')` でガード済み。
  //   念のためここでも防御。
  if (ym < '202605') {
    throw new Error(`calculateOvertimeSummary は5月以降の変形労働時間制専用です（受け取った ym=${ym}）`)
  }
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const numDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = numDays * 40 / 7

  // ── 日次データ構築 ──
  const dailyRecords: DailyWorkRecord[] = []

  for (let d = 1; d <= numDays; d++) {
    const dt = new Date(ymY, ymM - 1, d)
    const dow = dt.getDay() // 0=日

    // 週番号（月曜起算: 月=0, 火=1, ..., 日=6）
    const firstDay = new Date(ymY, ymM - 1, 1)
    const firstMondayOffset = (firstDay.getDay() + 6) % 7 // 月初の月曜からの日数
    const dayOffset = (d - 1) + firstMondayOffset
    const weekNum = Math.floor(dayOffset / 7) + 1

    // カレンダーから所定時間を判定（複数現場 → 出勤日があれば出勤）
    // ⚠️ 2026-05-08 修正: 所定時間を「現場の workSchedule から動的計算」に変更。
    //   旧: prescribed = isWorkDay ? 7 : 0 （IHI現場 7:30-16:30 でも 7h 固定だった）
    //   新: 当日に出勤予定の現場の workSchedule から実労働所定を計算
    let isWorkDay = false
    let workSiteIdForDay: string | null = null
    for (const siteId of Object.keys(calendarDays)) {
      const dayType = calendarDays[siteId]?.[String(d)]
      if (dayType === 'work') {
        isWorkDay = true
        workSiteIdForDay = siteId
        break
      }
    }

    const isLegalHoliday = dow === 0 // 日曜日 = 法定休日

    // 現場の workSchedule から所定時間を計算（休憩を引いた実労働相当）
    const calcPrescribedH = (siteId: string | null): number => {
      if (!siteId) return 7
      const site = sites.find(s => s.id === siteId)
      const ws = site?.workSchedule
      if (!ws?.startTime || !ws?.endTime) return 7  // workSchedule 未設定 → デフォルト 7h
      const stParts = ws.startTime.split(':').map(Number)
      const etParts = ws.endTime.split(':').map(Number)
      const startMin = stParts[0] * 60 + (stParts[1] || 0)
      const endMin = etParts[0] * 60 + (etParts[1] || 0)
      let totalMin = endMin - startMin
      // 休憩は mandatory のものを引く（出勤予定の所定時間なので強制休憩のみ控除）
      if (ws.morningBreak?.enabled !== false && ws.morningBreak?.mandatory) totalMin -= ws.morningBreak.minutes ?? 30
      if (ws.lunchBreak?.enabled !== false && ws.lunchBreak?.mandatory) totalMin -= ws.lunchBreak.minutes ?? 60
      if (ws.afternoonBreak?.enabled !== false && ws.afternoonBreak?.mandatory) totalMin -= ws.afternoonBreak.minutes ?? 30
      // 必須休憩のみだと長すぎるので、デフォルトのフル休憩で計算したい場合は全体引く
      // 現状の運用は「全休憩を取る前提」 → 全部引く
      if (ws.morningBreak?.enabled !== false && !ws.morningBreak?.mandatory) totalMin -= ws.morningBreak?.minutes ?? 30
      if (ws.afternoonBreak?.enabled !== false && !ws.afternoonBreak?.mandatory) totalMin -= ws.afternoonBreak?.minutes ?? 30
      return Math.max(0, Math.round(totalMin / 60 * 10) / 10)
    }
    const prescribed = isWorkDay ? calcPrescribedH(workSiteIdForDay) : 0

    // 出面データから実労働時間を取得
    let actual = 0
    let overtime = 0
    let isPaidLeave = false

    for (const site of sites) {
      const key = `${site.id}_${workerId}_${ym}_${d}`
      const entry = attD[key]
      if (!entry) continue
      if (entry.p) { isPaidLeave = true; break }
      // ⚠️ 2026-05-09 修正: 残骸データ対策。
      //   有給/休み/現場休/帰国中/試験 のステータスがある日は実労働を計上しない。
      //   isWorkingDay() で 5 ステータスを一括判定。
      if (!isWorkingDay(entry)) continue
      if (entry.w && entry.w > 0) {
        if (entry.st && entry.et) {
          // 時間ベース入力（202605〜）: calcActualHours で実時間（休憩控除済み）を取得
          actual = calcActualHours(entry, site.workSchedule as Parameters<typeof calcActualHours>[1])
          overtime = Math.max(0, Math.round((actual - 7) * 10) / 10)
        } else {
          // レガシー入力（202604以前）: 出勤=7h + 残業h
          actual = entry.w === 0.6 ? Math.round(7 * 0.6 * 10) / 10 : 7
          overtime = entry.o || 0
          actual += overtime
        }
      }
    }

    // 第1段階: 日単位の法定外
    let dailyStatutoryOT = 0
    if (!isPaidLeave && actual > 0 && !isLegalHoliday) {
      if (prescribed <= 8) {
        // 所定8h以下の日 → 8hを超えた分
        dailyStatutoryOT = Math.max(0, actual - 8)
      } else {
        // 所定8h超の日 → その所定を超えた分
        dailyStatutoryOT = Math.max(0, actual - prescribed)
      }
    }

    dailyRecords.push({
      day: d, dayOfWeek: dow, weekNum, prescribed, actual, overtime,
      isWorkDay, isLegalHoliday, isPaidLeave, dailyStatutoryOT,
    })
  }

  // ── 第2段階: 週単位 ──
  const weekNums = [...new Set(dailyRecords.map(r => r.weekNum))].sort((a, b) => a - b)
  const weeklyResults: WeeklyOTResult[] = []

  for (const wn of weekNums) {
    const weekDays = dailyRecords.filter(r => r.weekNum === wn)
    // 法定休日労働は週の実労働から除外（別枠）
    const weekPrescribed = weekDays.reduce((s, r) => s + r.prescribed, 0)
    const weekActual = weekDays.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.actual, 0)
    const weekDailyOT = weekDays.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.dailyStatutoryOT, 0)

    let weeklyStatutoryOT = 0
    if (weekPrescribed <= 40) {
      // 所定40h以下の週 → 40hを超えた分（日単位分を除く）
      weeklyStatutoryOT = Math.max(0, weekActual - 40 - weekDailyOT)
    } else {
      // 所定40h超の週 → その所定を超えた分（日単位分を除く）
      weeklyStatutoryOT = Math.max(0, weekActual - weekPrescribed - weekDailyOT)
    }

    weeklyResults.push({ weekNum: wn, weekPrescribed, weekActual, weeklyStatutoryOT })
  }

  // ── 第3段階: 月単位 ──
  const totalActual = dailyRecords.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.actual, 0)
  const totalDailyOT = dailyRecords.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.dailyStatutoryOT, 0)
  const totalWeeklyOT = weeklyResults.reduce((s, w) => s + w.weeklyStatutoryOT, 0)
  const monthlyStatutoryOT = Math.max(0, totalActual - legalLimit - totalDailyOT - totalWeeklyOT)

  // ── 集計 ──
  const prescribedHours = dailyRecords.reduce((s, r) => s + r.prescribed, 0)
  const prescribedDays = dailyRecords.filter(r => r.isWorkDay).length
  const actualHours = dailyRecords.reduce((s, r) => s + r.actual, 0) // 法定休日含む
  const actualDays = dailyRecords.filter(r => r.actual > 0 && !r.isPaidLeave).length

  // 法定休日労働
  const legalHolidayHours = dailyRecords
    .filter(r => r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + r.actual, 0)

  // 所定休日労働（法定休日以外で、カレンダー上休日だが出勤した日）
  const prescribedHolidayHours = dailyRecords
    .filter(r => !r.isWorkDay && !r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + r.actual, 0)

  // 所定外労働（所定時間を超えた全時間。法定内・法定外の両方を含む）
  const nonStatutoryOT = dailyRecords
    .filter(r => !r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + Math.max(0, r.actual - r.prescribed), 0)

  const statutoryOT = Math.round((totalDailyOT + totalWeeklyOT + monthlyStatutoryOT) * 10) / 10
  const fixedBasePay = Math.round(hourlyRate * baseDays * 7)

  return {
    prescribedHours: Math.round(prescribedHours * 10) / 10,
    prescribedDays,
    actualHours: Math.round(actualHours * 10) / 10,
    actualDays,
    nonStatutoryOT: Math.round(nonStatutoryOT * 10) / 10,
    statutoryOT,
    dailyStatutoryOT: Math.round(totalDailyOT * 10) / 10,
    weeklyStatutoryOT: Math.round(totalWeeklyOT * 10) / 10,
    monthlyStatutoryOT: Math.round(monthlyStatutoryOT * 10) / 10,
    legalHolidayHours: Math.round(legalHolidayHours * 10) / 10,
    prescribedHolidayHours: Math.round(prescribedHolidayHours * 10) / 10,
    hourlyRate,
    fixedBasePay,
    dailyRecords,
    weeklyResults,
  }
}

// ────────────────────────────────────────
//  ベトナム人スタッフ給与計算（新ルール、法令準拠）
//  2026-05-13 追加: 法定休日・深夜・休業の各手当を自動計上
// ────────────────────────────────────────

export interface VietnameseSalaryResult {
  // 時間集計
  actualWorkHours: number       // 全実労働時間（法定休日含む）
  regularHours: number          // 日曜以外の実労働時間
  legalHolidayHours: number     // 日曜の実労働時間
  nightHours: number            // 22:00〜5:00 と重なる労働時間

  // 日数集計
  regularWorkDays: number       // 日曜出勤・補償日を除いた出勤日数（追加所定の対象）
  legalHolidayDays: number      // 日曜出勤日数
  absentDays: number            // 欠勤日数

  // 残業内訳（3層判定: regular内）
  dailyStatutoryOT: number
  weeklyStatutoryOT: number
  monthlyStatutoryOT: number
  statutoryOT: number           // 合計
  legalLimit: number            // 月の法定上限時間

  // 支給項目
  fixedBasePay: number          // 1. 基本給（固定）
  additionalAllowance: number   // 2. 追加所定手当（追加出勤日 × 7h）
  nonStatutoryOTHours: number   // 3a. 所定外労働時間（法定内・割増なし）
  nonStatutoryOTAllowance: number // 3a. 所定外労働手当 = 時給 × nonStatutoryOTHours
  otAllowance: number           // 3b. 法定外残業手当（1.25倍）
  legalHolidayAllowance: number // 4. 法定休日手当（1.35倍）
  nightAllowance: number        // 5. 深夜手当（+0.25倍）
  compAllowance: number         // 6. 休業手当（補償日）
  absentDeduction: number       // 7. 欠勤控除
  salaryNet: number             // 支給額合計
}

/**
 * 22:00〜5:00 の深夜時間帯と労働時間帯の重なりを計算（分単位）
 *
 * - 出退勤時刻が日付をまたぐ場合（et < st）も対応
 * - 22:00-翌5:00 を [22*60, 29*60] の連続窓として計算
 * - 翌5:00 以降の労働が出勤翌々日まで及ぶケースは想定外（建設業のシフトでは発生しない）
 *
 * 注: 休憩時間が深夜帯に重なる場合は、簡略化のため引かない。
 *     建設業の通常運用（昼食60分・午前/午後30分休憩）は深夜帯と重ならないため実害なし。
 */
function calcNightMinutes(startMin: number, endMin: number): number {
  let end = endMin
  if (end <= startMin) end += 24 * 60 // 日付またぎ
  // 深夜帯: [22:00, 翌5:00] = [1320, 1740]、および前日からの引き継ぎ [-120, 300] = [0,300]
  const windows: [number, number][] = [
    [0, 300],         // 当日 00:00-05:00
    [1320, 1740],     // 当日 22:00-翌5:00
    [1320 + 1440, 1740 + 1440], // 翌日 22:00-翌々5:00（日付またぎシフトに対応）
  ]
  let total = 0
  for (const [a, b] of windows) {
    const lo = Math.max(startMin, a)
    const hi = Math.min(end, b)
    if (hi > lo) total += hi - lo
  }
  return total
}

/**
 * ベトナム人スタッフの月次給与を法令準拠で計算する（変形労働時間制、新ルール）
 *
 * 設計方針:
 *   - 法定休日（日曜）労働: 1.35倍 で別途加算（追加所定・残業判定からは除外）
 *   - 所定休日（土・カレンダーoff/holiday）労働: 通常時給扱い、週40h超過分のみ1.25倍
 *     → 別枠の所定休日割増は法律上不要のため、最小コストとなる扱い
 *   - 深夜帯（22:00〜5:00）労働: 0.25倍を上乗せ（他の倍率と独立）
 *   - 休業手当（補償日）: 平均賃金の60%（時給×7h×0.6×日数）
 *   - 欠勤控除: 通常出勤日数が baseDays(20) に満たない場合、不足分を控除
 *
 * @param workerId 対象ワーカーID
 * @param ym       'YYYYMM'
 * @param hourlyRate 時間給
 * @param baseDays   基本給ベース日数（通常20）
 * @param attD       月の出面データ
 * @param sites      現場リスト（workSchedule で実労働時間を計算するため）
 * @param plUsed     当月の有給使用日数
 * @param compDays   当月の補償日数（w=0.6）
 * @param examDays   当月の試験日数
 */
export function calculateVietnameseSalary(
  workerId: number,
  ym: string,
  hourlyRate: number,
  baseDays: number,
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name?: string; workSchedule?: RawSite['workSchedule'] }[],
  plUsed: number,
  compDays: number,
  examDays: number,
): VietnameseSalaryResult {
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const numDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = numDays * 40 / 7

  // ── 日次集計 ──
  // 各日の実労働時間・所定時間・休日種別を計算
  // 2026-06-XX 追加: prescribedHours (その日の所定時間) を保持
  //   - C-2: 現場の workSchedule に従って動的に算出（IHI現場の 8h 等）
  //   - C-6: 半日勤務 (w=0.5) は scheduled も w 倍にして整合
  type DayInfo = {
    day: number
    dow: number              // 0=日
    weekNum: number          // 月曜起算
    isLegalHoliday: boolean  // 日曜
    actualHours: number      // その日の実労働時間（補償日除く、休憩控除済み）
    prescribedHours: number  // その日の所定時間（現場workSchedule + w係数）
    nightMinutes: number     // その日の深夜時間（分）
    hadWork: boolean         // 何らかの労働があったか
  }
  const dayInfos: DayInfo[] = []
  const firstDayDow = new Date(ymY, ymM - 1, 1).getDay()
  const firstMondayOffset = (firstDayDow + 6) % 7

  // 現場の workSchedule から所定時間 (休憩込み) を計算するヘルパー
  // calculateOvertimeSummary の calcPrescribedH と同じロジック
  const calcPrescribedH = (siteId: string): number => {
    const site = sites.find(s => s.id === siteId)
    const ws = site?.workSchedule as { startTime?: string; endTime?: string; morningBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number }; lunchBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number }; afternoonBreak?: { enabled?: boolean; mandatory?: boolean; minutes?: number } } | undefined
    if (!ws?.startTime || !ws?.endTime) return 7
    const stParts = ws.startTime.split(':').map(Number)
    const etParts = ws.endTime.split(':').map(Number)
    const startMin = stParts[0] * 60 + (stParts[1] || 0)
    const endMin = etParts[0] * 60 + (etParts[1] || 0)
    let totalMin = endMin - startMin
    if (ws.morningBreak?.enabled !== false) totalMin -= ws.morningBreak?.minutes ?? 30
    if (ws.lunchBreak?.enabled !== false) totalMin -= ws.lunchBreak?.minutes ?? 60
    if (ws.afternoonBreak?.enabled !== false) totalMin -= ws.afternoonBreak?.minutes ?? 30
    return Math.max(0, Math.round(totalMin / 60 * 10) / 10)
  }

  for (let d = 1; d <= numDays; d++) {
    const dow = new Date(ymY, ymM - 1, d).getDay()
    const dayOffset = (d - 1) + firstMondayOffset
    const weekNum = Math.floor(dayOffset / 7) + 1
    const isLegalHoliday = dow === 0

    let actualHours = 0
    let prescribedHours = 0
    let nightMinutes = 0
    let hadWork = false

    for (const site of sites) {
      const key = `${site.id}_${workerId}_${ym}_${d}`
      const entry = attD[key]
      if (!entry) continue
      // 有給・休み・現場休・帰国中・試験は実労働ゼロ
      if (entry.p || entry.r || entry.h || entry.hk || entry.exam) continue
      if (!entry.w || entry.w <= 0) continue
      // 補償日（w=0.6）は実労働時間にカウントしない（休業手当で別途支払い）
      if (entry.w === 0.6) continue

      hadWork = true
      const sitePrescribed = calcPrescribedH(site.id)
      // C-6 修正: w 係数を所定時間にも適用（半日勤務 w=0.5 → 所定 3.5h）
      prescribedHours += sitePrescribed * entry.w

      let dayHours = 0
      if (entry.st && entry.et) {
        // 時間ベース: 現場の workSchedule に従って実労働を計算
        dayHours = calcActualHours(entry, site.workSchedule as Parameters<typeof calcActualHours>[1])
        // 深夜時間（休憩控除前のレンジで計算 — 建設業の休憩は深夜帯と重ならない前提）
        const stParts = entry.st.split(':').map(Number)
        const etParts = entry.et.split(':').map(Number)
        const startMin = stParts[0] * 60 + (stParts[1] || 0)
        const endMin = etParts[0] * 60 + (etParts[1] || 0)
        nightMinutes += calcNightMinutes(startMin, endMin)
      } else {
        // レガシー入力: 主集計と式統一 = w × sitePrescribed + 残業h
        // C-6 修正: 旧 (7 + o) → (w × sitePrescribed + o)
        //   半日勤務 (w=0.5) で actualHours が過大計上されるバグを修正
        dayHours = entry.w * sitePrescribed + (entry.o || 0)
        // C-5 警告: レガシー入力では深夜時間が判定不能（st/et が無いため）
        //   5月以降の新ルール月で残業欄(o)が入っている場合は、深夜手当が
        //   0として扱われる可能性がある。コンソール警告で気付かせる。
        if (ym >= '202605' && (entry.o || 0) > 0) {
          console.warn(
            `[compute] 警告: ${workerId} の ${ym}-${d} はレガシー入力(st/et無し)で残業 ${entry.o}h あり。` +
            `深夜手当が計算できない可能性があります。出面入力でst/etを記入してください。`
          )
        }
      }
      actualHours += dayHours
    }

    dayInfos.push({
      day: d, dow, weekNum, isLegalHoliday,
      actualHours: Math.round(actualHours * 100) / 100,
      prescribedHours: Math.round(prescribedHours * 100) / 100,
      nightMinutes,
      hadWork,
    })
  }

  // ── 時間集計 ──
  const legalHolidayHours = dayInfos
    .filter(di => di.isLegalHoliday)
    .reduce((s, di) => s + di.actualHours, 0)
  const regularHours = dayInfos
    .filter(di => !di.isLegalHoliday)
    .reduce((s, di) => s + di.actualHours, 0)
  const actualWorkHours = legalHolidayHours + regularHours
  const nightHours = dayInfos.reduce((s, di) => s + di.nightMinutes, 0) / 60

  // ── 日数集計 ──
  // 法定休日に出勤した日数（別枠で1.35倍支給するため、追加所定の対象外）
  const legalHolidayDays = dayInfos.filter(di => di.isLegalHoliday && di.hadWork).length
  // 通常出勤日数: 法定休日以外で実労働があった日（補償・有給・試験は対象外）
  // 「追加所定手当」の対象になる日数。所定休日(土・off設定日)も含めて算入し、
  // 週40h超過の判定で自然に1.25倍が適用される（最低法令準拠）。
  const regularWorkDays = dayInfos.filter(di => !di.isLegalHoliday && di.hadWork).length

  // ── 3層残業判定（regular内のみ） ──
  // 第1段階: 日単位の法定外（regular内、1日8h超）
  const dailyOTByDay: Record<number, number> = {}
  let totalDailyOT = 0
  for (const di of dayInfos) {
    if (di.isLegalHoliday || di.actualHours === 0) continue
    const over = Math.max(0, di.actualHours - 8)
    dailyOTByDay[di.day] = over
    totalDailyOT += over
  }
  // 第2段階: 週単位（regular内、週40h超 − 日単位分）
  const weekNums = [...new Set(dayInfos.map(di => di.weekNum))].sort((a, b) => a - b)
  let totalWeeklyOT = 0
  for (const wn of weekNums) {
    const weekRegular = dayInfos
      .filter(di => di.weekNum === wn && !di.isLegalHoliday)
      .reduce((s, di) => s + di.actualHours, 0)
    const weekDailyOT = dayInfos
      .filter(di => di.weekNum === wn && !di.isLegalHoliday)
      .reduce((s, di) => s + (dailyOTByDay[di.day] || 0), 0)
    totalWeeklyOT += Math.max(0, weekRegular - 40 - weekDailyOT)
  }
  // 第3段階: 月単位（regular内、法定上限超 − 日単位 − 週単位）
  const monthlyStatutoryOT = Math.max(0, regularHours - legalLimit - totalDailyOT - totalWeeklyOT)
  const statutoryOT = totalDailyOT + totalWeeklyOT + monthlyStatutoryOT

  // ── 支給項目計算 ──
  const fixedBasePay = Math.round(hourlyRate * baseDays * 7)
  const additionalDays = Math.max(0, regularWorkDays - baseDays)
  const additionalAllowance = Math.round(hourlyRate * additionalDays * 7)

  // 2026-06-XX 修正: 法定外残業手当は「割増分のみ (0.25 or 0.5倍)」
  //   旧バグ: 1.25 倍 (= 基本1.0 + 割増0.25) で計算 → 基本1.0倍が
  //     基本給/追加所定/所定外労働でも支払われており二重支給
  //     例: ハウ 22日×7h, 週40h超4h → 基本給+追加所定で154h × 1.0 + 法定外残業4h × 1.25
  //          = 159h相当 → 正解は 155h (154h + 4h × 0.25) なので 4h × 時給 過払い
  //   新ロジック:
  //     - 基本給/追加所定/所定外労働 が全労働を 1.0 倍カバー
  //     - 法定外残業 = 割増分のみ (0.25 or 0.5倍)
  //     - 結果: 全労働 1.0倍 + 法定外残業に対して +0.25 (= 1.25倍) → 法令準拠
  //   2026-06-XX (C-4): 月60h超は +0.5倍（旧: 1.5倍 = 1.0 + 0.5）
  const otUnder60 = Math.min(60, statutoryOT)
  const otOver60 = Math.max(0, statutoryOT - 60)
  const otAllowance = Math.round(hourlyRate * (0.25 * otUnder60 + 0.5 * otOver60))

  // 2026-06-XX 修正 (C-3): 法定休日労働 8h超の追加0.25倍（労基法37条）
  //   法定休日(日曜)出勤は通常1.35倍だが、8h超部分は更に深夜・時間外と
  //   同じく+0.25 = 1.60倍にする必要がある。
  //   例: 日曜10h勤務 = 8h × 1.35 + 2h × 1.60 = 10.8h + 3.2h = 14.0h相当
  const lhUnder8 = dayInfos
    .filter(di => di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.min(8, di.actualHours), 0)
  const lhOver8 = dayInfos
    .filter(di => di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.max(0, di.actualHours - 8), 0)
  const legalHolidayAllowance = Math.round(hourlyRate * (1.35 * lhUnder8 + 1.60 * lhOver8))
  const nightAllowance = Math.round(hourlyRate * 0.25 * nightHours)
  const compAllowance = Math.round(hourlyRate * 7 * 0.6 * compDays)

  // 所定外労働手当（法定内・割増なし）
  // 労基法24条（賃金全額払い）に基づき、月所定時間を超えた労働で
  // 法定上限内のものは「通常賃金」で支払う必要がある。
  //
  // 基本給 = baseDays × 7h をカバー。
  // 追加所定 = 出勤日数が baseDays を超えた場合に「丸1日分 × 7h」を加算。
  // ↑これだけだと、1日のうち所定超過の労働（残業欄入力分）が支払い対象から
  //   漏れる。日次の所定超過分(各日 actualHours - prescribedHours)を支払う。
  //
  // 2026-06-XX 修正 (C-2): 所定時間を固定 7h ではなく、各日の prescribedHours
  //   (現場workSchedule × w係数) で動的判定。IHI現場(8h)などで過大計上を防ぐ。
  //
  // 2026-06-XX 修正: statutoryOT を差し引かない（法定外残業手当を「割増のみ」にしたため）
  //   旧: nonStatutoryOTHours = max(0, totalDailyExcess - statutoryOT)
  //       → 「法定外残業の 1.0倍 base portion」を所定外労働から減算していた
  //       → 法定外残業手当が 1.25倍 (= base + premium) を支払う前提だった
  //   新: nonStatutoryOTHours = totalDailyExcess（全部 1.0倍 で支払い）
  //       法定外残業手当は割増 0.25倍のみ。base 1.0倍は所定外労働手当から自然に支払われる
  //
  // 例: 出勤18日(各日所定7h)+有給2日+残業18.5h、3層判定 statutoryOT=1.0h
  //     → 所定外労働時間 = 18.5h (全部)
  //     → 所定外労働手当 = 時給×18.5h × 1.0 (内 1h は法定外残業も該当)
  //     → 法定外残業手当 = 時給×1.0h × 0.25 (割増のみ)
  //     → 1.0h分の合計 = 1.0倍 + 0.25倍 = 1.25倍 ✓ (法令準拠)
  const totalDailyExcess = dayInfos
    .filter(di => !di.isLegalHoliday && di.actualHours > 0)
    .reduce((s, di) => s + Math.max(0, di.actualHours - di.prescribedHours), 0)
  const nonStatutoryOTHours = totalDailyExcess
  const nonStatutoryOTAllowance = Math.round(hourlyRate * nonStatutoryOTHours)

  // 欠勤控除: 法定休日出勤は所定日数(20)カウント対象外（カレンダー上は休み）
  // 2026-06-XX 修正: 補償日(compDays)も欠勤扱いに変更（労基法26条準拠）
  //   旧: compDays を absentDays から除外 → 基本給で100%支払い + 60% 休業手当 = 160% (過払い)
  //   新: compDays を欠勤として算入 → 基本給から 1日分減額 + 60% 休業手当 = 60% (法令準拠)
  //   結果: 補償日 1日 = 基本給(時給×7h) を欠勤控除で減額し、休業手当(時給×7h×0.6) で 60% 補償
  const absentDays = Math.max(0, baseDays - regularWorkDays - plUsed - examDays)
  const absentDeduction = Math.round(hourlyRate * 7 * absentDays)

  const salaryNet = fixedBasePay + additionalAllowance + nonStatutoryOTAllowance + otAllowance
                  + legalHolidayAllowance + nightAllowance + compAllowance
                  - absentDeduction

  return {
    actualWorkHours: Math.round(actualWorkHours * 10) / 10,
    regularHours: Math.round(regularHours * 10) / 10,
    legalHolidayHours: Math.round(legalHolidayHours * 10) / 10,
    nightHours: Math.round(nightHours * 10) / 10,
    regularWorkDays,
    legalHolidayDays,
    absentDays,
    dailyStatutoryOT: Math.round(totalDailyOT * 10) / 10,
    weeklyStatutoryOT: Math.round(totalWeeklyOT * 10) / 10,
    monthlyStatutoryOT: Math.round(monthlyStatutoryOT * 10) / 10,
    statutoryOT: Math.round(statutoryOT * 10) / 10,
    legalLimit: Math.round(legalLimit * 10) / 10,
    fixedBasePay,
    additionalAllowance,
    nonStatutoryOTHours: Math.round(nonStatutoryOTHours * 10) / 10,
    nonStatutoryOTAllowance,
    otAllowance,
    legalHolidayAllowance,
    nightAllowance,
    compAllowance,
    absentDeduction,
    salaryNet,
  }
}

// ────────────────────────────────────────
//  ヘルパー
// ────────────────────────────────────────

export function isLocked(locks: Record<string, boolean>, ym: string): boolean {
  return !!locks[ym]
}

/** 組織別ロック判定（後方互換: 旧 locks[ym] もチェック） */
export function isLockedForOrg(locks: Record<string, boolean>, ym: string, org: 'hibi' | 'hfu'): boolean {
  // 新形式: locks["202603_hibi"] or locks["202603_hfu"]
  if (locks[`${ym}_${org}`]) return true
  // 旧形式: locks["202603"] = true（全組織ロック扱い）
  if (locks[ym]) return true
  return false
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
