/**
 * 旧契約（固定月給・useOldRules の外国人。フン・フォン・タン・ホアン）の「所定の日」の決まり（2026-10-23）。
 *
 * 旧契約の所定日数は全社の所定日数（日曜以外の日を数えた値・月次集計の「所定日数(旧ルール用)」）で、
 * 現場カレンダーの休みとは関係が無い。そのため現場が休みの日（祝日・現場の都合）も所定の日で、
 * 記録が空欄だと欠勤（日給100%控除）になる。本来は会社都合の休み＝0.6補（60%補償）。
 *
 * 2026-10-23 タン(208)の 9/21・9/22（笹塚のカレンダーが休み）で起きた:
 *   - 出面の入力は「0.6補はカレンダーの仕事の日だけ」の決まり（2026-10-02）で、休みの日に 0.6補 を入れられなかった
 *   - 月次集計の「稼働日未入力」は現場カレンダーの仕事の日しか数えず、空欄に気づけなかった
 * → 0.6補を入れられる日と、空欄の警告の両方を、旧契約の人はこの決まり（日曜以外）で判定する。
 *
 * 純粋な関数だけ（画面からも import できる）。
 */
import type { AttendanceEntry } from '@/types'

/** 人員マスタの生データ（visa）と mapRawWorkers 後（visaType）のどちらでも判定できる */
export function isOldContractWorker(w: { visa?: string; visaType?: string; useOldRules?: boolean } | undefined | null): boolean {
  const visa = w?.visa ?? w?.visaType
  return !!w && !!visa && visa !== 'none' && w.useOldRules === true
}

/** 旧契約の所定の日か（日曜以外）。'YYYY-MM-DD' */
export function isOldContractPrescribedDay(dateIso: string): boolean {
  const [y, m, d] = dateIso.split('-').map(Number)
  if (!y || !m || !d) return false
  return new Date(y, m - 1, d).getDay() !== 0
}

/**
 * 旧契約の人の、所定の日（日曜以外）なのに欠勤扱いになる日。
 *   - blank: 何も記録が無い日
 *   - siteOff: 「現場休み」（h）だけの日（旧契約の計算では欠勤と同じ 100%控除）
 * 数えるのは昨日まで・在籍している日だけ（今日は入力の途中）。
 */
export function oldContractUnpaidDays(args: {
  attD: Record<string, AttendanceEntry>
  workerId: number
  ym: string            // 'YYYYMM'
  hireDate?: string
  retired?: string
  todayIso: string
}): { blank: number[]; siteOff: number[] } {
  const { attD, workerId, ym, hireDate, retired, todayIso } = args
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const dim = new Date(y, m, 0).getDate()
  const suffix = `_${workerId}_${ym}_`
  const counted = new Set<number>()   // 欠勤にならない記録がある日
  const offOnly = new Set<number>()
  for (const [key, e] of Object.entries(attD)) {
    if (!e) continue
    const i = key.indexOf(suffix)
    if (i < 0) continue
    const day = Number(key.slice(i + suffix.length))
    if (!Number.isFinite(day)) continue
    if (e.h && !(e.w && e.w > 0) && !e.p && !e.hk && !e.r && !e.exam) offOnly.add(day)
    else counted.add(day)
  }
  const blank: number[] = [], siteOff: number[] = []
  for (let d = 1; d <= dim; d++) {
    const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
    if (iso >= todayIso) break
    if (hireDate && iso < hireDate) continue
    if (retired && iso > retired) continue
    if (!isOldContractPrescribedDay(iso)) continue
    if (counted.has(d)) continue
    if (offOnly.has(d)) siteOff.push(d)
    else blank.push(d)
  }
  return { blank, siteOff }
}
