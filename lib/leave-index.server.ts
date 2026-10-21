/**
 * 有給の索引（**サーバー専用**・2026-10-21 総点検 §7-1・第 1 段階）。
 *
 * 残数・年 5 日・付与予定・通知ベル・スマホの残数は、どれも「その人の有給（p）の日」を数えたいだけなのに、
 * 1 件 200〜300KB の出面（att_YYYYMM）を最大 13〜16 か月ぶん読んでいた。
 * ここでは人ごとに `leaveIndex/{workerId}` = { days: { 'YYYY-MM-DD': 'p' } } を持ち、出面に p を書いた・消したときに同じ日を更新する。
 *
 * 第 1 段階（この PR）: 書く側で索引をそろえる・出面から作り直す・食い違いを調べる。読む側はまだ出面のまま。
 * 第 2 段階: 食い違いが出ないことを確かめてから、残数の計算を索引から読むように切り替える。
 *
 * - 索引は出面から作り直せる（/api/leave/index POST）。バックアップの対象外（lib/backup-plan.ts）
 * - 同じ日に複数の現場の p があっても 1 日（残数の数え方と同じ）
 * - 索引の更新に失敗しても出面の保存は止めない（console.warn）。食い違いは GET /api/leave/index で見つける
 */
import 'server-only'
import { db } from './firebase'
import { doc, getDoc, setDoc, updateDoc, deleteField } from '@/lib/fsdb'
import { parseDKey } from './compute'
import type { AttendanceEntry } from '@/types'

export const LEAVE_INDEX_COLLECTION = 'leaveIndex'

export interface LeaveIndexDoc {
  /** 'YYYY-MM-DD' → 'p'（有給）。無い日は有給ではない */
  days: Record<string, 'p'>
  updatedAt?: string
}

const isoOf = (ym: string, day: number | string) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`

/** 出面（1 か月の d マップ）から、その人の有給の日（ISO・重複なし・昇順）を取り出す。純関数 */
export function paidLeaveDaysOf(attD: Record<string, AttendanceEntry | undefined> | null | undefined, workerId: number): string[] {
  const out = new Set<string>()
  for (const [key, e] of Object.entries(attD || {})) {
    if (!e || !e.p) continue   // truthy 判定（旧データ p:true 互換・他経路と統一）
    const pk = parseDKey(key)
    if (Number(pk.wid) !== workerId) continue
    out.add(isoOf(pk.ym, pk.day))
  }
  return [...out].sort()
}

/** 複数月の出面から、1 人の索引の中身（days）を作る。純関数 */
export function buildLeaveIndexDays(attByYm: Record<string, Record<string, AttendanceEntry | undefined>>, workerId: number): Record<string, 'p'> {
  const days: Record<string, 'p'> = {}
  for (const attD of Object.values(attByYm)) for (const iso of paidLeaveDaysOf(attD, workerId)) days[iso] = 'p'
  return days
}

/** 索引と出面の食い違い（純関数）。index に無い日＝missing、出面に無いのに index にある日＝extra */
export function diffLeaveIndex(indexDays: Record<string, unknown> | null | undefined, attDays: Record<string, 'p'>, monthsIso: string[]): { missing: string[]; extra: string[] } {
  const inScope = (iso: string) => monthsIso.includes(iso.slice(0, 7))
  const idx = new Set(Object.keys(indexDays || {}).filter(inScope))
  const att = new Set(Object.keys(attDays).filter(inScope))
  return {
    missing: [...att].filter(d => !idx.has(d)).sort(),
    extra: [...idx].filter(d => !att.has(d)).sort(),
  }
}

/** その人・その日の索引を「有給あり／なし」にそろえる。失敗しても投げない（出面の保存を止めない） */
export async function syncLeaveIndexDay(workerId: number, dateIso: string, hasPaidLeave: boolean): Promise<void> {
  try {
    const ref = doc(db, LEAVE_INDEX_COLLECTION, String(workerId))
    if (hasPaidLeave) {
      await setDoc(ref, { days: { [dateIso]: 'p' }, updatedAt: new Date().toISOString() }, { merge: true })   // 子値は非空（CLAUDE.md の安全ルール）
    } else {
      const snap = await getDoc(ref)
      if (!snap.exists() || !(snap.data() as LeaveIndexDoc).days?.[dateIso]) return
      await updateDoc(ref, { [`days.${dateIso}`]: deleteField(), updatedAt: new Date().toISOString() })
    }
  } catch (e) {
    console.warn('[leave-index] 索引の更新に失敗（出面の保存は完了。GET /api/leave/index で食い違いを確かめられます）:', e)
  }
}

/** その人・その日の有給の有無を、出面（att_YYYYMM）を読んで索引にそろえる（p を消したあとに使う） */
export async function syncLeaveIndexDayFromAtt(workerId: number, ym: string, day: number | string): Promise<void> {
  try {
    const snap = await getDoc(doc(db, 'demmen', `att_${ym}`))
    const attD = (snap.exists() ? (snap.data().d || {}) : {}) as Record<string, AttendanceEntry>
    const iso = isoOf(ym, day)
    await syncLeaveIndexDay(workerId, iso, paidLeaveDaysOf(attD, workerId).includes(iso))
  } catch (e) {
    console.warn('[leave-index] 出面の読み直しに失敗:', e)
  }
}

/** 1 人の索引を丸ごと書く（作り直し用）。days が空なら空の索引を書く（空マップは days 直下なので安全ルールの対象外＝作り直しの意図どおり） */
export async function writeLeaveIndex(workerId: number, days: Record<string, 'p'>): Promise<void> {
  await setDoc(doc(db, LEAVE_INDEX_COLLECTION, String(workerId)), { days, updatedAt: new Date().toISOString(), rebuiltAt: new Date().toISOString() })
}

export async function readLeaveIndex(workerId: number): Promise<LeaveIndexDoc | null> {
  const snap = await getDoc(doc(db, LEAVE_INDEX_COLLECTION, String(workerId)))
  return snap.exists() ? (snap.data() as LeaveIndexDoc) : null
}
