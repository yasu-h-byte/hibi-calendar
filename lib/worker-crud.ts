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
  dispatchTo?: string // 出向先名（空なら通常勤務、値あり=出向中）
  dispatchFrom?: string // 出向開始月 YYYY-MM（空なら全期間出向扱い）
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

/**
 * 社員IDの採番ルール（2026-05-27 〜）
 *
 *  - 日本人職人（visa=none かつ job≠jimu）: 1〜99 の空き番号
 *  - 日本人事務（visa=none かつ job=jimu）: 300〜399 の空き番号
 *  - 外国人 / 日比建設（visa≠none かつ org=hibi）: 100〜199 の空き番号
 *  - 外国人 / HFU（visa≠none かつ org=hfu）: 200〜299 の空き番号
 *  - 上記いずれの帯にも該当しない場合: 既存ロジックの max+1（フォールバック）
 *
 * 帯域内で最小の空き番号を採用するため、退職者の番号は基本的に再利用しない
 * （workers 配列に retired 含めて残っている前提）。
 */
function assignWorkerId(
  workers: WorkerData[],
  newWorker: Omit<WorkerData, 'id' | 'token'>,
): number {
  const isForeigner = newWorker.visa !== 'none' && newWorker.visa !== ''
  const isJimu = newWorker.job === 'jimu'
  const isHfu = newWorker.org === 'hfu'

  let bandStart = 0
  let bandEnd = 0
  if (!isForeigner && !isJimu) {
    // 日本人職人
    bandStart = 1; bandEnd = 99
  } else if (!isForeigner && isJimu) {
    // 日本人事務
    bandStart = 300; bandEnd = 399
  } else if (isForeigner && !isHfu) {
    // 外国人・日比建設
    bandStart = 100; bandEnd = 199
  } else if (isForeigner && isHfu) {
    // 外国人・HFU
    bandStart = 200; bandEnd = 299
  }

  if (bandStart > 0) {
    const usedIds = new Set(workers.map(w => w.id))
    for (let id = bandStart; id <= bandEnd; id++) {
      if (!usedIds.has(id)) return id
    }
    // 帯域が全部埋まったらフォールバック（実運用ではまず起きない）
    console.warn(`[addWorker] 帯域 ${bandStart}-${bandEnd} が満員のため max+1 にフォールバック`)
  }

  // フォールバック: 既存の単純インクリメント
  return Math.max(0, ...workers.map(w => w.id)) + 1
}

export async function addWorker(worker: Omit<WorkerData, 'id' | 'token'>): Promise<WorkerData> {
  const { docRef, data } = await getMainDoc()
  const workers = (data.workers || []) as WorkerData[]
  const nextId = assignWorkerId(workers, worker)

  const newWorker: WorkerData = {
    id: nextId,
    token: '',
    ...worker,
  }

  workers.push(newWorker)
  // nextWorkerId は後方互換のため最大値を保存しておく（旧コード参照用）
  const maxId = Math.max(nextId, ...(data.nextWorkerId ? [data.nextWorkerId as number] : []))
  await updateDoc(docRef, {
    workers,
    nextWorkerId: maxId + 1,
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
