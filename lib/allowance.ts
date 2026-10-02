/**
 * 遠方現場日当・運転手当（2026-10-01 施行）
 *
 * 設計の決定履歴は docs/allowance.md（規程ドラフト）と memory を参照。
 * ここは**規則の唯一の置き場**。画面・給与計算・Excel はすべてここから導出する。
 *
 * ## 基準は距離ではなく所要時間
 * 現場ごとに「判定値」（朝5:30発と夕17:30発の実測平均の片道換算・分）を凍結し、
 * それだけから日当額が決まる。恣意的な現場指定は非課税（実費弁償）を崩すため、
 * **しきい値は施行後に動かさない**。
 *
 * ## 帰りは朝の1.5倍かかる（代表の実感）
 * だから朝だけでなく夕も測り、平均を判定値にする。
 */
import type { AttendanceEntry } from '@/types'
import { calendarSiteIdOf, parentAndWorkTypeSiteIds, type HierarchySite } from './site-hierarchy'

/**
 * 手当の適用開始月。**日当と運転手当で別のゲート**を持つ（2026-08-28 代表決定）。
 *
 * ⚠️ このゲートは**給与計算への組み込み側（loadMonthlyAllowances）で適用する**。
 *    calcMonthlyAllowances 自体は任意の月を計算できるようにしてある——
 *    施行前の実データ（2026-06〜08）でルールを検証・テストするため。
 */

/** 運転手当の適用開始月。2026年10月施行 */
export const DRIVE_ALLOWANCE_FROM_YM = '202610'

/**
 * 遠方現場日当の適用開始月。
 *
 * **2026-08-28 代表決定により制度を再検討中のため保留（null＝無効）**。
 * 再開するときはここに 'YYYYMM' を入れるだけでよい。null の間は、現場に判定値が
 * 凍結されていても日当は一切発生しない（住所登録の有無に依存しない確実な停止）。
 */
export const SITE_ALLOWANCE_FROM_YM: string | null = null

/** 日当のしきい値（判定値・分）。施行後に動かさないこと。 */
export const DAILY_ALLOWANCE_TIERS = [
  { overMin: 120, yen: 1500 },
  { overMin: 80, yen: 500 },
] as const

/**
 * 運転手当（片道あたり）。**全現場一律・定額**（2026-08-28 代表決定）。
 *
 * 行きも帰りも同額。所要時間・距離・現場を問わず一律なので、判定値（通勤時間の実測）に
 * 依存しない＝運転手当のために現場の住所を登録する必要はない。
 * 旧案（60分未満500円/60分以上1,000円の2区分）は廃止した。
 */
export const DRIVE_ALLOWANCE_YEN = 1000

export function driveAllowanceYen(): number {
  return DRIVE_ALLOWANCE_YEN
}

/** 長期従事: 起算日から満12ヶ月まで全額 → 満24ヶ月まで半額 → 以降0。 */
export const TENURE_FULL_MONTHS = 12
export const TENURE_HALF_MONTHS = 24
/** 同一現場の対象日がこの日数以上空いたら、次の対象日が新しい起算日。 */
export const TENURE_RESET_GAP_DAYS = 30

/** 判定値（分）→ 日当額。未測定（undefined）は 0 円（確定後に遡って支給する運用）。 */
export function dailyAllowanceYen(judgedMin: number | undefined | null): number {
  if (judgedMin == null) return 0
  for (const t of DAILY_ALLOWANCE_TIERS) {
    if (judgedMin > t.overMin) return t.yen
  }
  return 0
}

/**
 * 日当の対象日か（＝その日、実際にその現場へ行ったか）。
 *
 * - 有給・休み・帰国・試験は対象外
 * - **0.6補償（w=0.6）は現場都合の休み＝現場に行っていないので対象外**。
 *   実データ検証で、ここを見落とすと2026年8月だけで33,000円過大になることを確認済み
 * - 半日（0.5）は満額対象（移動の実費は同じ・2026-08-27 代表決定）
 * - 夜勤のみ（nonly, w=0）も対象（現場に行っている）
 */
export function isAllowanceEligibleDay(entry: AttendanceEntry | undefined | null): boolean {
  if (!entry) return false
  if (entry.p || entry.r || entry.h || entry.hk || entry.exam) return false
  const w = entry.w || 0
  if (w === 0.6) return false
  return w > 0 || !!entry.ns
}

/**
 * 長期従事による支給率。
 *
 * `eligibleDatesAsc` はその worker × site の対象日（ISO・昇順・施行日以降のみ）。
 * カウンタは保存せず、毎回ここで導出する。保存すると出面の事後修正とズレて
 * 不整合になるため（導出なら出面と必ず一致し、いつ計算しても同じ）。
 *
 * 施行時点で従事中の現場も、施行日以降の最初の対象日が起算日になる
 * （＝施行日起算の経過措置と同じ結果）。
 */
export function tenureRateOn(eligibleDatesAsc: string[], dateIso: string): 1 | 0.5 | 0 {
  let anchor: string | null = null
  let prev: string | null = null
  for (const d of eligibleDatesAsc) {
    if (d > dateIso) break
    if (anchor === null || (prev !== null && daysBetweenIso(prev, d) >= TENURE_RESET_GAP_DAYS)) {
      anchor = d
    }
    prev = d
  }
  if (anchor === null) return 1
  const months = fullMonthsBetween(anchor, dateIso)
  if (months < TENURE_FULL_MONTHS) return 1
  if (months < TENURE_HALF_MONTHS) return 0.5
  return 0
}

/** ISO日付2つの日数差（文字列演算ベース・TZ非依存）。 */
export function daysBetweenIso(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split('-').map(Number)
  const [by, bm, bd] = bIso.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** 満月数（ageOn と同じ規則: 日が足りなければ1ヶ月引く）。 */
export function fullMonthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  let m = (ty - fy) * 12 + (tm - fm)
  if (td < fd) m -= 1
  return m
}

/** 凍結に必要な最少サンプル日数（朝夕そろった日）。規程の「最初の10営業日」に対応。 */
export const COMMUTE_SAMPLE_TARGET = 10

/**
 * 運転者の選択肢に出すか。canDrive が未設定なら「日本人=可／外国人=不可」。
 * ベトナム人スタッフに運転させることはない（2026-08-27 代表）ため、既定で除外する。
 */
export function canDriveDefault(w: { canDrive?: boolean; visaType?: string; visa?: string }): boolean {
  if (typeof w.canDrive === 'boolean') return w.canDrive
  const visa = w.visaType ?? w.visa ?? ''
  return !visa || visa === 'none'
}

export interface CommuteSampleLike { am?: number; pm?: number }

/**
 * サンプル → 判定値（分）。
 * 朝の平均と夕の平均をそれぞれ出し、その平均を四捨五入する（片道換算）。
 * 朝夕どちらかが欠けた日はその側の平均に含めない。
 */
export function judgeFromSamples(samples: CommuteSampleLike[]): {
  amAvg: number | null; pmAvg: number | null; judged: number | null; completeDays: number
} {
  const ams = samples.map(s => s.am).filter((v): v is number => typeof v === 'number' && v > 0)
  const pms = samples.map(s => s.pm).filter((v): v is number => typeof v === 'number' && v > 0)
  const amAvg = ams.length ? ams.reduce((a, b) => a + b, 0) / ams.length : null
  const pmAvg = pms.length ? pms.reduce((a, b) => a + b, 0) / pms.length : null
  const judged = amAvg !== null && pmAvg !== null ? Math.round((amAvg + pmAvg) / 2) : null
  const completeDays = samples.filter(s => (s.am ?? 0) > 0 && (s.pm ?? 0) > 0).length
  return { amAvg, pmAvg, judged, completeDays }
}

export interface SiteCommute {
  /** 凍結済みの判定値（片道換算・分）。未測定なら undefined */
  judgedMin?: number
}

export interface WorkerAllowanceMonthly {
  workerId: number
  /** 遠方現場日当（非課税）。長期従事の逓減適用後 */
  siteAllowanceYen: number
  /** 日当の対象日数（逓減前のべ日数） */
  allowanceDays: number
  /** 運転手当（課税・割増基礎算入は社労士レビュー後に実装） */
  driveAllowanceYen: number
  /** 運転した便数（行き・帰り合計） */
  driveLegs: number
  /** 明細: 現場ごとの内訳（yen=日当、driveYen=運転手当。現場別原価への配賦に使う） */
  bySite: Record<string, { days: number; yen: number; driveYen?: number }>
}

/**
 * 月次の手当計算。
 *
 * @param attD      その月の出面（d マップそのまま）
 * @param ym        'YYYYMM'
 * @param commutes  siteId → 判定値
 * @param drv       運転記録: `${siteId}_${ym}_${day}` → { am: workerId[], pm: workerId[] }
 * @param excludeWorkerIds 日当の対象外（役員。2026-08-27 代表決定）
 * @param eligibleHistory  長期従事の導出用: `${workerId}_${siteId}` → 施行日以降の対象日（昇順・当月分含む）。
 *                         未指定なら逓減なし（全額）で計算する
 */
export function calcMonthlyAllowances(
  attD: Record<string, AttendanceEntry>,
  ym: string,
  commutes: Record<string, SiteCommute>,
  drv: Record<string, { am?: number[]; pm?: number[] }> = {},
  excludeWorkerIds: number[] = [],
  eligibleHistory?: Record<string, string[]>,
  /** 運転手当を出さない現場（現場マスタの noDriveAllowance・2026-09-30） */
  noDriveSiteIds?: Set<string>,
  /** 現場マスタ（工種サイトのキーを親へまとめる・働いた現場を親＋工種で探す。2026-10-02） */
  sites?: HierarchySite[],
): Map<number, WorkerAllowanceMonthly> {
  const out = new Map<number, WorkerAllowanceMonthly>()
  const excluded = new Set(excludeWorkerIds)
  const get = (id: number): WorkerAllowanceMonthly => {
    let v = out.get(id)
    if (!v) { v = { workerId: id, siteAllowanceYen: 0, allowanceDays: 0, driveAllowanceYen: 0, driveLegs: 0, bySite: {} }; out.set(id, v) }
    return v
  }

  // 暦日×人 で対象現場を集め、同日複数の遠方現場は高い方1回（実データ3ヶ月で発生0件だが防御）
  const byWorkerDay = new Map<string, { sites: Map<string, number> }>()
  for (const [key, entry] of Object.entries(attD)) {
    const p = key.split('_')
    const day = p[p.length - 1]
    const keyYm = p[p.length - 2]
    const wid = Number(p[p.length - 3])
    const sid = p.slice(0, p.length - 3).join('_')
    // 2026-08-27 追加（給与総点検）: キーの ym を検証。att ドキュメントに他月キーの
    //   残骸が混入した事故歴があり（cleanup-attendance-residue.mjs 参照）、
    //   computeMonthly は ym 不一致を弾くのに日当だけ支給される非対称があった
    if (keyYm !== ym) continue
    if (excluded.has(wid)) continue
    if (!isAllowanceEligibleDay(entry)) continue
    const yen = dailyAllowanceYen(commutes[sid]?.judgedMin)
    if (yen <= 0) continue
    const k = `${wid}:${day}`
    let rec = byWorkerDay.get(k)
    if (!rec) { rec = { sites: new Map() }; byWorkerDay.set(k, rec) }
    rec.sites.set(sid, yen)
  }

  for (const [k, rec] of byWorkerDay) {
    const [widStr, day] = k.split(':')
    const wid = Number(widStr)
    // 高い方の現場1つを採用
    let bestSid = ''; let bestYen = 0
    for (const [sid, yen] of rec.sites) if (yen > bestYen) { bestYen = yen; bestSid = sid }
    const dateIso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
    const rate = eligibleHistory
      ? tenureRateOn(eligibleHistory[`${wid}_${bestSid}`] || [], dateIso)
      : 1
    const v = get(wid)
    v.allowanceDays += 1
    v.siteAllowanceYen += Math.round(bestYen * rate)
    const bs = v.bySite[bestSid] || { days: 0, yen: 0 }
    bs.days += 1; bs.yen += Math.round(bestYen * rate)
    v.bySite[bestSid] = bs
  }

  // 運転手当（役員も運転すれば対象。日当と違い労働の対価なので除外しない）
  //  2026-10-02 点検:
  //  - 工種サイトのキーは親（カレンダーの現場）へまとめ、同じ便の同じ人を二重に払わない
  //  - その日その現場（親＋工種）で働いていない人は払わない（下流の防御。保存側 saveSiteDrivers でも拒否する）
  //  - 現場別原価の配賦先は、その人が実際に出面を入れた現場（工種サイトならその工種）
  const yenPerLeg = driveAllowanceYen()
  const merged = normalizeDrvKeys(drv, ym, sites || [], noDriveSiteIds)
  for (const [key, legs] of Object.entries(merged)) {
    const sid = key.slice(0, key.indexOf(`_${ym}_`))
    const day = key.slice(key.indexOf(`_${ym}_`) + ym.length + 2)
    if (noDriveSiteIds?.has(sid)) continue
    const family = sites ? driveFamilyIds(sites, sid) : [sid]
    for (const leg of ['am', 'pm'] as const) {
      for (const wid of legs[leg]) {
        const workedSid = family.find(f => isAllowanceEligibleDay(attD[`${f}_${wid}_${ym}_${day}`]))
        if (!workedSid) continue
        const v = get(wid)
        v.driveLegs += 1
        v.driveAllowanceYen += yenPerLeg
        const bs = v.bySite[workedSid] || { days: 0, yen: 0 }
        bs.driveYen = (bs.driveYen || 0) + yenPerLeg
        v.bySite[workedSid] = bs
      }
    }
  }

  return out
}

// ────────────────────────────────────────
//  運転記録（drv）の決まり（2026-10-02 点検）
//  保存（lib/drivers.ts saveSiteDrivers）・読み出し（出面画面・職長スマホ）・計算（calcMonthlyAllowances）で共通に使う
// ────────────────────────────────────────

export type DrvLegs = { am?: number[]; pm?: number[] }
export type DrvMap = Record<string, DrvLegs>

/**
 * 運転記録をまとめる現場（親＋工種）の id 一覧。先頭が親（＝drv のキーに使う現場）。
 * 工種サイトを渡しても親の一族を返す。
 */
export function driveFamilyIds(sites: HierarchySite[], siteId: string): string[] {
  return parentAndWorkTypeSiteIds(sites, calendarSiteIdOf(sites, siteId))
}

/** drv のキー。工種サイトでも親（カレンダーの現場）の id で持つ */
export function drvKeyOf(sites: HierarchySite[], siteId: string, ym: string, day: number): string {
  return `${calendarSiteIdOf(sites, siteId)}_${ym}_${day}`
}

const uniqIds = (a: number[] = [], b: number[] = []): number[] =>
  [...new Set([...a, ...b].map(Number).filter(Number.isFinite))]

/**
 * 当月の drv を親のキーへまとめる（工種サイトのキーで保存された古い記録も拾い、同じ人は1回に）。
 * 他月のキーは捨てる。skipSiteIds（運転手当なしの現場）に入るキーは、まとめる前に捨てる。
 */
export function normalizeDrvKeys(
  drv: DrvMap, ym: string, sites: HierarchySite[], skipSiteIds?: Set<string>,
): Record<string, { am: number[]; pm: number[] }> {
  const out: Record<string, { am: number[]; pm: number[] }> = {}
  for (const [key, legs] of Object.entries(drv || {})) {
    const i = key.indexOf(`_${ym}_`)
    if (i <= 0) continue
    const sid = key.slice(0, i)
    const day = Number(key.slice(i + ym.length + 2))
    if (!Number.isInteger(day) || day < 1 || day > 31) continue
    if (skipSiteIds?.has(sid)) continue
    const k = drvKeyOf(sites, sid, ym, day)
    const cur = out[k] || { am: [], pm: [] }
    out[k] = { am: uniqIds(cur.am, legs?.am), pm: uniqIds(cur.pm, legs?.pm) }
  }
  return out
}

/** 現場（親でも工種でも）の、その月の運転記録を日ごとに（親＋工種のキーをまとめて）返す */
export function driversByDayForSite(
  drv: DrvMap | undefined, sites: HierarchySite[], siteId: string, ym: string,
): Record<number, { am: number[]; pm: number[] }> {
  const root = calendarSiteIdOf(sites, siteId)
  const family = new Set(driveFamilyIds(sites, siteId))
  const familyDrv: DrvMap = {}
  for (const [k, v] of Object.entries(drv || {})) {
    const i = k.indexOf(`_${ym}_`)
    if (i > 0 && family.has(k.slice(0, i))) familyDrv[k] = v
  }
  const merged = normalizeDrvKeys(familyDrv, ym, sites)
  const out: Record<number, { am: number[]; pm: number[] }> = {}
  const prefix = `${root}_${ym}_`
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith(prefix)) out[Number(k.slice(prefix.length))] = v
  }
  return out
}

/** 'YYYYMM' の月が正しいか（月は 01〜12）。年は 2000〜2099 に限る */
export function isValidYm(ym: string): boolean {
  if (!/^\d{6}$/.test(ym)) return false
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6))
  return y >= 2000 && y <= 2099 && m >= 1 && m <= 12
}

/**
 * 運転記録を保存できる日か。エラーなら日本語のメッセージ、問題なければ null。
 * - 月は 01〜12、日はその月の範囲
 * - 誰かを記録するとき（hasDrivers）は、今日（日本時間）より先の日は不可（消す操作は通す）
 */
export function validateDriverDate(ym: string, day: unknown, todayIso: string, hasDrivers: boolean): string | null {
  if (!isValidYm(ym)) return '月が正しくありません'
  const d = Number(day)
  const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 0).getDate()
  if (!Number.isInteger(d) || d < 1 || d > dim) return '日付が正しくありません'
  if (hasDrivers) {
    const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
    if (iso > todayIso) return 'まだ来ていない日の運転者は記録できません'
  }
  return null
}

/**
 * その日その現場（親＋工種）で働いていない人（＝運転手当の対象にならない人）の id。
 * 働いた＝出勤（w>0・0.6補償を除く）または夜勤。有給・休み・帰国・試験は対象外（isAllowanceEligibleDay と同じ）。
 */
export function nonWorkingDriverIds(
  attD: Record<string, AttendanceEntry>, family: string[], ym: string, day: number, ids: number[],
): number[] {
  return ids.filter(wid => !family.some(f => isAllowanceEligibleDay(attD[`${f}_${wid}_${ym}_${day}`])))
}
