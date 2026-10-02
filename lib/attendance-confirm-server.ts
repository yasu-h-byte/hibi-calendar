/**
 * 本人確認（lib/attendance-confirm.ts）のサーバ側の共通処理（2026-09-30）
 *
 * - 本人確認 API（app/api/attendance/confirm）と月締め（app/api/monthly/lock）で同じ判定を使う
 * - 出面ドキュメントは呼び出し側で1回だけ読んで渡す。カレンダーは現場ごとに1回、承認は lib/approval-gap.ts（2分キャッシュ）
 */
import { db } from './firebase'
import { doc, getDoc, setDoc } from '@/lib/fsdb'
import { calendarSiteIdOf, type HierarchySite } from './site-hierarchy'
import { approvalGap, type FamilyDay } from './approval-gap'
import {
  summarizeWorkerMonth, summaryFingerprint, mainSiteOfMonth, breakShortenMinFor,
  isConfirmStale, jstDateOf, requiredApprovalKeys, confirmTargetYm,
  type AttConfirmDoc, type StaffMonthSummary,
} from './attendance-confirm'
import type { AttendanceEntry } from '@/types'

export type ConfirmWorker = {
  id: number; hireDate?: string; retired?: string; breakShortenMin?: number; breakShortenFrom?: string
}

export interface ConfirmReadiness {
  /** その月の記録が1件も無い（確認を出さない） */
  noEntries: boolean
  /** 職長承認が無い「現場×日」の数 */
  foremanMissing: number
  /** 最終承認（事業責任者）が無い「現場×日」の数 */
  finalMissing: number
  /** 全部そろった＝本人確認を出してよい */
  ready: boolean
}

/** 1か月分の文脈（出面・カレンダー）を持って、人ごとの数え方・承認のそろい具合・古くなったかを出す */
export function confirmMonthContext(sites: HierarchySite[], ym: string, d: Record<string, AttendanceEntry | null>) {
  const calCache = new Map<string, Promise<Record<string, string> | null>>()
  const calOfSite = (siteId: string) => {
    const calId = `${calendarSiteIdOf(sites, siteId)}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`
    if (!calCache.has(calId)) {
      calCache.set(calId, getDoc(doc(db, 'siteCalendar', calId)).then(c => {
        const cal = c.exists() ? c.data() : null
        return cal?.status === 'approved' && cal?.days ? cal.days as Record<string, string> : null
      }).catch(() => null))  // カレンダーが読めなければ日曜以外を仕事の日とみなす
    }
    return calCache.get(calId)!
  }
  const calOfWorker = async (workerId: number) => {
    const mainSite = mainSiteOfMonth(d, workerId, ym)
    return mainSite ? calOfSite(mainSite) : null
  }

  const summarize = async (worker: ConfirmWorker, todayIso: string, beforeIso?: string): Promise<StaffMonthSummary> =>
    summarizeWorkerMonth({
      d, workerId: worker.id, ym, calDays: await calOfWorker(worker.id),
      hireDate: worker.hireDate, retired: worker.retired, todayIso, beforeIso,
      breakShortenMin: breakShortenMinFor(worker, ym) || undefined,
    })

  /**
   * その人について承認が必要な「現場（親）×日」。本人確認と月締め（lib/month-approval-status.ts・2026-09分〜）が同じものを使う。
   * 記録がある日（出勤・残業・有給・休み・0.6補…すべて）＋記録が無い主現場の仕事の日
   */
  const requiredFamilyDays = async (worker: ConfirmWorker): Promise<FamilyDay[]> => {
    const keys = requiredApprovalKeys({
      d, workerId: worker.id, ym, calDays: await calOfWorker(worker.id),
      approvalSiteOf: sid => calendarSiteIdOf(sites, sid),
      hireDate: worker.hireDate, retired: worker.retired,
    })
    const sep = `_${ym}_`
    return keys.map(k => { const i = k.lastIndexOf(sep); return { familyId: k.slice(0, i), day: Number(k.slice(i + sep.length)) } })
  }

  /** fresh: 承認をキャッシュを使わず読み直す（本人の確認を記録するとき・月締めで使う・2026-10-02） */
  const readiness = async (worker: ConfirmWorker, opts?: { fresh?: boolean }): Promise<ConfirmReadiness> => {
    const famDays = await requiredFamilyDays(worker)
    if (famDays.length === 0) return { noEntries: true, foremanMissing: 0, finalMissing: 0, ready: false }
    // 承認の判定は請求書と共通（lib/approval-gap.ts。工種サイトの子で承認した記録も数える・2分キャッシュ）
    const gap = await approvalGap(sites as { id: string; parentId?: string }[], ym, famDays, opts)
    const foremanMissing = gap.foremanMissing.length
    const finalMissing = gap.finalMissing.length
    return { noEntries: false, foremanMissing, finalMissing, ready: foremanMissing === 0 && finalMissing === 0 }
  }

  /**
   * 確認の記録が古くなったか。確認した日より前の範囲だけで比べる。
   * asOf の無い古い記録は、確認した時刻から asOf を補って保存し直す（その時点では古くない扱い）
   */
  const staleOf = async (c: AttConfirmDoc, worker: ConfirmWorker): Promise<boolean> => {
    const asOf = c.asOf || jstDateOf(c.at)
    const range = await summarize(worker, asOf, asOf)
    if (!c.fpAsOf) {
      const fpAsOf = summaryFingerprint(range)
      await setDoc(doc(db, 'attConfirm', `${c.ym}_${c.workerId}`), { asOf, fpAsOf }, { merge: true })
      c.asOf = asOf; c.fpAsOf = fpAsOf
      return false
    }
    return isConfirmStale(c, range)
  }

  return { summarize, readiness, staleOf, requiredFamilyDays }
}

/**
 * 本人確認の状態（2026-10-02 一本化）。
 *
 * スマホ（app/api/attendance/confirm の本人向け）・月次集計の一覧とカード（同 事務所向け）・月締め（app/api/monthly/lock）が
 * すべてここで決めた状態を使う。旧: 画面ごとに数え方が違い、承認がそろう前でスマホに確認がまだ出ていない人まで
 * 「まだ」として警告していた（代表指摘）。
 *
 *   ok       確認ずみ（承認がそろってから「正しい」／連絡を事務所が対応済み）
 *   none     承認がそろってスマホに確認が出ているが、まだ押していない
 *   early    承認がそろう前に押しただけ（数えない。スマホにもう一度確認が出ている）
 *   stale    確認したあとで出面が変わった（スマホに再確認が出ている）
 *   issue    本人から「まちがいがある」の連絡（未対応）
 *   waiting  その人の出面の承認（職長・最終）がそろっていない → スマホにはまだ確認が出ない
 *   outside  スマホで確認できる月ではない（スマホで確認できるのは締める前の「前の月」だけ）
 */
export type StaffConfirmState = 'ok' | 'none' | 'early' | 'stale' | 'issue' | 'waiting' | 'outside'
export const STAFF_CONFIRM_STATE_LABEL: Record<StaffConfirmState, string> = {
  ok: '確認ずみ',
  none: '未確認',
  early: '未確認（承認前に確認しただけ）',
  stale: '要再確認（確認のあとで出面が変わった）',
  issue: '本人から「まちがいがある」の連絡（未対応）',
  waiting: '承認待ち（職長・最終承認がそろっていないため、スマホに確認が出ていない）',
  outside: 'スマホ確認の期間外（スマホで確認できるのは前の月だけ）',
}

/** 承認がそろってからした確認だけを数える（承認前の確認は無いものとみなす） */
export const isValidConfirmation = (c: AttConfirmDoc | null | undefined): c is AttConfirmDoc => !!c?.afterApproval

/**
 * スマホに確認を出す月か（本人向け GET/POST と同じ条件）。
 * 確認するのは「前の月」で、その会社が締めたあとは出さない。在籍の判定は対象者の選び方（staffConfirmTargets）で行う
 */
export function isPhoneConfirmMonth(ym: string, todayIso: string, locked: boolean): boolean {
  return ym === confirmTargetYm(todayIso) && !locked
}

export interface StaffConfirmEval {
  state: StaffConfirmState
  readiness: ConfirmReadiness
  /** 古くなったか（有効な確認があるときだけ意味がある） */
  stale: boolean
}

/** 1人分の状態を決める（ここ以外で状態を決めない） */
export async function evalStaffConfirm(
  c: AttConfirmDoc | null | undefined, worker: ConfirmWorker, ctx: ReturnType<typeof confirmMonthContext>,
  opts: { ym: string; todayIso: string; locked: boolean; fresh?: boolean },
): Promise<StaffConfirmEval> {
  // 本人からの連絡（未対応）は、承認の前後にかかわらず残す（事務所が中身を見て対応する）
  const openIssue = !!c && c.status === 'issue' && !c.resolvedAt
  // 進行中の月（来月になると確認の月になる）は、まだ来ていない日の承認まで読むことになるので承認を数えない（2026-10-02 点検・読み取り削減）
  if (opts.ym > confirmTargetYm(opts.todayIso) && !isValidConfirmation(c) && !openIssue) {
    return { state: 'waiting', readiness: { noEntries: false, foremanMissing: 0, finalMissing: 0, ready: false }, stale: false }
  }
  const readiness = await ctx.readiness(worker, { fresh: opts.fresh })
  if (isValidConfirmation(c)) {
    const stale = await ctx.staleOf(c, worker)
    if (stale) return { state: 'stale', readiness, stale }
    return { state: openIssue ? 'issue' : 'ok', readiness, stale }
  }
  if (openIssue) return { state: 'issue', readiness, stale: false }
  // ここから下は有効な確認が無い人。スマホに確認が出ているかどうかで分ける
  const phoneMonth = isPhoneConfirmMonth(opts.ym, opts.todayIso, opts.locked)
  const notYet = opts.ym > confirmTargetYm(opts.todayIso)   // 進行中の月（来月になると確認の月になる）
  if (!phoneMonth && !notYet) return { state: 'outside', readiness, stale: false }
  if (!readiness.ready) return { state: 'waiting', readiness, stale: false }
  return { state: c ? 'early' : 'none', readiness, stale: false }
}

/**
 * 本人確認の対象者: 外国人スタッフ（visa あり）で、その月に在籍し、出面の記録がある人。
 * 会社（org）で絞れる。スマホに確認を出す人と同じ（記録が無い月は確認を出さない＝readiness.noEntries）
 */
export function staffConfirmTargets<W extends ConfirmWorker & { visaType?: string; company?: string }>(
  workers: W[], d: Record<string, AttendanceEntry | null>, ym: string, org: 'hibi' | 'hfu' | 'all',
): W[] {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const start = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`
  const end = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  const withEntries = new Set<number>()
  const tail = `_${ym}_`
  for (const [key, e] of Object.entries(d)) {
    if (!e) continue
    const i = key.lastIndexOf(tail)
    if (i < 0) continue
    const head = key.slice(0, i)
    const wid = Number(head.slice(head.lastIndexOf('_') + 1))
    if (Number.isFinite(wid)) withEntries.add(wid)
  }
  return workers.filter(w =>
    withEntries.has(w.id) && !!w.visaType && w.visaType !== 'none'
    && !(w.retired && w.retired < start) && !(w.hireDate && w.hireDate > end)
    && (org === 'all' || (w.company === 'HFU' ? 'hfu' : 'hibi') === org))
}

export interface StaffConfirmRow {
  workerId: number
  name: string
  org: 'hibi' | 'hfu'
  state: StaffConfirmState
  /** その人の承認で足りない「現場×日」の数（waiting のときの説明用） */
  foremanMissing: number
  finalMissing: number
  /** 確認の記録（あれば）。画面のバッジと連絡の中身に使う */
  confirmation: AttConfirmDoc | null
}

/** その月の本人確認の一覧（対象者全員・状態つき）。月次集計の画面と月締めが同じものを使う */
export async function staffConfirmRows(args: {
  main: { workers?: unknown[]; sites?: unknown[]; locks?: Record<string, unknown> }
  d: Record<string, AttendanceEntry | null>
  ym: string
  org: 'hibi' | 'hfu' | 'all'
  todayIso: string
  confirmations: AttConfirmDoc[]
  /** fresh: 承認をキャッシュを使わず読み直す（月締めの判定で使う） */
  fresh?: boolean
}): Promise<StaffConfirmRow[]> {
  const { mapRawWorkers } = await import('./workers')
  const { isMonthLockedInLocks } = await import('./locks')
  const { main, d, ym, org, todayIso } = args
  const targets = staffConfirmTargets(mapRawWorkers((main.workers || []) as unknown[]), d, ym, org)
  if (targets.length === 0) return []
  const confs = new Map(args.confirmations.map(c => [c.workerId, c] as const))
  const ctx = confirmMonthContext((main.sites || []) as unknown as HierarchySite[], ym, d)
  const rows = await Promise.all(targets.map(async w => {
    const o: 'hibi' | 'hfu' = w.company === 'HFU' ? 'hfu' : 'hibi'
    const c = confs.get(w.id) || null
    const ev = await evalStaffConfirm(c, w, ctx, { ym, todayIso, locked: isMonthLockedInLocks(main.locks, ym, o), fresh: args.fresh })
    // 記録が1件も無い月は対象外（スマホにも出さない）。対象者の選び方と同じだが、入社前・退職後だけの記録はここで落ちる
    if (ev.readiness.noEntries && !c) return null
    return {
      workerId: w.id, name: w.name, org: o, state: ev.state,
      foremanMissing: ev.readiness.foremanMissing, finalMissing: ev.readiness.finalMissing,
      confirmation: c,
    } satisfies StaffConfirmRow
  }))
  return rows.filter((r): r is StaffConfirmRow => r !== null)
}
