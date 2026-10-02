/**
 * useLatestRequest が返す物は同じ参照を保つ（2026-10-03）。
 * 旧: 毎回新しいオブジェクトを返し、依存に持つ fetchData が描画のたびに作り直されて読み込みが無限に繰り返された
 * （お試しサイトで出面入力・月次集計が「読み込み中」のまま）。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

describe('useLatestRequest', () => {
  test('返す物を useMemo で固定している', () => {
    const src = readFileSync(path.join(__dirname, '..', 'lib/hooks/useLatestRequest.ts'), 'utf8')
    expect(src).toMatch(/return useMemo\(\(\) => \(\{ begin, isAbort \}\), \[begin, isAbort\]\)/)
    expect(src).not.toMatch(/\n\s*return \{ begin, isAbort \}/)
  })
})
