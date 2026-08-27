/**
 * ダッシュボード・原価収益管理の労務費を「実支給額ベース」に揃えるヘルパー（2026-08-27）。
 *
 * 背景: これらの画面は簡易 compute()（日数×日額＋残業概算）で原価を出しており、
 * 有給の人件費・月給固定者の出勤ゼロ月・3層構造の割増/控除・遠方現場日当・運転手当が
 * 入らず、月次集計（computeMonthly＝原価は実支給額）と恒常的に食い違っていた。
 *
 * 本ヘルパーは compute() の結果オブジェクトのうち **原価系フィールドだけ** を
 * computeMonthly 由来の値で上書きする。人工・残業h・外注費は compute() のまま
 * （同じロジックのため）。
 *
 * ⚠️ 「前月同日まで」比較（日割りで切った出面同士の比較）には使わないこと。
 *    computeMonthly は月給固定者の給与を月額で計上するため、日割り比較の趣旨が壊れる。
 *    同日比較は概算同士（compute() 同士）で整合が取れている。
 *
 * 読み取りへの配慮（CLAUDE.md「読み取り回数を増やさない」）:
 * - 出面は呼び出し元が読み込んだものを受け取る（追加読みゼロ）
 * - カレンダー・帰国情報・手当履歴は 30 秒メモ化（同一リクエスト内の複数回呼び出しと
 *   連続リロードで再読しない）
 */
import {
  computeMonthly, loadMonthlyAllowances, type MainData,
} from './compute'
import type { AttendanceEntry } from '@/types'
import { getMonthlyCalendars } from './repositories/calendarRepo'
import { getAllActiveHomeLeaves, type HomeLeaveEntry } from './homeLeave'

export interface MonthAtt {
  ym: string
  d: Record<string, AttendanceEntry>
  sd: Record<string, { n: number; on: number }>
  drv?: Record<string, { am?: number[]; pm?: number[] }>
}

/** compute() の結果のうち、本ヘルパーが触る形。 */
interface ComputeLikeResult {
  sites: Record<string, { work: number; ot: number; otEq: number; cost: number; subWork: number; subOT: number; subOtEq: number; subCost: number; dispatchDeduction: number }>
  totalCost: number
  totalDispatchDeduction?: number
}

// ── 30秒メモ（カレンダー・帰国情報）──
const TTL_MS = 30_000
let hlCache: { at: number; data: HomeLeaveEntry[] } | null = null
const calCache = new Map<string, { at: number; data: Record<string, Record<string, string>> }>()

async function homeLeavesCached(): Promise<HomeLeaveEntry[]> {
  if (hlCache && Date.now() - hlCache.at < TTL_MS) return hlCache.data
  const data = await getAllActiveHomeLeaves()
  hlCache = { at: Date.now(), data }
  return data
}

async function calendarDaysCached(ym: string): Promise<Record<string, Record<string, string>>> {
  const hit = calCache.get(ym)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data
  const cals = await getMonthlyCalendars(`${ym.slice(0, 4)}-${ym.slice(4, 6)}` as Parameters<typeof getMonthlyCalendars>[0])
  const map: Record<string, Record<string, string>> = {}
  for (const c of cals) if (c.days) map[c.siteId] = c.days
  calCache.set(ym, { at: Date.now(), data: map })
  return map
}

/**
 * 月ごとの実支給ベース原価（現場別・合計）を計算する。
 * 引数の組み立ては /api/monthly と同一（画面の月次集計と同じ数字になる）。
 */
export async function computePayrollCostForMonths(
  main: MainData,
  months: MonthAtt[],
): Promise<{
  bySite: Record<string, { cost: number; dispatchDeduction: number }>
  totalCost: number
  totalDispatchDeduction: number
}> {
  const bySite: Record<string, { cost: number; dispatchDeduction: number }> = {}
  let totalCost = 0
  let totalDispatchDeduction = 0

  // 手当の長期従事履歴は、渡された月の出面を再利用して追加読みを避ける
  const preloadedAttD: Record<string, Record<string, AttendanceEntry>> = {}
  for (const m of months) preloadedAttD[m.ym] = m.d

  const homeLeaves = await homeLeavesCached()

  for (const m of months) {
    const ym = m.ym
    const prescribedDays = main.workDays[ym] || 0
    const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
    const hasCal = Object.keys(siteWorkDaysMap).length > 0
    const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
    const calendarDaysMap = await calendarDaysCached(ym)
    const allowances = await loadMonthlyAllowances(main, ym, m.d, m.drv, { preloadedAttD })
    const r = computeMonthly(
      main, m.d, m.sd, ym, prescribedDays,
      hasCal ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves, allowances,
    )
    // computeMonthly の site.cost は出向控除済み → ダッシュボード側の期待（控除前 + 控除額別持ち）に合わせて戻す
    for (const site of r.sites) {
      const dd = site.dispatchDeduction || 0
      const agg = bySite[site.id] || (bySite[site.id] = { cost: 0, dispatchDeduction: 0 })
      agg.cost += site.cost + dd
      agg.dispatchDeduction += dd
    }
    const monthDd = r.workers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
    totalDispatchDeduction += monthDd
    // totals.cost は控除済み → 控除前に戻す（compute() の totalCost と同じ意味に）
    totalCost += r.totals.cost + monthDd
  }

  return { bySite, totalCost, totalDispatchDeduction }
}

/**
 * compute() の結果の原価系フィールドを実支給ベースへ上書きする。
 * sites の cost / dispatchDeduction、totalCost / totalDispatchDeduction のみ変更し、
 * 人工（work/subWork）・残業・外注費（subCost）は compute() の値を維持する。
 */
export async function applyPayrollCosts(
  c: ComputeLikeResult,
  main: MainData,
  months: MonthAtt[],
): Promise<void> {
  const { bySite, totalCost, totalDispatchDeduction } = await computePayrollCostForMonths(main, months)
  for (const sid of Object.keys(c.sites)) {
    c.sites[sid].cost = bySite[sid]?.cost || 0
    c.sites[sid].dispatchDeduction = bySite[sid]?.dispatchDeduction || 0
  }
  for (const [sid, v] of Object.entries(bySite)) {
    if (!c.sites[sid]) {
      c.sites[sid] = { work: 0, ot: 0, otEq: 0, cost: v.cost, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0, dispatchDeduction: v.dispatchDeduction }
    }
  }
  c.totalCost = totalCost
  c.totalDispatchDeduction = totalDispatchDeduction
}
