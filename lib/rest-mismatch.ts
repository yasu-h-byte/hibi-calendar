/**
 * 会社都合休と自分都合の休みの取り違えの検出（2026-09-30 代表依頼）
 *
 * 同じ現場（工種サイトは親現場にまとめる）・同じ日のほかの人と見比べて、休みの区別が怪しい記録を見つける。
 * 会社の都合の休み（0.6補）は60%支払い、自分の都合の休み（欠）は最低保証から引くので、取り違えると給料が大きく変わる。
 *
 * 見つけるのは1種類だけ:
 *   「自分の都合の休み」なのに、同じ日・同じ現場でほかの人が現場休み（0.6補）で休んでいる
 *   → 人数調整で会社が休ませた日なのに、本人が「自分の都合」で入れた（本人の減額）かもしれない。
 *   例: 2026-09-17 ビン（私用で入力・本人は「現場に仕事がなかった」）。同じ日に同じ現場で3人が0.6補
 *
 * 逆向き（0.6補なのに大勢が出勤）は見ない: IHI では毎日のように数人ずつ0.6補で休ませて人数調整しており、
 * 9月の実データで47件中46件がこの正常な人数調整だった（警告が多すぎて役に立たない）。
 *
 * カレンダーで休みの日の「休み」は給与に影響しないので対象外（isWorkDay）。
 * 警告だけで出面は変えない。出面の画面（職長承認の前）と月次集計に出す。Firestore を読まない純粋関数。
 */
import type { AttendanceEntry } from '@/types'

export type RestMismatchKind = 'rest_while_others_comp'

export interface RestMismatch {
  workerId: number
  day: number
  kind: RestMismatchKind
  /** 親現場（工種サイトをまとめた現場） */
  familyId: string
  /** 同じ現場・同じ日に出勤した人数（本人を除く） */
  worked: number
  /** 同じ現場・同じ日に現場休み（0.6補）の人数（本人を除く） */
  comp: number
}

type DayKind = 'work' | 'comp' | 'rest' | 'other'
function kindOf(e: AttendanceEntry): DayKind {
  if (e.p || e.hk || e.exam || e.h) return 'other'
  if (e.r) return 'rest'
  if (e.w === 0.6) return 'comp'
  if ((e.w || 0) > 0 || (e as { nonly?: number }).nonly) return 'work'
  return 'other'
}

/** d のキー `${siteId}_${workerId}_${ym}_${day}`（siteId に _ を含むことがあるので後ろから読む） */
function parseKey(key: string, ym: string): { sid: string; wid: number; day: number } | null {
  const m = key.match(/^(.+)_(\d+)_(\d{6})_(\d{1,2})$/)
  if (!m || m[3] !== ym) return null
  return { sid: m[1], wid: Number(m[2]), day: Number(m[4]) }
}

export function detectRestMismatches(
  d: Record<string, AttendanceEntry | null | undefined>,
  ym: string,
  familyOf: (siteId: string) => string,
  /** その現場（親）のその日がカレンダーで仕事の日か。省略時は日曜以外 */
  isWorkDay?: (familyId: string, day: number) => boolean,
): RestMismatch[] {
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(4, 6))
  const workDay = isWorkDay ?? ((_f: string, day: number) => new Date(y, mo - 1, day).getDay() !== 0)
  // 現場（親）×日 → 人 → その日の種類（同じ現場に2件あれば出勤を優先）
  const byFamDay = new Map<string, Map<number, DayKind>>()
  const rank: Record<DayKind, number> = { work: 0, comp: 1, rest: 2, other: 3 }
  for (const [key, e] of Object.entries(d)) {
    if (!e) continue
    const k = parseKey(key, ym)
    if (!k) continue
    const fk = `${familyOf(k.sid)}|${k.day}`
    if (!byFamDay.has(fk)) byFamDay.set(fk, new Map())
    const m = byFamDay.get(fk)!
    const kind = kindOf(e)
    const cur = m.get(k.wid)
    if (!cur || rank[kind] < rank[cur]) m.set(k.wid, kind)
  }
  const out: RestMismatch[] = []
  for (const [fk, people] of byFamDay) {
    const [familyId, dayStr] = fk.split('|')
    const day = Number(dayStr)
    let worked = 0, comp = 0
    for (const k of people.values()) { if (k === 'work') worked++; else if (k === 'comp') comp++ }
    if (comp === 0 || !workDay(familyId, day)) continue
    for (const [wid, k] of people) {
      if (k === 'rest') out.push({ workerId: wid, day, kind: 'rest_while_others_comp', familyId, worked, comp })
    }
  }
  return out.sort((a, b) => a.day - b.day || a.workerId - b.workerId)
}

/** 画面に出す説明（1件分） */
export function restMismatchMessage(m: Pick<RestMismatch, 'worked' | 'comp'>): string {
  return `自分の都合の休みですが、同じ日に同じ現場で${m.comp}人が現場休み（会社の都合・0.6補）です。`
    + `この人も人数調整で休んだのなら、現場休み（0.6補）に直してください。`
}
