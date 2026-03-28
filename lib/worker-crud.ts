import { db } from './firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'

export interface WorkerData {
  id: number
  name: string
  org: string      // 'hibi' | 'hfu'
  visa: string     // 'none' | 'jisshu1' | 'jisshu2' | 'jisshu3' | 'tokutei1' | 'tokutei2'
  job: string      // 'yakuin' | 'shokucho' | 'tobi' | 'doko'
  rate: number
  hourlyRate?: number
  otMul: number
  hireDate: string
  retired?: string
  token: string
  salary?: number
  visaExpiry?: string // 在留期限 YYYY-MM-DD
}

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 8; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) throw new Error('Main doc not found')
  return { docRef, data: docSnap.data() }
}

export async function getAllWorkers(): Promise<WorkerData[]> {
  const { data } = await getMainDoc()
  return (data.workers || []) as WorkerData[]
}

export async function addWorker(worker: Omit<WorkerData, 'id' | 'token'>): Promise<WorkerData> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const nextId = (data.nextWorkerId as number) || (Math.max(0, ...workers.map(w => w.id)) + 1)

  const newWorker: WorkerData = {
    id: nextId,
    token: '',
    ...worker,
  }

  workers.push(newWorker)
  await updateDoc(docRef, {
    workers,
    nextWorkerId: nextId + 1,
  })

  return newWorker
}

export async function updateWorker(id: number, updates: Partial<WorkerData>): Promise<void> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const idx = workers.findIndex(w => w.id === id)
  if (idx === -1) throw new Error('Worker not found')

  // Don't allow changing ID
  delete updates.id
  workers[idx] = { ...workers[idx], ...updates }

  await updateDoc(docRef, { workers })
}

export async function deleteWorker(id: number): Promise<void> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const filtered = workers.filter(w => w.id !== id)
  if (filtered.length === workers.length) throw new Error('Worker not found')

  // Also remove from assignments
  const assign = (data.assign || {}) as Record<string, { workers?: number[]; subcons?: string[] }>
  for (const siteId of Object.keys(assign)) {
    if (assign[siteId].workers) {
      assign[siteId].workers = assign[siteId].workers!.filter(wid => wid !== id)
    }
  }

  await updateDoc(docRef, { workers: filtered, assign })
}

export async function generateWorkerToken(id: number): Promise<string> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const idx = workers.findIndex(w => w.id === id)
  if (idx === -1) throw new Error('Worker not found')

  const token = generateToken()
  workers[idx].token = token
  await updateDoc(docRef, { workers })
  return token
}

export async function revokeWorkerToken(id: number): Promise<void> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const idx = workers.findIndex(w => w.id === id)
  if (idx === -1) throw new Error('Worker not found')

  workers[idx].token = ''
  await updateDoc(docRef, { workers })
}
