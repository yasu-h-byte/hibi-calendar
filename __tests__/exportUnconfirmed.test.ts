import { describe, test, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { markUnconfirmedWorkbook, UNCONFIRMED_SHEET_NAME } from '@/lib/export'

describe('締める前の帳票の「未確定」印（2026-09-30）', () => {
  test('先頭に未確定のシートが入り、元のシートはそのまま後ろに残る', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['名前', '日数'], ['A', 20]]), '出面一覧')
    markUnconfirmedWorkbook(wb, { ymLabel: '2026年9月分', orgLabel: '日比建設', docLabel: '出面一覧', at: '2026/10/1 9:00' })
    expect(wb.SheetNames).toEqual([UNCONFIRMED_SHEET_NAME, '出面一覧'])
    expect(wb.Sheets['出面一覧'].B2.v).toBe(20)
    expect(String(wb.Sheets[UNCONFIRMED_SHEET_NAME].A1.v)).toContain('未確定')
    // 書き出せる（シート名に使えない文字が無い）
    expect(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }).length).toBeGreaterThan(0)
  })
})
