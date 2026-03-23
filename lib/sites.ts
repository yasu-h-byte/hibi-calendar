import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { Site, SiteAssign, Worker } from '@/types'

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

export async function getSiteAssignments(): Promise<Record<string, SiteAssign>> {
  const data = await getMainDoc()
  if (!data.assign) return {}

  const result: Record<string, SiteAssign> = {}
  for (const [siteId, val] of Object.entries(data.assign)) {
    result[siteId] = {
      workers: (val.workers as number[]) || [],
      subcons: (val.subcons as string[]) || [],
    }
  }
  return result
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

export async function getAllSitesWithWorkers(): Promise<
  { site: Site; workers: Worker[]; assign: SiteAssign }[]
> {
  const data = await getMainDoc()
  if (!data.sites || !data.assign || !data.workers) return []

  const allWorkers = (data.workers as Record<string, unknown>[]).map(w => ({
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
