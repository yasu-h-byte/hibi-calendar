import { describe, test, expect } from 'vitest'
import { companyRoles, canBorrowFrom, resolveSiteParties, SELF_COMPANY_ID } from '@/lib/companies'

/** 取引先マスタと請負体制（2026-09-15） */
const companies = [
  { id: 'obayashi', name: '株式会社 大林組', roles: ['gc'] },
  { id: 'yamaoka', name: '山岡建設工業 株式会社', roles: ['prime', 'peer'] },
  { id: 'yoshimoto', name: '吉本建設工業 株式会社', roles: ['peer'] },
  { id: 'sato', name: '株式会社 佐藤建設' },  // roles 未設定の既存データ
]

describe('companyRoles / canBorrowFrom', () => {
  test('roles 未設定の既存データは外注扱い（従来どおり配置できる）', () => {
    expect(companyRoles(companies[3])).toEqual(['subcon'])
    expect(canBorrowFrom(companies[3])).toBe(true)
  })
  test('元請だけの会社は外注として配置できない', () => {
    expect(canBorrowFrom(companies[0])).toBe(false)
  })
  test('一次かつ同業の会社は配置できる', () => {
    expect(canBorrowFrom(companies[1])).toBe(true)
  })
})

describe('resolveSiteParties', () => {
  test('担当の二次が自社 → 自社現場・請求先は一次', () => {
    const r = resolveSiteParties({ gcId: 'obayashi', primeId: 'yamaoka', ownerId: SELF_COMPANY_ID }, companies)
    expect(r).toEqual({ siteType: 'direct', billToId: 'yamaoka', billToName: '山岡建設工業 株式会社' })
  })
  test('担当の二次が同業者 → 応援現場・請求先はその同業者', () => {
    const r = resolveSiteParties({ gcId: 'obayashi', primeId: 'yamaoka', ownerId: 'yoshimoto' }, companies)
    expect(r).toEqual({ siteType: 'support', billToId: 'yoshimoto', billToName: '吉本建設工業 株式会社' })
  })
  test('請負体制が未入力の旧データは保存済みの種別・取引先名を使う', () => {
    expect(resolveSiteParties({ siteType: 'support', client: '吉本建設工業（株）' }, companies))
      .toEqual({ siteType: 'support', billToId: null, billToName: '吉本建設工業（株）' })
    expect(resolveSiteParties({}, companies).siteType).toBe('direct')
  })
})
