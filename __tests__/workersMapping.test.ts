/**
 * 人員マスタの読み出し漏れを機械的に検出する。
 *
 * `getWorkers()` の map は許可リストなので、Worker 型にフィールドを足しても
 * ここに書き忘れると **保存されているのに読み出せない** 状態になる。
 * 「入力したのにリロードすると未入力に戻る」という形で表面化し、
 * 書き込み側を疑ってしまうため、原因にたどり着くまでが遠い。
 * 2026-08-26 に birthDate で実際に起きたので、型と実装を突き合わせて防ぐ。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')

/** `export interface Worker { ... }` のフィールド名を拾う */
function workerTypeFields(): string[] {
  const src = readFileSync(join(root, 'types/index.ts'), 'utf-8')
  const body = src.match(/export interface Worker \{([\s\S]*?)\n\}/)![1]
  return [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map(m => m[1])
}

/** `getWorkers()` が組み立てるオブジェクトのキーを拾う */
function mappedFields(): string[] {
  const src = readFileSync(join(root, 'lib/workers.ts'), 'utf-8')
  // 2026-09-02: 写像を mapRawWorkers に抽出（main の重複読み解消）。マッチ先を追随
  const body = src.match(/const workers: Worker\[\] = \(raw as Record<string, unknown>\[\]\)\.map\([\s\S]*?\n  \}\)\)/)![1 - 1]
  return [...body.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m => m[1])
}

describe('getWorkers の読み出し漏れ', () => {
  it('Worker 型のフィールドがすべて map されている', () => {
    const missing = workerTypeFields().filter(f => !mappedFields().includes(f))
    expect(missing).toEqual([])
  })

  it('号俸制に必要なフィールドが読み出せる', () => {
    for (const f of ['birthDate', 'jpGrade', 'jpStep']) {
      expect(mappedFields()).toContain(f)
    }
  })

  it('検査そのものが機能している（フィールドを拾えている）', () => {
    expect(workerTypeFields().length).toBeGreaterThan(10)
    expect(mappedFields()).toContain('name')
  })
})
