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
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkersForMonth } from './sites'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm, type HomeLeaveEntry } from './homeLeave'
import { isCalendarSignTarget } from './workers'
import type { Site, SiteAssign, Worker } from '@/types'

export interface SiteCalendarInfo {
  days: Record<string, string> | null
  status: string
  submittedBy: number | null
  approvedBy: number | null
  rejectedReason: string | null
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
}

/**
 * カレンダー署名画面群（admin/public/my-pending）共通のデータ取得
 *
 * @param ym  "YYYY-MM" 形式（siteCalendar の ym フィールド）
 *
 * 全 5 つの独立 read を並列実行（合計 ~1 RTT 相当）
 */
export async function loadCalendarMatrix(ym: string): Promise<CalendarMatrix> {
  const [siteCalSnap, signSnap, sitesWithWorkers, homeLeaves, mainDoc] = await Promise.all([
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
    }
    if (status === 'approved') approvedSiteIds.add(data.siteId)
  })

  // calendarSign
  const signaturesBySite: Record<string, string> = {}
  signSnap.forEach(d => {
    const data = d.data()
    signaturesBySite[`${data.workerId}_${data.siteId}`] = data.signedAt || 'true'
  })

  // 全期間帰国 + 署名対象外国人
  const allRawWorkers = mainDoc.exists() ? ((mainDoc.data().workers || []) as Record<string, unknown>[]) : []
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
  }
}
