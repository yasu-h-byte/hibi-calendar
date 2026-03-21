import { db } from './firebase'
import { doc, getDoc } from 'firebase/firestore'
import { Worker } from '@/types'

export async function getWorkers(): Promise<Worker[]> {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)

  if (!docSnap.exists()) {
    return []
  }

  const data = docSnap.data()
  const workers: Worker[] = (data.workers || []).map((w: Record<string, unknown>) => ({
    id: w.id as number,
    name: w.name as string,
    nameVi: (w.nameVi as string) || '',
    company: (w.company as string) || '日比',
    visaType: (w.visaType as string) || '',
    token: w.token as string,
  }))

  return workers
}

export async function getWorkerByToken(token: string): Promise<Worker | null> {
  const workers = await getWorkers()
  return workers.find(w => w.token === token) || null
}
