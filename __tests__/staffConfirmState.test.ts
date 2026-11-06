import { describe, test, expect, vi } from 'vitest'
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({ doc: () => null, getDoc: async () => ({ exists: () => false }), setDoc: async () => {} }))
import { evalStaffConfirm, staffConfirmTargets, isPhoneConfirmMonth, type confirmMonthContext } from '@/lib/attendance-confirm-server'
import type { AttConfirmDoc } from '@/lib/attendance-confirm'

// 本人確認の状態は月次集計の一覧・カード・月締め・スマホが同じものを使う（2026-10-02 一本化）
type Ctx = ReturnType<typeof confirmMonthContext>
const ctxOf = (ready: boolean, stale = false, homeLeaveOnly = false): Ctx => ({
  readiness: async () => homeLeaveOnly
    ? { noEntries: true, foremanMissing: 0, finalMissing: 0, ready: false }
    : { noEntries: false, foremanMissing: ready ? 0 : 3, finalMissing: ready ? 0 : 5, ready },
  staleOf: async () => stale,
  homeLeaveOnly: async () => homeLeaveOnly,
  summarize: async () => { throw new Error('unused') },
} as unknown as Ctx)
const w = { id: 101 }
const conf = (o: Partial<AttConfirmDoc>) => ({ ym: '202609', workerId: 101, status: 'ok', at: '2026-10-01T10:00:00Z', ...o }) as AttConfirmDoc
const SEP = { ym: '202609', todayIso: '2026-10-02', locked: false }

describe('本人確認の状態', () => {
  test('承認がそろっていない人は「承認待ち」（スマホにまだ確認が出ていない＝まだ、として警告しない）', async () => {
    const r = await evalStaffConfirm(null, w, ctxOf(false), SEP)
    expect(r.state).toBe('waiting')
    expect(r.readiness.finalMissing).toBe(5)
  })
  test('承認がそろって確認が出ているのに押していない人は「まだ」', async () => {
    expect((await evalStaffConfirm(null, w, ctxOf(true), SEP)).state).toBe('none')
  })
  test('承認の前に押しただけの確認は数えない（そろっていれば early、そろっていなければ承認待ち）', async () => {
    expect((await evalStaffConfirm(conf({}), w, ctxOf(true), SEP)).state).toBe('early')
    expect((await evalStaffConfirm(conf({}), w, ctxOf(false), SEP)).state).toBe('waiting')
  })
  test('承認のあとの確認は確認ずみ。出面が変わったら要再確認', async () => {
    expect((await evalStaffConfirm(conf({ afterApproval: true }), w, ctxOf(true), SEP)).state).toBe('ok')
    expect((await evalStaffConfirm(conf({ afterApproval: true }), w, ctxOf(true, true), SEP)).state).toBe('stale')
  })
  test('本人からの連絡（未対応）は承認の前後にかかわらず「連絡あり」。対応済みなら確認ずみ', async () => {
    expect((await evalStaffConfirm(conf({ status: 'issue' }), w, ctxOf(false), SEP)).state).toBe('issue')
    expect((await evalStaffConfirm(conf({ status: 'issue', afterApproval: true }), w, ctxOf(true), SEP)).state).toBe('issue')
    expect((await evalStaffConfirm(conf({ status: 'issue', afterApproval: true, resolvedAt: 'x' }), w, ctxOf(true), SEP)).state).toBe('ok')
  })
  test('スマホで確認できない月: 前の月より古い月は「期間外」。進行中の月は承認待ち／まだ', async () => {
    expect((await evalStaffConfirm(null, w, ctxOf(true), { ...SEP, ym: '202608' })).state).toBe('outside')
    expect((await evalStaffConfirm(null, w, ctxOf(false), { ...SEP, ym: '202610' })).state).toBe('waiting')
    // 締めたあとは期間外（スマホに出さない）。締める前にした有効な確認は残る
    expect((await evalStaffConfirm(null, w, ctxOf(true), { ...SEP, locked: true })).state).toBe('outside')
    expect((await evalStaffConfirm(conf({ afterApproval: true }), w, ctxOf(true), { ...SEP, locked: true })).state).toBe('ok')
  })
  test('まるごと帰国中の月は「確認不要」（2026-11-06 フウ 10月分）。本人からの未対応の連絡があればそちらを優先', async () => {
    const SEP10 = { ym: '202610', todayIso: '2026-11-06', locked: false }
    expect((await evalStaffConfirm(null, w, ctxOf(false, false, true), SEP10)).state).toBe('exempt')
    // 期間外の月・締めたあとでも確認不要のまま（締めの一覧に出さない）
    expect((await evalStaffConfirm(null, w, ctxOf(false, false, true), { ...SEP10, ym: '202609' })).state).toBe('exempt')
    expect((await evalStaffConfirm(null, w, ctxOf(false, false, true), { ...SEP10, locked: true })).state).toBe('exempt')
    expect((await evalStaffConfirm(conf({ ym: '202610', status: 'issue' }), w, ctxOf(false, false, true), SEP10)).state).toBe('issue')
  })
  test('スマホに確認を出す月は「前の月」で締める前だけ', () => {
    expect(isPhoneConfirmMonth('202609', '2026-10-02', false)).toBe(true)
    expect(isPhoneConfirmMonth('202609', '2026-10-02', true)).toBe(false)
    expect(isPhoneConfirmMonth('202608', '2026-10-02', false)).toBe(false)
  })
})

describe('本人確認の対象者', () => {
  const workers = [
    { id: 101, name: 'A', visaType: 'jisshu', company: '日比' },
    { id: 102, name: 'B', visaType: 'none', company: '日比' },                     // 日本人
    { id: 103, name: 'C', visaType: 'tokutei', company: 'HFU' },
    { id: 104, name: 'D', visaType: 'jisshu', company: '日比' },                   // 記録なし
    { id: 105, name: 'E', visaType: 'jisshu', company: '日比', retired: '2026-08-31' },
    { id: 106, name: 'F', visaType: '', company: '日比' },                         // 在留資格の登録なし
  ]
  const d = {
    ihi_101_202609_1: { w: 1 }, ihi_102_202609_1: { w: 1 }, ihi_103_202609_2: { w: 1 },
    ihi_105_202609_1: { w: 1 }, ihi_106_202609_1: { w: 1 }, ihi_104_202608_30: { w: 1 },
  } as unknown as Parameters<typeof staffConfirmTargets>[1]
  test('外国人で、その月に在籍して記録がある人だけ。会社で絞れる', () => {
    expect(staffConfirmTargets(workers, d, '202609', 'all').map(x => x.id)).toEqual([101, 103])
    expect(staffConfirmTargets(workers, d, '202609', 'hibi').map(x => x.id)).toEqual([101])
    expect(staffConfirmTargets(workers, d, '202609', 'hfu').map(x => x.id)).toEqual([103])
  })
})
