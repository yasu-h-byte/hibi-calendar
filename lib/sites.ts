import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { Site, SiteAssign, Worker } from '@/types'
import { isStillActiveForMonth, isHiredByMonth } from './workers'

interface MainDoc {
  sites?: Record<string, unknown>[]
  assign?: Record<string, Record<string, unknown>>
  workers?: Record<string, unknown>[]
}

async function getMainDoc(): Promise<MainDoc> {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return {}
  return docSnap.data() as MainDoc
}

export async function getSites(): Promise<Site[]> {
  const data = await getMainDoc()
  if (!data.sites) return []

  return (data.sites as Record<string, unknown>[])
    .map(s => ({
      id: s.id as string,
      name: s.name as string,
      start: (s.start as string) || '',
      end: (s.end as string) || '',
      foreman: (s.foreman as number) || 0,
      archived: (s.archived as boolean) || false,
    }))
    .filter(s => !s.archived)
}

export async function getSiteById(siteId: string): Promise<Site | null> {
  const sites = await getSites()
  return sites.find(s => s.id === siteId) || null
}

export async function getWorkersForSite(siteId: string): Promise<Worker[]> {
  const data = await getMainDoc()
  if (!data.assign || !data.workers) return []

  const siteAssign = data.assign[siteId]
  if (!siteAssign) return []

  const workerIds = new Set((siteAssign.workers as number[]) || [])
  return (data.workers as Record<string, unknown>[])
    .filter(w => workerIds.has(w.id as number))
    .map(w => ({
      id: w.id as number,
      name: w.name as string,
      nameVi: (w.nameVi as string) || '',
      company: (w.org as string) === 'hfu' ? 'HFU' : '日比',
      visaType: (w.visa as string) || '',
      token: (w.token as string) || '',
    }))
}

/**
 * 全現場の workers/assign を返す共通実装
 * （public エクスポートは getAllSitesWithWorkersForMonth と
 * getAllSitesWithActiveWorkers の 2 関数）
 */
async function buildSitesWithWorkers(
  workerFilter: (w: Record<string, unknown>) => boolean,
): Promise<{ site: Site; workers: Worker[]; assign: SiteAssign }[]> {
  const data = await getMainDoc()
  if (!data.sites || !data.assign || !data.workers) return []

  const allWorkers = (data.workers as Record<string, unknown>[])
    .filter(workerFilter)
    .map(w => ({
      id: w.id as number,
      name: w.name as string,
      nameVi: (w.nameVi as string) || '',
      company: (w.org as string) === 'hfu' ? 'HFU' : '日比',
      visaType: (w.visa as string) || '',
      token: (w.token as string) || '',
    }))

  const workerMap = new Map(allWorkers.map(w => [w.id, w]))

  return (data.sites as Record<string, unknown>[])
    .filter(s => !(s.archived as boolean))
    .map(s => {
      const siteId = s.id as string
      const siteAssign = data.assign![siteId]
      const workerIds = siteAssign ? (siteAssign.workers as number[]) || [] : []

      return {
        site: {
          id: siteId,
          name: s.name as string,
          start: (s.start as string) || '',
          end: (s.end as string) || '',
          foreman: (s.foreman as number) || 0,
          archived: false,
        },
        workers: workerIds.map(id => workerMap.get(id)).filter(Boolean) as Worker[],
        assign: {
          workers: workerIds,
          subcons: siteAssign ? (siteAssign.subcons as string[]) || [] : [],
        },
      }
    })
}

/**
 * 「指定月にまだ在籍中」のスタッフを含めて全現場の workers/assign を返す
 *
 * 退職月のスタッフ（例: 6/30 退職を 6月のカレンダーで表示）も対象に残る。
 * カレンダー署名・出面入力など「特定の月の作業」を扱う API で使用。
 *
 * @param ym 表示対象月 (YYYYMM or YYYY-MM)
 */
export async function getAllSitesWithWorkersForMonth(ym: string): Promise<
  { site: Site; workers: Worker[]; assign: SiteAssign }[]
> {
  return buildSitesWithWorkers(w => isStillActiveForMonth(w.retired as string | undefined, ym) && isHiredByMonth(w.hireDate as string | undefined, ym))
}

/**
 * 「現在在籍中」（退職フィールドなし）のスタッフを含めて全現場を返す
 *
 * 月をまたがない「現在の状態」を表示する用途。退職予定者は除外される
 * （その月にまだ働く予定でも除外される点に注意）。
 *
 * 上記の "ForMonth" 版を使うべきケースが多いので、新規利用前に
 * 本当にこの厳密フィルタが必要か確認すること。
 */
export async function getAllSitesWithActiveWorkers(): Promise<
  { site: Site; workers: Worker[]; assign: SiteAssign }[]
> {
  return buildSitesWithWorkers(w => !w.retired)
}

/**
 * @deprecated getAllSitesWithWorkersForMonth(ym) または getAllSitesWithActiveWorkers() を使うこと。
 * 旧 API の後方互換のために残置（既存コードを段階的に移行）。
 */
export async function getAllSitesWithWorkers(ym?: string): Promise<
  { site: Site; workers: Worker[]; assign: SiteAssign }[]
> {
  if (ym) return getAllSitesWithWorkersForMonth(ym)
  return getAllSitesWithActiveWorkers()
}
