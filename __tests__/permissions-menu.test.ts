/**
 * 役割ごとの権限（lib/permissions.ts）とメニュー（lib/menu.ts）・2026-09-26
 *
 * 役割ごとに見えるメニューを固定して、権限表の1行を直したときに「どのメニューが増減したか」が
 * テストの差分で分かるようにする。
 */
import { describe, test, expect } from 'vitest'
import { can, permRoleOf, roleCan } from '@/lib/permissions'
import { MENU_ITEMS, SEARCH_ENTRIES, searchMenu, normalizeForSearch } from '@/lib/menu'

const menuFor = (role: string, workerId = 50) =>
  MENU_ITEMS.filter(i => can({ role, workerId }, i.cap)).map(i => i.label)

describe('役割ごとのメニュー', () => {
  test('職長', () => {
    expect(menuFor('foreman')).toEqual(['出面入力', '就業カレンダー', '評価入力', '資料一覧'])
  })
  test('事務（森田さん）', () => {
    expect(menuFor('jimu')).toEqual([
      'ダッシュボード', '出面入力', '月次集計・締め', '帳票出力', '休暇管理', '請求書・支払',
      '原価・収益', '人員マスタ', '道具代管理', '現場マスタ', '取引先マスタ', '資料一覧',
    ])
  })
  test('事業責任者（政仁さん）', () => {
    expect(menuFor('approver', 1)).toEqual([
      'ダッシュボード', '出面入力', '就業カレンダー', '月次集計・締め', '帳票出力', '休暇管理', '請求書・支払',
      '原価・収益', '人員マスタ', '賃金・評価', '評価入力', '道具代管理', '現場マスタ', '取引先マスタ', '資料一覧',
    ])
  })
  test('代表はすべて', () => {
    expect(menuFor('admin', 0)).toEqual(MENU_ITEMS.map(i => i.label))
  })
})

describe('原則どおりか', () => {
  test('最終承認は事業責任者と代表だけ（役員・事務・職長は不可）', () => {
    for (const cap of ['attendance.finalApprove', 'calendar.approve', 'leave.finalApprove', 'invoice.approve', 'wage.decide'] as const) {
      expect(roleCan('approver', cap)).toBe(true)
      expect(roleCan('owner', cap)).toBe(true)
      expect(roleCan('officer', cap)).toBe(false)
      expect(roleCan('jimu', cap)).toBe(false)
      expect(roleCan('foreman', cap)).toBe(false)
    }
  })
  test('役員は見るだけ（書き込み系は何もできない）', () => {
    const writes = ['attendance.input', 'monthly.close', 'cost.edit', 'workers.edit', 'masters.edit', 'toolBudget.edit', 'leave.manage', 'invoice.request'] as const
    for (const cap of writes) expect(roleCan('officer', cap)).toBe(false)
  })
  test('帰国情報: 登録・変更は事務も可（補助）、削除は事業責任者・代表だけ', () => {
    expect(roleCan('jimu', 'homeLeave.edit')).toBe(true)
    expect(roleCan('jimu', 'homeLeave.delete')).toBe(false)
    expect(roleCan('approver', 'homeLeave.delete')).toBe(true)
    expect(roleCan('foreman', 'homeLeave.edit')).toBe(false)
  })
  test('給与欄の直接の書き換えは代表だけ', () => {
    expect(roleCan('owner', 'workers.editPay')).toBe(true)
    for (const r of ['approver', 'officer', 'jimu', 'foreman'] as const) expect(roleCan(r, 'workers.editPay')).toBe(false)
  })
  test('役割の対応: admin=代表・役員=officer・不明は null', () => {
    expect(permRoleOf({ role: 'admin' })).toBe('owner')
    expect(permRoleOf({ role: 'officer' })).toBe('officer')
    expect(permRoleOf({ role: 'staff' })).toBeNull()
    expect(permRoleOf(null)).toBeNull()
  })
})

describe('メニュー検索', () => {
  test('かな・カナ・全角半角を無視して見つかる', () => {
    expect(normalizeForSearch('ユウキュウ')).toBe(normalizeForSearch('ゆうきゅう'))
    expect(searchMenu('有給 台帳', SEARCH_ENTRIES).map(e => e.label)).toContain('有給管理台帳（Excel）')
    expect(searchMenu('どうい', SEARCH_ENTRIES).map(e => e.label)).toContain('周知・同意台帳（Excel）')
    expect(searchMenu('HFU', SEARCH_ENTRIES).map(e => e.label)).toContain('HFU → 日比建設 の請求書')
  })
  test('近道の飛び先はすべてアプリ内の画面', () => {
    for (const e of SEARCH_ENTRIES) expect(e.href.startsWith('/')).toBe(true)
  })
})
