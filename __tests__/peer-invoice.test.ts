/**
 * 応援の請求書（lib/peer-invoice.ts）の検証テスト
 *
 * 確認すること:
 *   - 金額（鳶・土工の内訳、消費税）が /peer-statement（lib/peer-statement.ts）の
 *     「請求する」金額と1円までズレないこと
 *   - 出面明細の行合計を足すと請求書本体の人工と一致すること
 *   - 支払期日が「月末締め・翌◯月払い・土日祝は前営業日」の通りに出ること
 */
import { describe, test, expect } from 'vitest'
import { compute, type MainData } from '@/lib/compute'
import { buildPeerStatements } from '@/lib/peer-statement'
import { buildPeerInvoiceDraft, computeDueDate, billingPeriodOf } from '@/lib/peer-invoice'
import type { AttendanceEntry } from '@/types'

function buildMain(overrides: Record<string, unknown>): MainData {
  return {
    workers: [], sites: [], subcons: [],
    assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {}, nightDays: {},
    ...overrides,
  } as unknown as MainData
}

function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${day}`
}
function attSdKey(siteId: string, subconId: string, ym: string, day: number): string {
  return `${siteId}_${subconId}_${ym}_${day}`
}

describe('computeDueDate（月末締め・翌◯月払い・前営業日繰り上げ）', () => {
  test('既定（翌月末払い）: 月末が土曜なら金曜に繰り上げ', () => {
    expect(computeDueDate('202609')).toBe('2026-10-30') // 2026-10-31 は土曜
  })
  test('翌月末払いで月末が平日ならそのまま', () => {
    expect(computeDueDate('202610', { closing: 'end', payMonthOffset: 1, payDay: 'end' })).toBe('2026-11-30') // 月曜
  })
  test('固定日払いが祝日（勤労感謝の日）なら土日もまたいで前営業日へ', () => {
    // 2026-11-23（月・祝）→ 22(日)→21(土)→20(金)
    expect(computeDueDate('202610', { closing: 'end', payMonthOffset: 1, payDay: 23 })).toBe('2026-11-20')
  })
  test('翌々月払い', () => {
    expect(computeDueDate('202611', { closing: 'end', payMonthOffset: 2, payDay: 25 })).toBe('2027-01-25') // 月曜・祝日でない
  })
})

describe('billingPeriodOf', () => {
  test('対象月の月初〜月末', () => {
    expect(billingPeriodOf('202609')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
})

describe('buildPeerInvoiceDraft', () => {
  const ym = '202609'
  const main = buildMain({
    workers: [
      { id: 10, name: '鳶太郎', org: 'hibi', visa: 'none', job: 'tobi', rate: 18000, otMul: 1.25, hireDate: '2020-01-01', token: '' },
      { id: 20, name: '土工次郎', org: 'hibi', visa: 'none', job: 'doko', rate: 16000, otMul: 1.25, hireDate: '2020-01-01', token: '' },
    ],
    sites: [
      {
        id: 'siteA', name: '現場A', start: '', end: '', foreman: 0, archived: false,
        siteType: 'support', ownerId: 'peerco', primeId: undefined, gcId: undefined,
        rates: [{ from: '2026-01', tobiRate: 28000, dokoRate: 22000 }],
      },
    ],
    subcons: [
      {
        id: 'peerco', name: '吉本建設工業株式会社', type: '鳶業者', rate: 25000, otRate: 4000, note: '', roles: ['peer'],
        postal: '123-4567', address: '東京都千代田区1-1-1', honorific: '御中',
        paymentTerms: { closing: 'end', payMonthOffset: 1, payDay: 'end' },
      },
      { id: 'gaichu1', name: '村田工業', type: '鳶業者', rate: 20000, otRate: 3500, note: '' },
    ],
  })

  const attD: Record<string, AttendanceEntry> = {
    ...attKeyEntries('siteA', 10, ym, [1, 2, 3]),
    ...attKeyEntries('siteA', 20, ym, [1]),
  }
  const attSD: Record<string, { n: number; on: number }> = {
    [attSdKey('siteA', 'gaichu1', ym, 2)]: { n: 2, on: 0 },
  }

  function attKeyEntries(siteId: string, workerId: number, ym: string, days: number[]): Record<string, AttendanceEntry> {
    const out: Record<string, AttendanceEntry> = {}
    for (const d of days) out[attKey(siteId, workerId, ym, d)] = { w: 1 }
    return out
  }

  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const c = compute(main, attD, attSD, [{ y, m }])

  test('金額は buildPeerStatements の請求額と1円までズレない', () => {
    const stmt = buildPeerStatements(main, c, attD, attSD, ym).find(s => s.companyId === 'peerco')!
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!
    expect(draft.subtotal).toBe(stmt.billingTotal)
    expect(draft.lines.reduce((s, l) => s + l.amount, 0)).toBe(stmt.billingTotal)
  })

  test('鳶・土工の内訳と税額', () => {
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!
    // 鳶: 自社3人工 + 外注2人工 = 5人工 × 28000円
    // 土工: 1人工 × 22000円
    const tobi = draft.lines.find(l => l.role === '鳶')!
    const doko = draft.lines.find(l => l.role === '土工')!
    expect(tobi.days).toBe(5)
    expect(doko.days).toBe(1)
    expect(doko.amount).toBe(22000)
    expect(tobi.amount).toBe(draft.subtotal - 22000)
    expect(draft.subtotal).toBe(5 * 28000 + 1 * 22000)
    expect(draft.tax).toBe(Math.floor(draft.subtotal * 0.10))
    expect(draft.total).toBe(draft.subtotal + draft.tax)
  })

  test('宛名・支払期日・請求期間', () => {
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!
    expect(draft.companyName).toBe('吉本建設工業株式会社')
    expect(draft.company).toEqual({ postal: '123-4567', address: '東京都千代田区1-1-1', honorific: '御中' })
    expect(draft.dueDate).toBe('2026-10-30')
    expect(draft.period).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  test('出面明細の行合計を足すと現場合計・請求書本体の人工に一致する', () => {
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!
    expect(draft.detail).toHaveLength(1)
    const siteDetail = draft.detail[0]
    expect(siteDetail.siteId).toBe('siteA')
    expect(siteDetail.rows.map(r => r.label).sort()).toEqual(['土工次郎', '村田工業（外注）', '鳶太郎'].sort())
    const rowTotalSum = siteDetail.rows.reduce((s, r) => s + r.total, 0)
    expect(rowTotalSum).toBe(siteDetail.siteTotal)
    expect(siteDetail.siteTotal).toBe(6) // 鳶5 + 土工1
    // 外注の行は isSubcon フラグを持つ
    const gaichuRow = siteDetail.rows.find(r => r.label.includes('村田工業'))!
    expect(gaichuRow.isSubcon).toBe(true)
    expect(gaichuRow.cells[2]?.md).toBe(2)
  })

  test('請求できる金額が無い会社・月は null', () => {
    expect(buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'gaichu1')).toBeNull()
    expect(buildPeerInvoiceDraft(main, c, attD, attSD, '202601', 'peerco')).toBeNull()
    expect(buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'no-such-company')).toBeNull()
  })
})

// ─────────────────────────────────────────────
// 工種サイト（親現場の下の「鉄骨」「仮設」など単価が違う工事の出し分け・2026-09-25）
// ─────────────────────────────────────────────
describe('buildPeerInvoiceDraft（工種サイトで単価が違う応援現場・畠山組パターン）', () => {
  const ym = '202609'
  // 親現場「川崎」の下に、単価の違う「鉄骨」「仮設」の工種サイトを作る。
  // 親現場自身には出面を一切入れない（畠山組・川崎 応援と同じ形）。
  const main = buildMain({
    workers: [
      { id: 30, name: '梶原', org: 'hibi', visa: 'none', job: 'tobi', rate: 18000, otMul: 1.25, hireDate: '2020-01-01', token: '' },
    ],
    sites: [
      {
        id: 'kawasaki', name: '川崎', start: '', end: '', foreman: 0, archived: false,
        siteType: 'support', ownerId: 'peerco', primeId: undefined, gcId: undefined,
      },
      // 工種サイトは /api/sites が親保存時に siteType/ownerId 等（INHERITED_FIELDS）を
      // 書き写す（docs/firestore.md）。テストの main もその後の状態を再現する。
      {
        id: 'kawasaki_tekkotsu', name: '川崎（鉄骨）', parentId: 'kawasaki', workType: '鉄骨',
        start: '', end: '', foreman: 0, archived: false,
        siteType: 'support', ownerId: 'peerco', primeId: undefined, gcId: undefined,
        rates: [{ from: '2026-01', tobiRate: 30000, dokoRate: 20000 }],
      },
      {
        id: 'kawasaki_kasetsu', name: '川崎（仮設）', parentId: 'kawasaki', workType: '仮設',
        start: '', end: '', foreman: 0, archived: false,
        siteType: 'support', ownerId: 'peerco', primeId: undefined, gcId: undefined,
        rates: [{ from: '2026-01', tobiRate: 24000, dokoRate: 20000 }],
      },
    ],
    subcons: [
      {
        id: 'peerco', name: '畠山組', type: '鳶業者', rate: 25000, otRate: 4000, note: '', roles: ['peer'],
        postal: '111-2222', address: '東京都○○区2-2-2', honorific: '御中',
        paymentTerms: { closing: 'end', payMonthOffset: 1, payDay: 'end' },
      },
    ],
  })

  function attKeyEntries(siteId: string, workerId: number, ymv: string, days: number[]): Record<string, AttendanceEntry> {
    const out: Record<string, AttendanceEntry> = {}
    for (const d of days) out[attKey(siteId, workerId, ymv, d)] = { w: 1 }
    return out
  }

  // 梶原さん: 1〜2日は鉄骨、3日は仮設で工事の種類を切り分けて入力（今回の指示のシナリオ）
  const attD: Record<string, AttendanceEntry> = {
    ...attKeyEntries('kawasaki_tekkotsu', 30, ym, [1, 2]),
    ...attKeyEntries('kawasaki_kasetsu', 30, ym, [3]),
  }
  const attSD: Record<string, { n: number; on: number }> = {}

  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const c = compute(main, attD, attSD, [{ y, m }])

  test('工種ごとに別の行・別の単価になる（合計は buildPeerStatements と1円までズレない）', () => {
    const stmt = buildPeerStatements(main, c, attD, attSD, ym).find(s => s.companyId === 'peerco')!
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!

    expect(draft.subtotal).toBe(stmt.billingTotal)
    expect(draft.lines.reduce((s, l) => s + l.amount, 0)).toBe(stmt.billingTotal)

    expect(draft.lines).toHaveLength(2)
    const tekkotsu = draft.lines.find(l => l.siteId === 'kawasaki_tekkotsu')!
    const kasetsu = draft.lines.find(l => l.siteId === 'kawasaki_kasetsu')!
    expect(tekkotsu.role).toBe('鳶')
    expect(tekkotsu.days).toBe(2)
    expect(tekkotsu.rate).toBe(30000)
    expect(tekkotsu.amount).toBe(2 * 30000)
    expect(tekkotsu.siteName).toBe('川崎（鉄骨）')
    expect(kasetsu.role).toBe('鳶')
    expect(kasetsu.days).toBe(1)
    expect(kasetsu.rate).toBe(24000)
    expect(kasetsu.amount).toBe(1 * 24000)
    expect(kasetsu.siteName).toBe('川崎（仮設）')

    expect(draft.subtotal).toBe(2 * 30000 + 1 * 24000)
  })

  test('出面明細は工種ごとに別テーブルになり、出面が無い親現場（川崎）の行・明細は出ない', () => {
    const draft = buildPeerInvoiceDraft(main, c, attD, attSD, ym, 'peerco')!

    expect(draft.detail).toHaveLength(2)
    const siteIds = draft.detail.map(d => d.siteId).sort()
    expect(siteIds).toEqual(['kawasaki_kasetsu', 'kawasaki_tekkotsu'])
    expect(draft.detail.some(d => d.siteId === 'kawasaki')).toBe(false)
    expect(draft.lines.some(l => l.siteId === 'kawasaki')).toBe(false)

    const tekkotsuDetail = draft.detail.find(d => d.siteId === 'kawasaki_tekkotsu')!
    expect(tekkotsuDetail.siteName).toBe('川崎（鉄骨）')
    expect(tekkotsuDetail.rows.map(r => r.label)).toEqual(['梶原'])
    expect(tekkotsuDetail.siteTotal).toBe(2)
    expect(tekkotsuDetail.rows[0].cells[1]?.md).toBe(1)
    expect(tekkotsuDetail.rows[0].cells[2]?.md).toBe(1)
    expect(tekkotsuDetail.rows[0].cells[3]).toBeUndefined()

    const kasetsuDetail = draft.detail.find(d => d.siteId === 'kawasaki_kasetsu')!
    expect(kasetsuDetail.siteName).toBe('川崎（仮設）')
    expect(kasetsuDetail.rows.map(r => r.label)).toEqual(['梶原'])
    expect(kasetsuDetail.siteTotal).toBe(1)
    expect(kasetsuDetail.rows[0].cells[3]?.md).toBe(1)

    // 明細の行合計を足すと、それぞれの請求書本体の人工に一致する
    const tekkotsuLine = draft.lines.find(l => l.siteId === 'kawasaki_tekkotsu')!
    const kasetsuLine = draft.lines.find(l => l.siteId === 'kawasaki_kasetsu')!
    expect(tekkotsuDetail.siteTotal).toBe(tekkotsuLine.days)
    expect(kasetsuDetail.siteTotal).toBe(kasetsuLine.days)
  })
})
