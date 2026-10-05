/**
 * スタッフのスマホ画面で最初に出す現場（2026-10-05 代表依頼）。
 *
 * 配置が1つの人はその現場。配置が2つ以上ある人（現場を行き来する人）は、**いちばん最近に出勤を入れた配置現場**を出す
 * （旧: 現場マスタの並びで先の現場が毎日出て、もう一方の現場の日は毎回選び直しになり、選び忘れて前の現場に入るミスが出ていた）。
 * 配置されていない現場（応援など）に入れた記録は見ない＝配置の外の現場が最初に出ることはない。
 * 最近の出勤が見つからなければ今までどおり配置の先頭。Firestore を読まない純粋関数。
 */
import type { AttendanceEntry } from '@/types'

type AttMap = Record<string, AttendanceEntry | null | undefined>

/** 出勤として数える記録（有給・欠・0.6補・帰国・試験は現場を決める材料にしない） */
function isWorkEntry(e: AttendanceEntry | null | undefined): boolean {
  if (!e) return false
  const x = e as AttendanceEntry & { nonly?: number }
  if (x.p || x.r || x.hk || x.exam || x.h) return false
  if (x.w === 0.6) return false
  return (x.w || 0) > 0 || !!x.nonly
}

/**
 * @param assigned 配置されている現場（親現場の id・最初に出したい順）
 * @param familyOf 親現場 → その現場の id 一式（親＋工種サイト）
 * @param months   見る月の出面（新しい月を先に）。{ ym: 'YYYYMM', d: 出面 }
 * @param today    今日（この日より先の記録は見ない）
 */
export function defaultStaffSiteId(args: {
  assigned: string[]
  familyOf: (siteId: string) => string[]
  months: { ym: string; d: AttMap | null | undefined }[]
  workerId: number
  today: { ym: string; day: number }
}): string | undefined {
  const { assigned, familyOf, months, workerId, today } = args
  if (assigned.length <= 1) return assigned[0]
  const parentOf = new Map<string, string>()
  for (const a of assigned) for (const sid of familyOf(a)) if (!parentOf.has(sid)) parentOf.set(sid, a)
  let best: { stamp: number; site: string } | null = null
  for (const { ym, d } of months) {
    if (!d) continue
    const tail = `_${workerId}_${ym}_`
    for (const [key, e] of Object.entries(d)) {
      const i = key.lastIndexOf(tail)
      if (i <= 0 || !isWorkEntry(e)) continue
      const day = Number(key.slice(i + tail.length))
      if (!Number.isFinite(day) || (ym === today.ym && day > today.day) || ym > today.ym) continue
      const site = parentOf.get(key.slice(0, i))
      if (!site) continue
      const stamp = Number(ym) * 100 + day
      if (!best || stamp > best.stamp) best = { stamp, site }
    }
  }
  return best?.site ?? assigned[0]
}
