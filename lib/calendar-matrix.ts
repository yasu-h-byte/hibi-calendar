/**
 * カレンダー署名のマトリックスデータ取得（2026-05-27 集約）
 *
 * 以下 3 つの API ルートで「siteCalendar + calendarSign + sites + homeLeaves +
 * main doc」を読み込んで「全現場 × 全外国人スタッフ × 署名済みフラグ」の
 * マトリックスを構築する処理が重複していた:
 *   - /api/calendar/status         (admin: 現場ごとの署名状況一覧)
 *   - /api/calendar/public-sites   (公開: 名前選択して署名する画面用)
 *   - /api/calendar/my-pending     (token認証: 本人のための一覧)
 *
 * 本モジュールが共通の読込み + 集計を担当。各ルートは結果を必要な形に
 * プロジェクション（変換）するだけ。
 */
import { db } from './firebase'
import { doc, getDoc, collection, query, where, getDocs } from '@/lib/fsdb'
import { getAllSitesWithWorkersForMonth } from './sites'
import { isSiteStartedByMonth } from './site-hierarchy'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm, type HomeLeaveEntry } from './homeLeave'
import { isCalendarSignTarget } from './workers'
import type { Site, SiteAssign, Worker } from '@/types'

export interface SiteCalendarInfo {
  days: Record<string, string> | null
  status: string
  submittedBy: number | null
  approvedBy: number | null
  rejectedReason: string | null
  /** 最終更新時刻（save-days 経由）。承認後に修正された場合の判定に使う */
  updatedAt: string | null
  /** 承認時刻。再署名要否判定の補助 */
  approvedAt: string | null
  /** 最終更新者の worker ID（save-days 経由） */
  updatedBy: number | null
}

export interface EligibleForeignWorker {
  id: number
  name: string
  nameVi: string
  token: string
  raw: Record<string, unknown>  // 必要に応じて他のフィールドにアクセス可
}

export interface CalendarMatrix {
  ym: string
  /** 当該月の全 siteCalendar ドキュメント（status を含む） */
  siteCalendars: Record<string, SiteCalendarInfo>
  /** 承認済み現場 ID 集合 */
  approvedSiteIds: Set<string>
  /** 署名済みかつ signedAt のマップ。キー: `${workerId}_${siteId}` */
  signaturesBySite: Record<string, string>
  /** 配置情報付きの現場リスト (ym 月在籍ベース) */
  sitesWithWorkers: { site: Site; workers: Worker[]; assign: SiteAssign }[]
  /** 帰国情報（全件） */
  homeLeaves: HomeLeaveEntry[]
  /** 当該月の全期間帰国中のスタッフ ID 集合 */
  fullMonthHlIds: Set<number>
  /** 「カレンダー署名対象」となる外国人スタッフ一覧（在籍×token×帰国でない） */
  eligibleForeignWorkers: EligibleForeignWorker[]
  /**
   * 当該月における現場ごとの配置済みスタッフ ID 集合
   * （massign[siteId_ym] を優先、なければ assign[siteId] のデフォルト）
   * 修正再署名の対象を「実際に配置されているスタッフ」に絞るために使用。
   */
  assignedWorkerIdsBySite: Record<string, Set<number>>
}

// ── loadCalendarMatrix の短時間キャッシュ（2026-07-02 Firestore読み取りコスト対策） ──
//   my-pending(スタッフ端末)/status/public-sites が calendarSign を毎回大量に読むため
//   読み取り回数の主要因。matrix は書き込みされない計算ビューなので ym 単位で短時間
//   キャッシュしても整合性は壊れない（返却時 structuredClone で呼び出し側の変更から保護）。
//   署名/承認の反映は最大 CAL_MATRIX_TTL 秒（20秒）遅れ得るが、書き込み自体は即時成功する
//   （署名は冪等なので二重でも安全）。即時反映が要る箇所は invalidateCalendarMatrixCache() を呼ぶ。
const _calMatrixCache = new Map<string, { data: CalendarMatrix; ts: number }>()
const CAL_MATRIX_TTL = 20_000 // 20秒

/** カレンダー署名/承認を変更したら呼ぶ（次の loadCalendarMatrix で再読込） */
export function invalidateCalendarMatrixCache(ym?: string): void {
  if (ym) _calMatrixCache.delete(ym)
  else _calMatrixCache.clear()
}

/**
 * カレンダー署名画面群（admin/public/my-pending）共通のデータ取得（20秒キャッシュ付き）
 * @param ym  "YYYY-MM" 形式（siteCalendar の ym フィールド）
 */
export async function loadCalendarMatrix(ym: string): Promise<CalendarMatrix> {
  const now = Date.now()
  const hit = _calMatrixCache.get(ym)
  if (hit && now - hit.ts < CAL_MATRIX_TTL) return structuredClone(hit.data)
  const data = await loadCalendarMatrixUncached(ym)
  _calMatrixCache.set(ym, { data, ts: now })
  return structuredClone(data)
}

/**
 * 実読込み本体（全 5 read を並列実行、合計 ~1 RTT 相当）。キャッシュは上の
 * loadCalendarMatrix が担当。
 */
async function loadCalendarMatrixUncached(ym: string): Promise<CalendarMatrix> {
  const [siteCalSnap, signSnap, allSitesWithWorkers, homeLeaves, mainDoc] = await Promise.all([
    getDocs(query(collection(db, 'siteCalendar'), where('ym', '==', ym))),
    getDocs(query(collection(db, 'calendarSign'), where('ym', '==', ym))),
    getAllSitesWithWorkersForMonth(ym),
    getAllActiveHomeLeaves(),
    getDoc(doc(db, 'demmen', 'main')),
  ])

  // siteCalendar
  const siteCalendars: Record<string, SiteCalendarInfo> = {}
  const approvedSiteIds = new Set<string>()
  siteCalSnap.forEach(d => {
    const data = d.data()
    const status = data.status || 'draft'
    siteCalendars[data.siteId] = {
      days: data.days || null,
      status,
      submittedBy: data.submittedBy || null,
      approvedBy: data.approvedBy || null,
      rejectedReason: data.rejectedReason || null,
      updatedAt: data.updatedAt || null,
      approvedAt: data.approvedAt || null,
      updatedBy: data.updatedBy ?? null,
    }
    if (status === 'approved') approvedSiteIds.add(data.siteId)
  })

  // その月にまだ始まっていない現場は外す（後から追加した現場が過去月に混ざらないように）。
  //   ただし、その月のカレンダーが既に作られている現場は工期の登録に関わらず残す
  //   （工期の開始日より前から入っていた・開始日の登録が遅れた、などで消さないため）
  const sitesWithWorkers = allSitesWithWorkers.filter(sw =>
    isSiteStartedByMonth(sw.site, ym) || !!siteCalendars[sw.site.id])

  // calendarSign
  const signaturesBySite: Record<string, string> = {}
  signSnap.forEach(d => {
    const data = d.data()
    signaturesBySite[`${data.workerId}_${data.siteId}`] = data.signedAt || 'true'
  })

  // 現場ごとの配置済みスタッフ ID 集合
  //   - massign[siteId_ym] が存在すればそれを優先（月別オーバーライド）
  //   - そうでなければ assign[siteId] (デフォルト)
  // 修正時の再署名フィルタに使用
  const mainData = mainDoc.exists() ? mainDoc.data() : {}
  const assignMap = (mainData.assign || {}) as Record<string, { workers?: number[] }>
  const massignMap = (mainData.massign || {}) as Record<string, { workers?: number[] }>
  const ymCompact = ym.replace('-', '')  // "YYYY-MM" → "YYYYMM"
  const assignedWorkerIdsBySite: Record<string, Set<number>> = {}
  const rawSitesForKids = (mainData.sites || []) as { id: string; parentId?: string; archived?: boolean }[]
  const assignedOf = (sid: string) => massignMap[`${sid}_${ymCompact}`]?.workers ?? assignMap[sid]?.workers ?? []
  for (const sw of sitesWithWorkers) {
    // 工種サイトに配置された人も親現場の署名対象に含める（2026-09-15）
    const kidIds = rawSitesForKids.filter(k => k.parentId === sw.site.id && !k.archived).map(k => k.id)
    assignedWorkerIdsBySite[sw.site.id] = new Set([...assignedOf(sw.site.id), ...kidIds.flatMap(assignedOf)])
  }

  // 全期間帰国 + 署名対象外国人
  const allRawWorkers = (mainData.workers || []) as Record<string, unknown>[]
  const ymKey = normalizeYm(ym)
  const fullMonthHlIds = new Set(
    allRawWorkers
      .map(w => w.id as number)
      .filter(id => isFullMonthHomeLeave(id, ymKey, homeLeaves))
  )
  const eligibleForeignWorkers: EligibleForeignWorker[] = allRawWorkers
    .filter(w => isCalendarSignTarget(
      {
        id: w.id as number,
        visa: w.visa as string,
        token: w.token as string,
        retired: w.retired as string | undefined,
        hireDate: w.hireDate as string | undefined,
      },
      ym,
      fullMonthHlIds,
    ))
    .map(w => ({
      id: w.id as number,
      name: w.name as string,
      nameVi: (w.nameVi as string) || '',
      token: (w.token as string) || '',
      raw: w,
    }))

  return {
    ym,
    siteCalendars,
    approvedSiteIds,
    signaturesBySite,
    sitesWithWorkers,
    homeLeaves,
    fullMonthHlIds,
    eligibleForeignWorkers,
    assignedWorkerIdsBySite,
  }
}

/**
 * 行列を「現場 × 署名対象スタッフ × 署名状態」に投影する（2026-09-26 共通化）。
 * /api/calendar/status（就業カレンダー画面）と通知ベルが同じものを使い、
 * 集計は lib/calendar-sign-status.ts summarizeSignStatus で行う（数字が必ず一致する）。
 */
export function projectSignSites(m: CalendarMatrix) {
  return m.sitesWithWorkers.map(sw => {
    const cal = m.siteCalendars[sw.site.id]
    // 「承認後に修正された」判定 — approvedAt 以降に updatedAt が動いた
    const wasRevised = !!(cal?.status === 'approved' && cal.approvedAt && cal.updatedAt && cal.updatedAt > cal.approvedAt)
    const assignedHere = m.assignedWorkerIdsBySite[sw.site.id]
    return {
      siteId: sw.site.id,
      siteName: sw.site.name,
      cal,
      status: cal?.status || null,
      wasRevised,
      // 全現場に対して同じ署名対象スタッフ（全員×全現場モデル）
      workers: m.eligibleForeignWorkers.map(w => {
        const sigVal = m.signaturesBySite[`${w.id}_${sw.site.id}`]
        const signed = !!sigVal
        const signedAt = sigVal && sigVal !== 'true' ? sigVal : null
        // 修正後に再確認したか: 署名時刻が updatedAt より後（= 修正後にサインした）
        const reconfirmedAfterRevision = !!(wasRevised && signed && signedAt && cal!.updatedAt && signedAt > cal!.updatedAt)
        return { id: w.id, name: w.name, signed, signedAt, assignedHere: assignedHere?.has(w.id) || false, reconfirmedAfterRevision }
      }),
    }
  })
}

