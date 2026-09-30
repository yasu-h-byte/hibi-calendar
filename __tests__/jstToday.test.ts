/**
 * サーバ（Vercel=UTC）での「今日・今月」判定が JST になっているか（2026-10-01）
 *
 * 2026-10-01 の 0〜9時（JST）に /api/leave が「まだ9月」と判定し、日本人全員を前の期で
 * 表示した。new Date().getMonth() などを使うと、UTC のサーバでは月初・年度初めの朝9時まで
 * 前月・前年度になる。TZ=UTC にして、その時間帯を再現する。
 */
import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { jstToday, todayJstIso } from '@/lib/date-utils'
import { currentYm6, currentYm7, nextYm6, nextYm7, prevYm6, getPastMonthsYm6 } from '@/lib/ym'
import { getYmOptions } from '@/lib/compute'
import { yearsFromHire } from '@/lib/evaluation-config'

const ORIGINAL_TZ = process.env.TZ

describe.each(['UTC', 'Asia/Tokyo'])('TZ=%s のホストでも JST の暦で判定する', (tz) => {
  beforeAll(() => { process.env.TZ = tz })
  afterAll(() => { process.env.TZ = ORIGINAL_TZ })
  afterEach(() => { vi.useRealTimers() })

  it('10/1 08:00 JST（UTC 9/30 23:00）は 10月・新年度', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T23:00:00Z'))

    // 旧コードの再現: UTC のホストでは new Date() の月がまだ 9月
    if (tz === 'UTC') expect(new Date().getMonth() + 1).toBe(9)

    expect(todayJstIso()).toBe('2026-10-01')
    const t = jstToday()
    expect([t.getFullYear(), t.getMonth() + 1, t.getDate()]).toEqual([2026, 10, 1])
    expect(currentYm6()).toBe('202610')
    expect(currentYm7()).toBe('2026-10')
    expect(nextYm6()).toBe('202611')
    expect(nextYm7()).toBe('2026-11')
    expect(prevYm6()).toBe('202609')
    expect(getPastMonthsYm6(2)).toEqual(['202610', '202609'])
    expect(getYmOptions(1)[0].ym).toBe('202610')
    // 入社記念日の当日朝から満年数が増える
    expect(yearsFromHire('2023-10-01')).toBe(3)
  })

  it('1/1 00:30 JST（UTC 12/31 15:30）は新しい年', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-31T15:30:00Z'))
    expect(currentYm6()).toBe('202701')
    expect(prevYm6()).toBe('202612')
    expect(jstToday().getFullYear()).toBe(2027)
  })

  it('9/30 23:59 JST（UTC 9/30 14:59）はまだ 9月', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T14:59:00Z'))
    expect(currentYm6()).toBe('202609')
    expect(jstToday().getDate()).toBe(30)
    expect(yearsFromHire('2023-10-01')).toBe(2)
  })
})

describe('再発防止 lint（scripts/lint-jst-today.mjs）', () => {
  it('app/api と lib に UTC の暦日判定が残っていない', () => {
    const out = execFileSync('node', [resolve(__dirname, '../scripts/lint-jst-today.mjs')], { encoding: 'utf8' })
    expect(out).toContain('問題なし')
  })
})
