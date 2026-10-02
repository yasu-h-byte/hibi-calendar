/**
 * 給与の鍵（2026-10-02 代表「給与は僕と政仁と森田以外は見られないように、二重三重に」）
 *  1. 役割: 給与の権限は 事務・事業責任者・代表 の役割だけ
 *  2. 本人: さらに 靖仁(0)・政仁(1)・森田(303) 本人だけ（奥寺さん・佐藤さんも事務の役割なので役割だけでは足りない）
 *  3. 資料: 公開ページ（public/）に実名＋金額を載せない（scripts/lint-pay-in-docs.mjs）
 */
import { describe, test, expect } from 'vitest'
import { capAllowed, can, PAY_CAPS, PAY_VIEWER_WORKER_IDS, CAPABILITIES } from '@/lib/permissions'
// @ts-expect-error -- .mjs スクリプト（型なし）
import { findPayInDocs } from '../scripts/lint-pay-in-docs.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('給与の鍵: 役割と本人', () => {
  test('給与を見られる本人は 靖仁・政仁・森田 の3人だけ', () => {
    expect([...PAY_VIEWER_WORKER_IDS].sort((a, b) => a - b)).toEqual([0, 1, 303])
  })
  test('給与の権限は職長・役員の役割には付いていない', () => {
    for (const cap of PAY_CAPS) {
      const roles = CAPABILITIES[cap].roles as readonly string[]
      expect(roles.includes('foreman'), cap).toBe(false)
      expect(roles.includes('officer'), cap).toBe(false)
    }
  })
  test('森田さん（事務・303）は見られる。奥寺さん（301）・佐藤さん（302）は事務の役割でも見られない', () => {
    expect(capAllowed('jimu', 303, 'pay.view')).toBe(true)
    expect(capAllowed('jimu', 301, 'pay.view')).toBe(false)
    expect(capAllowed('jimu', 302, 'monthly.view')).toBe(false)
  })
  test('政仁さん・代表は見られる。職長・役員は本人に関係なく見られない', () => {
    expect(can({ role: 'approver', workerId: 1 }, 'wage.view')).toBe(true)
    expect(can({ role: 'admin', workerId: 0 }, 'pay.view')).toBe(true)
    expect(can({ role: 'foreman', workerId: 2 }, 'pay.view')).toBe(false)
    expect(can({ role: 'officer', workerId: 99 }, 'monthly.view')).toBe(false)
  })
  test('別の人が事業責任者の役割になっても、本人でなければ見られない（二重の鍵）', () => {
    expect(capAllowed('approver', 6, 'wage.view')).toBe(false)
    expect(capAllowed('owner', 6, 'pay.view')).toBe(false)
  })
  test('給与でない権限は本人を問わない（出面・資料など）', () => {
    expect(capAllowed('jimu', 301, 'attendance.view')).toBe(true)
    expect(capAllowed('foreman', 2, 'docs.view')).toBe(true)
  })
})

describe('給与の鍵: 公開資料', () => {
  test('いまの public/ に実名＋金額は無い', () => {
    expect(findPayInDocs()).toEqual([])
  })
  test('実名＋金額の行は検出し、架空の例（Aさん）や名前の無い金額は通す', () => {
    const root = mkdtempSync(join(tmpdir(), 'paylint-'))
    mkdirSync(join(root, 'public'))
    writeFileSync(join(root, 'public', 'x.html'), [
      '<p>対象：<strong>日比政仁さん（¥1,180,000）</strong></p>',
      '<p>時給2,214円（日給15,498円・リンさん）で計算。</p>',
      '<p>Aさん +¥2,750</p>',
      '<p>日給20,000円の人が出勤20日</p>',
      '<p>濱上さんの欠勤控除 <!-- pay-ok: テスト --> 11,280円</p>',
    ].join('\n'))
    const hits = findPayInDocs(root).map((h: { line: number }) => h.line)
    expect(hits).toEqual([1, 2])
  })
})
