import { describe, test, expect, vi } from 'vitest'
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({ doc: () => null, getDoc: async () => ({ exists: () => false }), registerMainWriteHook: () => {} }))
import { parseSdKey } from '@/lib/compute'

// 2026-10-02 点検: 外注 ID に「_」が入ると、原価・月次集計・請求書の集計から外注の人工が抜けていた（鈴高組（とび）2026-06 笹塚 8日分）
describe('parseSdKey（外注の人工のキー）', () => {
  const ids = ['sato', '________99u1', 'yamaoka']
  test('「_」を含む外注 ID を取り出せる', () => {
    expect(parseSdKey('sasazuka_________99u1_202606_1', ids)).toEqual({ sid: 'sasazuka', wid: '________99u1', ym: '202606', day: '1' })
  })
  test('現場 ID に「_」があっても取り出せる', () => {
    expect(parseSdKey('site_1789432199283_sato_202609_29', ids)).toEqual({ sid: 'site_1789432199283', wid: 'sato', ym: '202609', day: '29' })
    expect(parseSdKey('site_1789432199283_________99u1_202609_3', ids)).toEqual({ sid: 'site_1789432199283', wid: '________99u1', ym: '202609', day: '3' })
  })
  test('知らない ID は従来どおり（後ろから3つ目）', () => {
    expect(parseSdKey('ihi_unknown_202609_2', ids)).toEqual({ sid: 'ihi', wid: 'unknown', ym: '202609', day: '2' })
  })
})
