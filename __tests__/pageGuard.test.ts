/**
 * 画面の入口の鍵（lib/page-guard.ts・2026-10-02）
 */
import { describe, test, expect } from 'vitest'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { PAGE_CAPS, requiredCapsForPath } from '@/lib/page-guard'
import { roleCan } from '@/lib/permissions'

const allowed = (role: 'foreman' | 'jimu' | 'approver' | 'officer' | 'owner', path: string) => {
  const caps = requiredCapsForPath(path)
  return caps === null || caps.some(c => roleCan(role, c))
}

describe('page guard', () => {
  test('app/(app) の全画面が PAGE_CAPS に載っている（足し忘れ防止）', () => {
    const dir = join(process.cwd(), 'app/(app)')
    const pages = readdirSync(dir).filter(d => statSync(join(dir, d)).isDirectory())
    const listed = new Set(PAGE_CAPS.map(p => p.path.slice(1)))
    expect(pages.filter(p => !listed.has(p))).toEqual([])
  })
  test('職長は給与・賃金の画面を開けない', () => {
    for (const p of ['/workers', '/compensation', '/wage', '/wage-analysis', '/monthly', '/cost', '/tool-budget', '/dashboard', '/settings', '/peer-statement', '/staff-docs', '/leave']) {
      expect(allowed('foreman', p), p).toBe(false)
    }
  })
  test('職長が使う画面は開ける', () => {
    for (const p of ['/attendance', '/attendance/mobile', '/calendar', '/evaluation', '/docs']) {
      expect(allowed('foreman', p), p).toBe(true)
    }
  })
  test('事務・政仁さん・代表の画面は今まで通り', () => {
    expect(allowed('jimu', '/workers')).toBe(true)
    expect(allowed('jimu', '/monthly')).toBe(true)
    expect(allowed('approver', '/wage')).toBe(true)
    expect(allowed('approver', '/evaluation')).toBe(true)
    expect(allowed('owner', '/wage-analysis')).toBe(true)
    expect(allowed('jimu', '/wage')).toBe(false)
  })
})
