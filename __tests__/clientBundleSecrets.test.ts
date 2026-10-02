/**
 * 賃金予定がクライアントの JS に載らないことの検査（scripts/check-client-bundle-secrets.mjs）が
 * 空振りしていないかのテスト（2026-10-02）。
 *
 * 検査スクリプトは lib/wage-plan.server.ts の文字面から探す文字列を拾う。書き方が変わって
 * 拾えなくなると「何も見つからない＝合格」になってしまうので、実データの全員分を拾えているか確かめる。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SCHEDULED_WAGE_CHANGES, WAGE_CONTEXT } from '@/lib/wage-plan.server'
import { extractNeedles, PLAN_FILE } from '../scripts/check-client-bundle-secrets.mjs'

describe('check-client-bundle-secrets の検査対象', () => {
  const needles: string[] = extractNeedles(readFileSync(PLAN_FILE, 'utf8'))

  it('予定のすべての「workerId:時給」を拾う', () => {
    for (const c of SCHEDULED_WAGE_CHANGES) {
      for (const [id, yen] of Object.entries(c.targets)) expect(needles).toContain(`${id}:${yen}`)
    }
  })

  it('改定の理由・個別事情の文章を拾う', () => {
    for (const c of SCHEDULED_WAGE_CHANGES) {
      expect(needles.some(n => c.reason.includes(n))).toBe(true)
    }
    for (const ctx of Object.values(WAGE_CONTEXT)) {
      expect(needles.some(n => ctx.detail.includes(n))).toBe(true)
    }
  })
})

describe('画面側のモジュールに予定表を書かない', () => {
  it('lib/wage-curve.ts・lib/wage-analysis.ts に予定の金額が無い', () => {
    const client = ['lib/wage-curve.ts', 'lib/wage-analysis.ts', 'app/(app)/wage-analysis/page.tsx']
      .map(f => readFileSync(f, 'utf8')).join('\n')
    for (const c of SCHEDULED_WAGE_CHANGES) {
      for (const [id, yen] of Object.entries(c.targets)) {
        expect(client).not.toMatch(new RegExp(`\\b${id}:\\s*${yen}\\b`))
      }
    }
  })
})
