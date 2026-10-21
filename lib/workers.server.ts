/**
 * 人員マスタの読み出し（**サーバー専用**・2026-10-21 総点検で lib/workers.ts から移した）
 *
 * lib/workers.ts は項目の仕分け（許可リスト）・在籍判定・時給の適用など純粋な関数だけになり、
 * 画面（'use client'）から安全に import できる。以前は getWorkers() が同じファイルにあったため、
 * /workers・/settings・/evaluation など 10 画面のクライアント JS に Firebase Web SDK（約100KB）が載っていた。
 */
import 'server-only'
import type { Worker } from '@/types'
import { mapRawWorkers, findWorkerByToken } from './workers'
import { getMainData } from './compute.server'

/**
 * 人員マスタの読み出し。
 *
 * ⚠️ **この map は許可リストになっている。** Firestore に保存されていても、ここに
 *    書き忘れたフィールドは呼び出し側に届かない。「保存したのに画面では未入力のまま」
 *    という形で表面化し、書き込み側を疑って時間を溶かす（2026-08-26 に birthDate で発生）。
 *    Worker 型にフィールドを足したら、必ずここにも足すこと。
 *    漏れは `__tests__/workersMapping.test.ts` が検出する。
 */
export async function getWorkers(): Promise<Worker[]> {
  // 2026-10-21 総点検: 人員マスタは getMainData（30 秒キャッシュ）から。旧は毎回 demmen/main（約 260KB）を読み直し、
  //   スマホ・職長・マイページの API が 1 リクエストで main を 2〜3 回読んでいた。
  //   書き込みの直後は lib/fsdb.ts の registerMainWriteHook が同一インスタンスのキャッシュを消す。
  return mapRawWorkers((await getMainData()).workers)
}

export async function getWorkerByToken(token: string, opts: { allowGrace?: boolean } = {}): Promise<Worker | null> {
  if (!token) return null
  return findWorkerByToken(await getWorkers(), token, opts)
}
