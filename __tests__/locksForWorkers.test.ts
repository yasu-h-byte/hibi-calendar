/**
 * 「その人の会社が締め済みか」の判定（2026-10-02 総合点検）
 *
 * checkMonthLocked(ym) を会社なしで呼ぶと「両社とも締めたときだけ」拒否になる。スタッフのスマホ・職長トークン・
 * 工種の移動・履歴からの復元・運転者の記録がこれで、片方の会社だけ締めた間、その会社の人の出面を書けた。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { isMonthLockedForWorkers } from '@/lib/locks'

const workers = [{ id: 101, org: 'hibi' }, { id: 201, org: 'hfu' }, { id: 202, org: 'HFU' }, { id: 5 }]

describe('isMonthLockedForWorkers', () => {
  test('日比建設だけ締めた月: 日比の人は拒否・HFU の人は通る', () => {
    const locks = { '202609_hibi': true }
    expect(isMonthLockedForWorkers(locks, workers, '202609', [101])).toBe(true)
    expect(isMonthLockedForWorkers(locks, workers, '202609', [5])).toBe(true)      // 会社の無い人は日比建設
    expect(isMonthLockedForWorkers(locks, workers, '202609', [201])).toBe(false)
    expect(isMonthLockedForWorkers(locks, workers, '202609', [202])).toBe(false)   // 大文字の HFU も HFU
  })
  test('HFU だけ締めた月: HFU の人は拒否・日比の人は通る', () => {
    const locks = { '202609_hfu': true }
    expect(isMonthLockedForWorkers(locks, workers, '202609', [201])).toBe(true)
    expect(isMonthLockedForWorkers(locks, workers, '202609', [101])).toBe(false)
  })
  test('何人かまとめて書くときは、1人でも締め済みの会社の人がいれば拒否', () => {
    const locks = { '202609_hibi': true }
    expect(isMonthLockedForWorkers(locks, workers, '202609', [201, 101])).toBe(true)
    expect(isMonthLockedForWorkers(locks, workers, '202609', [201, 202])).toBe(false)
  })
  test('人が決まらない書き込み: either はどちらかで拒否・both は両方で拒否', () => {
    const one = { '202609_hibi': true }
    const both = { '202609_hibi': true, '202609_hfu': true }
    expect(isMonthLockedForWorkers(one, workers, '202609', [], 'either')).toBe(true)
    expect(isMonthLockedForWorkers(one, workers, '202609', [], 'both')).toBe(false)
    expect(isMonthLockedForWorkers(both, workers, '202609', [], 'both')).toBe(true)
    // 人員マスタにいない人は「決まらない」扱い
    expect(isMonthLockedForWorkers(one, workers, '202609', [999], 'either')).toBe(true)
    expect(isMonthLockedForWorkers(one, workers, '202609', [999], 'both')).toBe(false)
  })
  test('旧形式の全体ロック・別の月', () => {
    expect(isMonthLockedForWorkers({ '202609': true }, workers, '202609', [201])).toBe(true)
    expect(isMonthLockedForWorkers({ '202608_hibi': true }, workers, '202609', [101])).toBe(false)
    expect(isMonthLockedForWorkers(undefined, workers, '202609', [101])).toBe(false)
  })
})

describe('出面を書く API は、会社なしの checkMonthLocked を使わない', () => {
  const ROOT = path.join(__dirname, '..')
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) return files(p)
      return /\.tsx?$/.test(name) ? [p] : []
    })
  }
  test('checkMonthLocked( の呼び出しは、必ず会社（第2引数）を渡す', () => {
    const bad: string[] = []
    for (const f of [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'lib'))]) {
      if (f.endsWith(path.join('lib', 'locks.ts'))) continue
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        // checkMonthLocked(x) … 引数が1つだけの呼び出し
        if (/\bcheckMonthLocked\(\s*[^,()]+(\([^()]*\))?\s*\)/.test(line) && !line.includes('lock-org-ok')) {
          bad.push(`${path.relative(ROOT, f)}:${i + 1}`)
        }
      })
    }
    expect(bad, '会社なしの checkMonthLocked(ym) は「両社とも締めたときだけ」拒否になります。checkMonthLockedForWorkers を使ってください').toEqual([])
  })
})
