/**
 * 人員マスタ・出面・手当の材料を Firestore から読む（**サーバー専用**・2026-10-21 総点検で lib/compute.ts から移した）
 *
 * lib/compute.ts は純粋な計算（給与・集計・キー解析）と型だけになり、画面（'use client'）から安全に import できる。
 * 以前は compute.ts が Firestore を読む関数も持っていたため、請求書の画面などが compute.ts を import するだけで
 * Firebase Web SDK（圧縮後 約100KB）がクライアント JS に載っていた（__tests__/clientBundleIsolation.test.ts が再発を落とす）。
 *
 * - getMainData: demmen/main を 30 秒キャッシュ（書き込みは lib/fsdb.ts の registerMainWriteHook で自動無効化）
 * - getAttData / getAttDataCached: 出面 att_YYYYMM（キャッシュ版は「前月より前の確定済み月」にだけ使う・isClosedMonthYm）
 * - loadMonthlyAllowances: 遠方現場日当・運転手当の材料集め（規則は lib/allowance.ts）
 */
import 'server-only'
import { db } from './firebase'
import { doc, getDoc, registerMainWriteHook } from '@/lib/fsdb'
import type { AttendanceEntry } from '@/types'
import { normalizeBilling, parseDKey, type MainData, type RawWorker, type RawSite, type RawSubcon, type PLRecord, type CompanyProfile, type HfuInvoiceSettings } from './compute'
import { withWorkTypeSiteCalendars } from './site-hierarchy'
import {
  DRIVE_ALLOWANCE_FROM_YM, SITE_ALLOWANCE_FROM_YM, calcMonthlyAllowances, dailyAllowanceYen, isAllowanceEligibleDay,
  type SiteCommute, type WorkerAllowanceMonthly,
} from './allowance'

// ── getMainData の短時間キャッシュ（2026-07-02 Firestore読み取りコスト対策） ──
//   全APIが毎リクエストで demmen/main を読むため、これが読み取り回数の主要因だった
//   （無料枠 5万reads/日 超過→ RESOURCE_EXHAUSTED 障害の一因）。master data は頻繁に
//   変わらないので短時間キャッシュで読み取りを集約する。
//   【安全性】書き込みは各エンドポイントが独自に getDoc→updateDoc(対象フィールド) するため
//     getMainData はほぼ読み取り専用＝本キャッシュは書き込み整合性に影響しない。
//     返却時に structuredClone して呼び出し側のミューテーションからキャッシュを保護する。
//     master data 編集(worker-crud 等)は invalidateMainCache() で即時反映。
//     どうしても最新が要る箇所は getMainData({ fresh: true })。
let _mainCache: { data: MainData; ts: number } | null = null

const MAIN_CACHE_TTL = 30_000 // 30秒

/** master data を変更したら呼ぶ（次の getMainData で必ず再読込） */
export function invalidateMainCache(): void {
  _mainCache = null
}

// demmen/main への全書き込み（fsdb 経由）で自動的にキャッシュ無効化する（2026-07-09）。
//   これにより各ルートで invalidateMainCache を呼び忘れても、保存直後の getMainData が
//   古い値を返さない（原価の請求額入力が巻き戻る等の read-after-write 不整合を根治）。
registerMainWriteHook(invalidateMainCache)

async function loadMainData(): Promise<MainData> {
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
    // 工種サイトは親現場の稼働日数を使う（2026-09-15・lib/site-hierarchy.ts）
    siteWorkDays: Object.fromEntries(Object.entries((d.siteWorkDays || {}) as Record<string, Record<string, number>>)
      .map(([ym, m]) => [ym, withWorkTypeSiteCalendars((d.sites || []) as RawSite[], m)])),
    locks: (d.locks || {}) as Record<string, boolean>,
    plData: (d.plData || {}) as Record<string, PLRecord[]>,
    defaultRates: (d.defaultRates || {}) as { tobiRate?: number; dokoRate?: number },
    mforeman: (d.mforeman || {}) as Record<string, { foreman?: number; wid?: number; note?: string }>,
    nightDays: (d.nightDays || {}) as Record<string, number[]>,
    companyProfile: (d.companyProfile || null) as CompanyProfile | null,
    hfuInvoice: (d.hfuInvoice || null) as HfuInvoiceSettings | null,
    announcements: (d.announcements || []) as import('./release-notes').Announcement[],
  }
}

export async function getMainData(opts?: { fresh?: boolean }): Promise<MainData> {
  const now = Date.now()
  if (!opts?.fresh && _mainCache && now - _mainCache.ts < MAIN_CACHE_TTL) {
    return structuredClone(_mainCache.data)
  }
  const data = await loadMainData()
  _mainCache = { data, ts: now }
  return structuredClone(data)
}

export async function getAttData(ym: string): Promise<{
  d: Record<string, AttendanceEntry>
  sd: Record<string, { n: number; on: number }>
  approvals?: Record<string, boolean>
  /** 運転記録 `${siteId}_${ym}_${day}` → {am,pm}（運転手当の元データ） */
  drv?: Record<string, { am?: number[]; pm?: number[] }>
}> {
  const docSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
  if (!docSnap.exists()) return { d: {}, sd: {} }
  const data = docSnap.data()
  return {
    d: (data.d || {}) as Record<string, AttendanceEntry>,
    sd: (data.sd || {}) as Record<string, { n: number; on: number }>,
    approvals: (data.approvals || undefined) as Record<string, boolean> | undefined,
    drv: (data.drv || undefined) as Record<string, { am?: number[]; pm?: number[] }> | undefined,
  }
}

/**
 * 出面ドキュメントの短期キャッシュ版（2026-09-02 追加・ダッシュボード高速化）。
 *
 * att_YYYYMM は1件 200〜300KB あり、ダッシュボード・通知ベル・サイドバーが同時に
 * 数十回読むのが遅さの主因だった。**呼び出し側は「前月より前の確定済み月」にだけ使うこと**
 * （当月・前月は入力中で、出面グリッドの再取得が古い値を返すと入力が消えて見える）。
 * 同一インスタンス内の setAttendanceEntry で無効化するが、別インスタンスの書き込みは
 * TTL まで反映されない。確定済み月の集計表示にはその遅延で十分。
 * 2026-10-21 総点検: 5 分 → 30 分。通知ベル（10 分ごと）・ダッシュボード・サイドバーが同じ確定月を
 * 何度も読み直していた。確定月（前月より前）の訂正は稀で、訂正した本人の画面は同一インスタンスで即反映される。
 */
const ATT_CACHE_TTL_MS = 30 * 60_000

const attDocCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof getAttData>> }>()

export async function getAttDataCached(ym: string): Promise<Awaited<ReturnType<typeof getAttData>>> {
  const hit = attDocCache.get(ym)
  if (hit && Date.now() - hit.at < ATT_CACHE_TTL_MS) return hit.data
  const data = await getAttData(ym)
  attDocCache.set(ym, { at: Date.now(), data })
  return data
}

export function invalidateAttDataCache(ym?: string): void {
  if (ym) attDocCache.delete(ym)
  else attDocCache.clear()
}

/** 複数月の出面データを読み込み・結合 */
export async function getMultiMonthAttData(ymList: string[]): Promise<{
  d: Record<string, AttendanceEntry>
  sd: Record<string, { n: number; on: number }>
  perMonth: Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }>; drv?: Record<string, { am?: number[]; pm?: number[] }> }>
}> {
  const merged = { d: {} as Record<string, AttendanceEntry>, sd: {} as Record<string, { n: number; on: number }> }
  const perMonth = new Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }>; drv?: Record<string, { am?: number[]; pm?: number[] }> }>()
  const results = await Promise.all(ymList.map(ym => getAttData(ym)))
  for (let i = 0; i < ymList.length; i++) {
    const att = results[i]
    Object.assign(merged.d, att.d)
    Object.assign(merged.sd, att.sd)
    perMonth.set(ymList[i], { d: att.d, sd: att.sd, drv: att.drv })
  }
  return { ...merged, perMonth }
}

// ────────────────────────────────────────
//  遠方現場日当・運転手当（2026-10-01 施行）のデータ読み込み（2026-08 追加）
//  規則そのものは lib/allowance.ts。ここは Firestore からの材料集めと
//  computeMonthly へ渡す形への組み立てだけを行う。
// ────────────────────────────────────────

/** 'YYYYMM' を n ヶ月進める */
function addYm(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6)) - 1 + n
  const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12 + 1
  return `${yy}${String(mm).padStart(2, '0')}`
}

/**
 * 長期従事の起算日導出に読む履歴月数の上限。
 *
 * 逓減は満24ヶ月で0円になるため、27ヶ月より前の履歴は結果を変えない:
 * - 27ヶ月窓の最古の対象日が24ヶ月以上前 → どのみち率0（真の起算日がさらに古くても同じ）
 * - 窓内の最古が24ヶ月未満 → 30日以上の空白（リセット）が窓内で検出できている
 * よって読み取りをここで打ち切っても計算結果は不変（クォータ対策）。
 */
const TENURE_HISTORY_MONTHS = 27

/**
 * 手当（遠方現場日当・運転手当）の月次計算に必要な材料を読み込んで計算する。
 *
 * - **施行前の月（ALLOWANCE_FROM_YM 未満）は undefined を返す** — 給与計算のゲートはここ。
 *   過去月の給与・原価はゴールデンマスターどおり1円も変わらない
 * - 判定値は現場マスタの凍結値（site.commute.judgedMin）。未凍結の遠方現場は日当0円のまま
 *   になるので、凍結後にその月を開き直せば自動で反映される（月次は毎回導出）
 * - 日当の対象外（役員）は job==='yakuin' から導出
 * - 長期従事の起算日は施行月〜前月の出面から毎回導出（カウンタ非保存。出面の事後修正と
 *   常に一致させるため）
 *
 * @param attD 対象月の出面（呼び出し元が既に読んでいる att.d を渡す＝当月の再読なし）
 * @param drv  対象月の運転記録（att.drv）
 */
export async function loadMonthlyAllowances(
  main: MainData,
  ym: string,
  attD: Record<string, AttendanceEntry>,
  drv: Record<string, { am?: number[]; pm?: number[] }> | undefined,
  // 呼び出し元が既に読んである月の出面（ダッシュボード等の複数月一括処理でクォータを増やさない）
  opts?: { preloadedAttD?: Record<string, Record<string, AttendanceEntry>> },
): Promise<Map<number, WorkerAllowanceMonthly> | undefined> {
  // 日当と運転手当は別ゲート（2026-08-28 代表決定: 日当は保留、運転手当は10月施行）
  const siteOn = SITE_ALLOWANCE_FROM_YM !== null && ym >= SITE_ALLOWANCE_FROM_YM
  const driveOn = ym >= DRIVE_ALLOWANCE_FROM_YM
  if (!siteOn && !driveOn) return undefined

  // 日当が無効の間は判定値を渡さない → dailyAllowanceYen が 0 を返し日当は発生しない。
  //   現場に住所や凍結済み判定値があっても確実に止まる（運用ではなくコードで保証）
  const commutes: Record<string, SiteCommute> = {}
  if (siteOn) {
    for (const s of main.sites) {
      const j = s.commute?.judgedMin
      if (typeof j === 'number') commutes[s.id] = { judgedMin: j }
    }
  }
  const excludeIds = main.workers.filter(w => w.job === 'yakuin').map(w => w.id)

  // 長期従事の履歴は日当専用。日当が無効なら過去月の出面を一切読まない（クォータ節約）
  const histStart = !siteOn ? ym
    : (addYm(ym, -TENURE_HISTORY_MONTHS) > SITE_ALLOWANCE_FROM_YM!
        ? addYm(ym, -TENURE_HISTORY_MONTHS) : SITE_ALLOWANCE_FROM_YM!)
  const histMonths: string[] = []
  for (let m = histStart; m < ym; m = addYm(m, 1)) histMonths.push(m)
  const histAtts = histMonths.length
    ? await Promise.all(histMonths.map(m =>
        opts?.preloadedAttD?.[m] !== undefined
          ? Promise.resolve(opts.preloadedAttD[m])
          : getAttData(m).then(a => a.d)))
    : []

  // `${wid}_${sid}` → 対象日（ISO・昇順）。当月分も含める（当月内の逓減切替に対応）
  const eligibleHistory: Record<string, string[]> = {}
  const push = (d: Record<string, AttendanceEntry>) => {
    for (const [key, entry] of Object.entries(d)) {
      const pk = parseDKey(key)
      if (dailyAllowanceYen(commutes[pk.sid]?.judgedMin) <= 0) continue
      if (!isAllowanceEligibleDay(entry)) continue
      const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
      const k = `${pk.wid}_${pk.sid}`
      ;(eligibleHistory[k] = eligibleHistory[k] || []).push(iso)
    }
  }
  for (const d of histAtts) push(d)
  push(attD)
  for (const k of Object.keys(eligibleHistory)) eligibleHistory[k].sort()

  // 運転手当を出さない現場（工種サイトは親の指定に従う）。記録が残っていても手当にしない（下流の防御）
  const noDriveSiteIds = new Set(main.sites.filter(s => s.noDriveAllowance).map(s => s.id))
  for (const s of main.sites) if (s.parentId && noDriveSiteIds.has(s.parentId)) noDriveSiteIds.add(s.id)
  return calcMonthlyAllowances(attD, ym, commutes, drv || {}, excludeIds, eligibleHistory, noDriveSiteIds, main.sites)
}
