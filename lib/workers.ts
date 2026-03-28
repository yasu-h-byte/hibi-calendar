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
    company: (w.org as string) === 'hfu' ? 'HFU' : '日比',
    visaType: (w.visa as string) || '',
    token: (w.token as string) || '',
    jobType: (w.job as string) || '',
    rate: (w.rate as number) || 0,
    hourlyRate: (w.hourlyRate as number) || undefined,
    otMul: (w.otMul as number) || 1.25,
    hireDate: (w.hireDate as string) || '',
    retired: (w.retired as string) || '',
    salary: (w.salary as number) || undefined,
    visaExpiry: (w.visaExpiry as string) || '',
  }))

  return workers
}

export async function getWorkerByToken(token: string): Promise<Worker | null> {
  const workers = await getWorkers()
  return workers.find(w => w.token === token) || null
}
