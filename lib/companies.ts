/**
 * 取引先マスタ（旧: 外注先マスタ）の役割と、現場の請負体制の解決（2026-09-15）。
 *
 * ## 実態（代表 2026-09-15）
 * 現場は「元請（大林組・鹿島建設…）→ 一次（山岡建設工業・山口プロサイト…）→ 二次（日比建設・畠山組・吉本建設工業…）」。
 * 二次業者同士は並列で、互いに人を貸し借りしている。
 * - 担当の二次が自社 → 自社現場。請求先は一次（常用単価の85%を受け取る）
 * - 担当の二次が同業者 → 応援現場。請求先はその同業者（現場ごとに決めた単価の100%）
 * - 同業者から人をもらう → 外注（その同業者から請求書が届く）
 * 貸し借りは相殺せず、互いに請求書を送り合う。
 *
 * ## データの置き場所
 * 互換のため Firestore の `demmen/main.subcons` 配列をそのまま取引先マスタとして使う（id も不変）。
 * 役割は `roles` に持つ。roles が無い既存データは「外注（専門業者）」扱い＝従来どおり外注として選べる。
 */

export type CompanyRole = 'gc' | 'prime' | 'peer' | 'subcon'

export const COMPANY_ROLES: { key: CompanyRole; label: string; hint: string }[] = [
  { key: 'gc', label: '元請', hint: '大林組・鹿島建設など' },
  { key: 'prime', label: '一次', hint: '山岡建設工業・山口プロサイトなど' },
  { key: 'peer', label: '同業（二次）', hint: '人を貸し借りする二次業者' },
  { key: 'subcon', label: '外注（専門業者）', hint: '応援をもらうだけの業者（土工など）' },
]

/** 現場の「担当の二次」で自社を表す値 */
export const SELF_COMPANY_ID = 'self'
export const SELF_COMPANY_LABEL = '自社（日比建設）'

export interface CompanyLike {
  id: string
  name: string
  roles?: string[]
}

/** 役割（未設定の既存データは外注扱い） */
export function companyRoles(c: CompanyLike): CompanyRole[] {
  const valid = (c.roles || []).filter((r): r is CompanyRole => COMPANY_ROLES.some(x => x.key === r))
  return valid.length > 0 ? valid : ['subcon']
}

export function hasRole(c: CompanyLike, role: CompanyRole): boolean {
  return companyRoles(c).includes(role)
}

/** 出面の「外注」として配置できる会社（同業 or 外注） */
export function canBorrowFrom(c: CompanyLike): boolean {
  const r = companyRoles(c)
  return r.includes('peer') || r.includes('subcon')
}

export interface SitePartiesInput {
  siteType?: string
  client?: string
  gcId?: string
  primeId?: string
  ownerId?: string
}

/**
 * 現場の請負体制から「自社現場／応援現場」と請求先を決める。
 * ownerId が未設定の旧データは、従来の siteType / client をそのまま返す。
 */
export function resolveSiteParties(site: SitePartiesInput, companies: CompanyLike[]): {
  siteType: 'direct' | 'support'
  billToId: string | null
  billToName: string
} {
  const byId = (id?: string) => (id ? companies.find(c => c.id === id) : undefined)
  if (!site.ownerId) {
    return {
      siteType: site.siteType === 'support' ? 'support' : 'direct',
      billToId: null,
      billToName: site.client || '',
    }
  }
  if (site.ownerId === SELF_COMPANY_ID) {
    const prime = byId(site.primeId)
    return { siteType: 'direct', billToId: prime?.id ?? null, billToName: prime?.name ?? '' }
  }
  const owner = byId(site.ownerId)
  return { siteType: 'support', billToId: owner?.id ?? null, billToName: owner?.name ?? '' }
}
