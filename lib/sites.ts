import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { Site, SiteAssign, Worker } from '@/types'
import { isStillActiveForMonth } from './workers'

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
 * 全現場の workers/assign を返す
 *
 * @param ym 表示対象月 (YYYYMM)。指定すると「その月にまだ在籍中」のスタッフだけ含める。
 *           退職月のスタッフ（例: 6/30 退職を 6月のカレンダーで表示）も対象に残せる。
 *           省略すると `!w.retired` 厳密フィルタ（退職予定者も除外）— 後方互換用。
 */
export async function getAllSitesWithWorkers(ym?: string): Promise<
  { site: Site; workers: Worker[]; assign: SiteAssign }[]
> {
  const data = await getMainDoc()
  if (!data.sites || !data.assign || !data.workers) return []

  const allWorkers = (data.workers as Record<string, unknown>[])
    // 2026-05-27: ym が渡された場合は「その月にまだ在籍中」基準で判定
    //   従来の `!w.retired` だと退職日が入った瞬間に当月のカレンダーから消えてしまう
    .filter(w => ym
      ? isStillActiveForMonth(w.retired as string | undefined, ym)
      : !w.retired
    )
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
