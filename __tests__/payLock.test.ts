/**
 * 給与の鍵（2026-10-02 代表「給与は僕と政仁と森田以外は見られないように、二重三重に」）
 *  1. 役割: 給与の権限は 事務・事業責任者・代表 の役割だけ
 *  2. 本人: さらに 靖仁(0)・政仁(1)・森田(303) 本人だけ（奥寺さん・佐藤さんも事務の役割なので役割だけでは足りない）
 *  3. 資料: 公開ページ（public/）に実名＋金額を載せない（scripts/lint-pay-in-docs.mjs）
 */
import { describe, test, expect } from 'vitest'
import { capAllowed, can, PAY_CAPS, PAY_VIEWER_WORKER_IDS, CAPABILITIES } from '@/lib/permissions'
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
  test('スマホURL（人員マスタの編集）と書類庫（雇用契約書）も3人だけ（総点検 2026-10-02）', () => {
    for (const cap of ['workers.edit', 'staffDocs.view', 'staffDocs.edit'] as const) {
      expect(capAllowed('jimu', 303, cap), cap).toBe(true)
      expect(capAllowed('jimu', 301, cap), cap).toBe(false)
      expect(capAllowed('jimu', 302, cap), cap).toBe(false)
    }
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
  // 2026-10-02 総合点検: 「さん」の無い実名・別の行（表）・カンマや円の無い金額・口座番号もすり抜けない
  test('実名の一覧（サーバー専用ファイルから作る）× 前後2行の金額・口座番号を検出する', () => {
    const root = mkdtempSync(join(tmpdir(), 'paylint-'))
    mkdirSync(join(root, 'public'))
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'lib', 'jp-wage-migration.server.ts'), "export const X = [{ id: 10, name: '架空 太郎', grade: '4G' }, { id: 6, name: '日比 次郎' }]\n")
    writeFileSync(join(root, 'lib', 'wage-plan.server.ts'), "const T = {\n      205: 1585, // ホー チョン ゴック\n}\n")
    const sep = ['', '', '']   // 前後2行の窓に入らないよう離す
    writeFileSync(join(root, 'public', 'y.html'), [
      '<tr><td>架空 太郎</td>',                      // 1: 名前だけ（さん なし）
      '<td>28,000円</td></tr>',                      // 2: 前の行に実名 → 検出
      ...sep,                                        // 3-5
      '<p>時給1585 は ゴック の改定後</p>',             // 6: 円もカンマも無い金額＋カタカナの名 → 検出
      ...sep,                                        // 7-9
      '<p>口座番号 1234567 は会社の口座</p>',          // 10: 口座番号だけ（名前なし）→ 検出しない
      ...sep,                                        // 11-13
      '<p>サンプルの 2,000円</p>',                     // 14: 「サン」はサンプルの一部 → 検出しない
      ...sep,                                        // 15-17
      '<p>次郎 の 日給 15000</p>',                     // 18: 「日比」は社名なので除くが「次郎」は名 → 検出
      ...sep,                                        // 19-21
      '<p>Aさん 月給 200,000円</p>',                   // 22: 架空 → 検出しない
      ...sep,                                        // 23-25
      '<p>口座番号 7654321</p>',                       // 26: 口座番号
      '<p>振込先: 架空 太郎</p>',                       // 27: 次の行に実名 → 26 を検出
    ].join('\n'))
    const hits = findPayInDocs(root).map((h: { line: number }) => h.line)
    expect(hits).toEqual([2, 6, 18, 26])
  })
})
