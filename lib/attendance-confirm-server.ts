/**
 * 本人確認（lib/attendance-confirm.ts）のサーバ側の共通処理（2026-09-30）
 *
 * - 本人確認 API（app/api/attendance/confirm）と月締め（app/api/monthly/lock）で同じ判定を使う
 * - 出面ドキュメントは呼び出し側で1回だけ読んで渡す。カレンダーは現場ごとに1回、承認は lib/approval-gap.ts（2分キャッシュ）
 */
import { db } from './firebase'
import { doc, getDoc, setDoc } from '@/lib/fsdb'
import { calendarSiteIdOf, type HierarchySite } from './site-hierarchy'
import { approvalGap } from './approval-gap'
import {
  summarizeWorkerMonth, summaryFingerprint, mainSiteOfMonth, breakShortenMinFor,
  isConfirmStale, jstDateOf, requiredApprovalKeys,
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

  const readiness = async (worker: ConfirmWorker): Promise<ConfirmReadiness> => {
    const keys = requiredApprovalKeys({
      d, workerId: worker.id, ym, calDays: await calOfWorker(worker.id),
      approvalSiteOf: sid => calendarSiteIdOf(sites, sid),
      hireDate: worker.hireDate, retired: worker.retired,
    })
    if (keys.length === 0) return { noEntries: true, foremanMissing: 0, finalMissing: 0, ready: false }
    // 承認の判定は請求書と共通（lib/approval-gap.ts。工種サイトの子で承認した記録も数える・2分キャッシュ）
    const sep = `_${ym}_`
    const famDays = keys.map(k => { const i = k.lastIndexOf(sep); return { familyId: k.slice(0, i), day: Number(k.slice(i + sep.length)) } })
    const gap = await approvalGap(sites as { id: string; parentId?: string }[], ym, famDays)
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

  return { summarize, readiness, staleOf }
}

/** 月締めで見る本人確認の状態 */
export type StaffConfirmState = 'ok' | 'none' | 'early' | 'stale' | 'issue'
export const STAFF_CONFIRM_STATE_LABEL: Record<StaffConfirmState, string> = {
  ok: '確認ずみ',
  none: '未確認',
  early: '未確認（承認前に確認しただけ）',
  stale: '要再確認（確認のあとで出面が変わった）',
  issue: '本人から「まちがいがある」の連絡（未対応）',
}

export async function staffConfirmStateOf(
  c: AttConfirmDoc | null | undefined, worker: ConfirmWorker, ctx: ReturnType<typeof confirmMonthContext>,
): Promise<StaffConfirmState> {
  if (!c) return 'none'
  if (!c.afterApproval) return 'early'
  if (await ctx.staleOf(c, worker)) return 'stale'
  // 連絡は事務所が「対応済み」にしたら確認ずみと同じ（出面を直した場合は上の stale で再確認になる）
  return c.status === 'issue' && !c.resolvedAt ? 'issue' : 'ok'
}
