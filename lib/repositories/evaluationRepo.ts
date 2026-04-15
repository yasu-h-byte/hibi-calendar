/**
 * HR評価データのFirestoreアクセスを集約
 * Firestoreコレクション: evaluations
 */

import { db } from '@/lib/firebase'
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
} from 'firebase/firestore'
import type { Evaluation } from '@/types'

const EVAL_COL = 'evaluations'

/** 全評価セッションを取得 */
export async function getAllEvaluations(): Promise<Evaluation[]> {
  const snap = await getDocs(collection(db, EVAL_COL))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Evaluation))
}

/** 特定ワーカーの評価セッション一覧 */
export async function getWorkerEvaluations(workerId: number): Promise<Evaluation[]> {
  const q = query(collection(db, EVAL_COL), where('workerId', '==', workerId))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Evaluation))
}

/** 評価セッションを取得 */
export async function getEvaluation(id: string): Promise<Evaluation | null> {
  const snap = await getDoc(doc(db, EVAL_COL, id))
  return snap.exists() ? ({ id, ...snap.data() } as Evaluation) : null
}

/** 評価セッションを作成 or 更新 */
export async function saveEvaluation(id: string, data: Omit<Evaluation, 'id'>): Promise<void> {
  await setDoc(doc(db, EVAL_COL, id), data)
}

/** 評価セッションを部分更新 */
export async function updateEvaluation(id: string, updates: Partial<Evaluation>): Promise<void> {
  await updateDoc(doc(db, EVAL_COL, id), updates as Record<string, unknown>)
}
