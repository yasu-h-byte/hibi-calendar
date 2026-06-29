import { db } from './firebase'
import { doc, getDoc, runTransaction } from '@/lib/fsdb'

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
  useOldRules?: boolean
}

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 8; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

const MAIN_REF = () => doc(db, 'demmen', 'main')

async function getMainDoc() {
  const docRef = MAIN_REF()
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

// ────────────────────────────────────────
//  2026-06-13 (監査 Sprint3): workers 配列の更新を runTransaction で保護。
//   旧: getMainDoc()（read）→ ローカルで配列操作 → updateDoc（write）の
//       read-modify-write は、2人の管理者が同時に別スタッフを編集すると
//       後勝ちで一方の変更が消える（lost update）。
//   新: read→write をトランザクションに包み、競合時は自動リトライ。
// ────────────────────────────────────────

export async function addWorker(worker: Omit<WorkerData, 'id' | 'token'>): Promise<WorkerData> {
  const ref = MAIN_REF()
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Main doc not found')
    const data = snap.data()
    const workers = (data.workers || []) as WorkerData[]
    const nextId = assignWorkerId(workers, worker)

    const newWorker: WorkerData = { id: nextId, token: '', ...worker }
    workers.push(newWorker)
    const maxId = Math.max(nextId, ...(data.nextWorkerId ? [data.nextWorkerId as number] : []))
    tx.update(ref, { workers, nextWorkerId: maxId + 1 })
    return newWorker
  })
}

/**
 * @param updates    マージするフィールド
 * @param unsetFields マージ後に該当キーを削除するフィールド名（配列要素内では
 *   deleteField() が機能しないため、明示的に delete する。例: useOldRules 解除）
 */
export async function updateWorker(
  id: number,
  updates: Partial<WorkerData>,
  unsetFields: string[] = [],
): Promise<void> {
  const ref = MAIN_REF()
  delete updates.id  // ID は変更不可
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Main doc not found')
    const workers = (snap.data().workers || []) as WorkerData[]
    const idx = workers.findIndex(w => w.id === id)
    if (idx === -1) throw new Error('Worker not found')
    const merged = { ...workers[idx], ...updates } as Record<string, unknown>
    for (const k of unsetFields) delete merged[k]
    workers[idx] = merged as unknown as WorkerData
    tx.update(ref, { workers })
  })
}

export async function deleteWorker(id: number): Promise<void> {
  const ref = MAIN_REF()
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Main doc not found')
    const data = snap.data()
    const workers = (data.workers || []) as WorkerData[]
    const filtered = workers.filter(w => w.id !== id)
    if (filtered.length === workers.length) throw new Error('Worker not found')

    // 配置からも除去
    const assign = (data.assign || {}) as Record<string, { workers?: number[]; subcons?: string[] }>
    for (const siteId of Object.keys(assign)) {
      if (assign[siteId].workers) {
        assign[siteId].workers = assign[siteId].workers!.filter(wid => wid !== id)
      }
    }
    tx.update(ref, { workers: filtered, assign })
  })
}

export async function generateWorkerToken(id: number): Promise<string> {
  const ref = MAIN_REF()
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Main doc not found')
    const workers = (snap.data().workers || []) as WorkerData[]
    const idx = workers.findIndex(w => w.id === id)
    if (idx === -1) throw new Error('Worker not found')
    const token = generateToken()
    workers[idx].token = token
    tx.update(ref, { workers })
    return token
  })
}

export async function revokeWorkerToken(id: number): Promise<void> {
  const ref = MAIN_REF()
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Main doc not found')
    const workers = (snap.data().workers || []) as WorkerData[]
    const idx = workers.findIndex(w => w.id === id)
    if (idx === -1) throw new Error('Worker not found')
    workers[idx].token = ''
    tx.update(ref, { workers })
  })
}
