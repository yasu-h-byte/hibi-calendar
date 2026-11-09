/**
 * MF経費の申請の事前チェック（docs/mf-expense-check.md）の決まりと、「読むだけ」の見張り。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  DEFAULT_MF_EXPENSE_SETTINGS, buildMonthlyReminders, checkExpenseReport, linkMfMembers, mfExpenseSettingsError,
  buildMfRouteMinFares, buildMfRouteTable, mfRouteKey, MF_HOT_HISTORY_TTL_MS, MF_REVIEW_NOTE_MAX, isMfHistoryFresh, isSameMfSubmission, mfApprovalWaitingLabel, normalizeMfReviewNote, shiftYm, summarizeMfApprovals, targetYmOf,
  mfParkingInFare, mfRunProblem, isMfWorkerInOrg, mfHfuMemberCounts, mfHfuOffice, mfHfuReportInScope, mfMemberNeedsLink, normalizeMfExpenseSettings,
  mfCheckState, mfConfirmFlagKeys, mfIsReceiptReadCurrent, mfReviewIsCurrent, mfTextHasWord,
  type MfMemberLink, type MfExpenseFlag, type MfExpenseSettings, type MfExpenseTx, type MfReceiptRead, type MfHistoryTx, type MfReportCheckInput, type MfToolContext,
} from '@/lib/mf-expense-rules'

import { buildMfRejectComment, hasMfRejectComment } from '@/lib/mf-expense-comment'
import { wasAtSite } from '@/lib/attendance'
import type { AttendanceEntry } from '@/types/index'

const settings: MfExpenseSettings = {
  ...DEFAULT_MF_EXPENSE_SETTINGS,
  itemKinds: { t: 'transit', g: 'gas', k: 'tool', o: 'other', n: 'noReceipt' },
}

const tx = (over: Partial<MfExpenseTx> = {}): MfExpenseTx => ({
  id: 'x1', date: '2026-10-05', amount: 500, itemId: 't', itemName: '交通費', remark: '清瀬-池袋', memo: '', hasFile: false, ...over,
})
const hist = (over: Partial<MfHistoryTx>): MfHistoryTx => ({
  id: 'h', reportId: 'other', memberId: 'm', date: '2026-09-05', amount: 500, itemId: 't', remark: '清瀬-池袋', ...over,
})

const run = (over: Partial<MfReportCheckInput> = {}) => checkExpenseReport({
  reportId: 'r1', submittedIso: '2026-11-08', today: '2026-11-08', txs: [tx()], history: [],
  settings, link: 'worker', workDays: new Set(['2026-10-05']),
  loadedYms: new Set(['202607', '202608', '202609', '202610', '202611']), tool: null, ...over,
}).flags
const rules = (flags: { rule: string }[]) => flags.map(f => f.rule)

describe('日付', () => {
  test('月をまたいで計算できる', () => {
    expect(shiftYm('202601', -1)).toBe('202512')
    expect(shiftYm('202612', 1)).toBe('202701')
    expect(targetYmOf('2026-01-08')).toBe('202512')
  })

  test('何月分か: 16日以降に出て当月の明細が多ければ当月分（実データ: 10/31 に 10月分）', () => {
    expect(targetYmOf('2026-10-31', ['2026-10-01', '2026-10-30'])).toBe('202610')
    expect(targetYmOf('2026-10-16', ['2026-10-01'])).toBe('202610')
    // 15日までは決まりどおり前月分
    expect(targetYmOf('2026-10-15', ['2026-10-01'])).toBe('202609')
    // 16日以降でも前月の明細が多い、または同数なら前月分
    expect(targetYmOf('2026-10-20', ['2026-09-30', '2026-09-29', '2026-10-01'])).toBe('202609')
    expect(targetYmOf('2026-10-20', ['2026-09-30', '2026-10-01'])).toBe('202609')
    expect(targetYmOf('2026-10-20')).toBe('202609')
  })

  test('D1: 月末に当月分を出した申請には出さない。15日までの当月の日付には出す', () => {
    const october = { submittedIso: '2026-10-31', today: '2026-11-09', txs: [tx({ date: '2026-10-05' })] }
    expect(rules(run(october))).not.toContain('D1')
    expect(rules(run({ submittedIso: '2026-11-08', today: '2026-11-09', txs: [tx({ date: '2026-11-05' })] }))).toContain('D1')
  })

  test('明細の控え: 古い月はそのまま、前月・当月は6時間だけ使う', () => {
    const now = Date.parse('2026-11-09T07:10:00+09:00')
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    expect(isMfHistoryFresh('202609', '202610', undefined, now)).toBe(true)
    expect(isMfHistoryFresh('202610', '202610', at(10 * 60_000), now)).toBe(true)
    expect(isMfHistoryFresh('202611', '202610', at(MF_HOT_HISTORY_TTL_MS), now)).toBe(false)
    expect(isMfHistoryFresh('202611', '202610', undefined, now)).toBe(false)
  })
})

describe('申請のチェック', () => {
  test('問題のない交通費には何も出さない', () => {
    expect(run()).toEqual([])
  })

  test('T1: 交通費の日に出面が無い', () => {
    expect(rules(run({ txs: [tx({ date: '2026-10-06' })] }))).toContain('T1')
  })

  test('出勤日に交通費が無くても何も出さない（乗り合わせの日があるため）', () => {
    const workDays = new Set(['2026-10-05', '2026-10-06'])
    expect(run({ workDays })).toEqual([])
  })

  test('T3: 同じ経路の直近の金額と 30% を超えて違う（2件以上あるときだけ）', () => {
    const history = [hist({ id: 'a' }), hist({ id: 'b', date: '2026-08-05' })]
    expect(rules(run({ txs: [tx({ amount: 800 })], history }))).toContain('T3')
    expect(rules(run({ txs: [tx({ amount: 600 })], history }))).not.toContain('T3')
    expect(rules(run({ txs: [tx({ amount: 800 })], history: [hist({})] }))).not.toContain('T3')
  })

  test('T4: 出勤1日あたりのガソリン代が直近の平均と大きく違う', () => {
    const workDays = new Set(['2026-10-05', '2026-09-05'])
    const history = [hist({ id: 'g', itemId: 'g', date: '2026-09-10', amount: 1000, remark: '' })]
    const gas = tx({ id: 'g1', itemId: 'g', amount: 3000, hasFile: true, remark: '' })
    expect(rules(run({ workDays, history, txs: [gas] }))).toContain('T4')
    expect(rules(run({ workDays, history, txs: [{ ...gas, amount: 1100 }] }))).not.toContain('T4')
  })

  test('D1: 前月以外・未来・日付なし', () => {
    expect(rules(run({ txs: [tx({ date: '2026-09-05' })] }))).toContain('D1')
    expect(rules(run({ txs: [tx({ date: '2026-11-20' })] }))).toContain('D1')
    expect(rules(run({ txs: [tx({ date: '' })] }))).toContain('D1')
  })

  test('D2: 他の申請に同じ日・金額・科目。同じ申請の中は見ない', () => {
    expect(rules(run({ history: [hist({ date: '2026-10-05' })] }))).toContain('D2')
    expect(rules(run({ history: [hist({ date: '2026-10-05', reportId: 'r1' })] }))).not.toContain('D2')
  })

  test('R1: 領収書の要らない科目と未設定の科目は見ない', () => {
    expect(rules(run({ txs: [tx({ itemId: 'o', remark: '' })] }))).toContain('R1')
    expect(rules(run({ txs: [tx({ itemId: 'n', remark: '' })] }))).not.toContain('R1')
    expect(rules(run({ txs: [tx({ itemId: 'unset', remark: '' })] }))).not.toContain('R1')
  })

  test('K1: 摘要と科目が合わない', () => {
    expect(rules(run({ txs: [tx({ itemId: 'o', remark: '電車代', hasFile: true })] }))).toContain('K1')
    expect(rules(run({ txs: [tx({ remark: '電車代' })] }))).not.toContain('K1')
    expect(rules(run({ txs: [tx({ itemId: 'o', remark: 'ガソリン', hasFile: true })] }))).toContain('K1')
  })

  const tool = (eligible: boolean, remaining: number | null): MfToolContext => ({
    eligibleOn: () => eligible,
    periodOn: () => (remaining === null ? null : { periodStart: '2026-10-01', remaining }),
  })
  const toolTx = (over: Partial<MfExpenseTx> = {}) => tx({ id: 'k1', itemId: 'k', amount: 5000, remark: '安全帯', hasFile: true, ...over })

  test('G1: 道具代の対象外・期間なし', () => {
    expect(rules(run({ txs: [toolTx()], tool: tool(false, 10000) }))).toContain('G1')
    expect(rules(run({ txs: [toolTx()], tool: tool(true, null) }))).toContain('G1')
    expect(rules(run({ txs: [toolTx()], tool: tool(true, 10000) }))).not.toContain('G1')
  })

  test('G2: この申請の道具代の合計で残額を超える', () => {
    const two = [toolTx(), toolTx({ id: 'k2' })]
    expect(rules(run({ txs: two, tool: tool(true, 8000) }))).toContain('G2')
    expect(rules(run({ txs: two, tool: tool(true, 10000) }))).not.toContain('G2')
  })

  test('G3: 摘要やメモに折半・半額', () => {
    expect(rules(run({ txs: [toolTx({ memo: '会社と折半' })], tool: tool(true, 100000) }))).toContain('G3')
  })

  test('作業員が未確定なら出面・道具代は見ず U1 を出す。作業員ではない人は U1 を出さない', () => {
    const pending = run({ link: 'pending', txs: [toolTx({ date: '2026-10-06' })], tool: null })
    expect(rules(pending)).toContain('U1')
    expect(rules(pending)).not.toContain('T1')
    expect(rules(run({ link: 'excluded', txs: [tx({ date: '2026-10-06' })] }))).toEqual([])
  })
})

describe('領収書の読み取り結果との比較', () => {
  const read = (over: Partial<MfReceiptRead> = {}): MfReceiptRead => ({ fileId: 'f', readable: true, date: '2026-10-05', amount: 500, readAt: 'x', model: 'm', ...over })
  const receiptTx = tx({ itemId: 'o', hasFile: true })
  const withRead = (r: MfReceiptRead, txOver: Partial<MfExpenseTx> = {}) => run({ txs: [{ ...receiptTx, ...txOver }], receiptReads: { x1: r } })

  test('日付も金額も同じなら何も出さない', () => {
    expect(rules(withRead(read()))).not.toEqual(expect.arrayContaining(['R2']))
    expect(rules(withRead(read()))).not.toContain('R3')
  })
  test('日付のずれを、読んだ日付つきで参考に出す', () => {
    const f = withRead(read({ date: '2026-10-03' })).find(x => x.rule === 'R2')
    expect(f?.level).toBe('info')
    expect(f?.receipt?.date).toBe('2026-10-03')
    expect(f?.message).toContain('10/3')
  })
  test('金額のずれを出す。折半は比べない', () => {
    expect(rules(withRead(read({ amount: 700 })))).toContain('R3')
    expect(rules(withRead(read({ amount: 1000 }), { remark: '折半' }))).not.toContain('R3')
  })
  test('交通費の金額のずれは、駐輪場代を分ける指摘にする', () => {
    const flags = withRead(read({ amount: 110 }), { itemId: 't', amount: 1530 })
    expect(rules(flags)).toContain('R5')
    expect(rules(flags)).not.toContain('R3')
    // 差し戻す決まりなので、これだけの申請も「チェック済み」にしない
    expect(flags.find(x => x.rule === 'R5')?.level).toBe('confirm')
    const c = buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang: 'ja', flags, txs: [{ ...receiptTx, itemId: 't', amount: 1530 }] })
    // 片道分の領収書や読み違いもあるので、本人には言い切らない
    expect(c).toContain('駐輪場代が入っている場合は')
    expect(c).toContain('入っていない場合は')
  })
  test('確信が持てない項目は比べない', () => {
    const f = rules(withRead(read({ date: null, amount: 700 })))
    expect(f).not.toContain('R2')
    expect(f).toContain('R3')
  })
  test('読めなかった領収書は R4 だけ', () => {
    const f = rules(withRead(read({ readable: false, date: null, amount: null })))
    expect(f).toContain('R4')
    expect(f).not.toContain('R2')
  })
  test('読み取り結果が無ければ何も増えない', () => {
    expect(rules(run({ txs: [receiptTx] }))).not.toContain('R4')
  })
  test('差し戻しコメントに読んだ日付と金額が入る', () => {
    const flags = withRead(read({ date: '2026-10-03', amount: 700 }))
    const ja = buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang: 'ja', flags, txs: [receiptTx] })
    expect(ja).toContain('領収書の日付は 2026/10/03')
    expect(ja).toContain('領収書の金額は 700円')
    const vi = buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang: 'vi', flags, txs: [receiptTx] })
    expect(vi).toContain('Ngày trên hóa đơn là 2026/10/03')
  })
})

describe('2026-11-09 総チェックの再発防止', () => {
  const read2 = (amount: number): Record<string, MfReceiptRead> => ({ a: { fileId: '', readable: true, date: '2026-10-05', amount, readAt: '', model: '' } })
  const fare = (over: Partial<MfExpenseTx> = {}) => tx({ id: 'a', hasFile: true, remark: '秋津~笹塚 往復電車代', ...over })

  test('駐輪場代が混ざった明細は、電車代の分で最安と比べる', () => {
    const routeMinFares = { '秋津~笹塚 往復': 2086 }
    expect(mfParkingInFare(2306, 220)).toBe(220)
    expect(mfParkingInFare(1400, 700)).toBe(0)
    expect(mfParkingInFare(1000, 1200)).toBe(0)
    expect(mfParkingInFare(1000, null)).toBe(0)
    // 2,306円 − 駐輪場代220円 = 最安どおり
    expect(rules(run({ txs: [fare({ amount: 2306 })], receiptReads: read2(220), routeMinFares }))).not.toContain('T6')
    const over = run({ txs: [fare({ amount: 2450 })], receiptReads: read2(220), routeMinFares }).find(f => f.rule === 'T6')
    expect(over?.message).toContain('2,230円')
  })

  test('電車代の科目の少額で区間の無い明細は、駐輪場代の疑いにまとめて出す', () => {
    const lines = [tx({ id: 'a', amount: 110, hasFile: true, remark: 'Cycle 商店' }), tx({ id: 'b', amount: 110, hasFile: true, remark: 'Cycle 商店' })]
    const f = run({ txs: lines }).filter(x => x.rule === 'K2')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'confirm', moreLines: 1 })
    const c = (lang: 'ja' | 'vi') => buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang, flags: f, txs: lines })
    expect(c('ja')).toContain('駐車場・駐輪場代')
    expect(c('vi')).toContain('駐車場・駐輪場代')
  })
  test('駐輪の字があれば金額や添付によらず出す。本物の電車代・バス代には出さない', () => {
    expect(rules(run({ txs: [tx({ amount: 800, remark: '秋津駅 駐輪場 定期' })] }))).toContain('K2')
    expect(rules(run({ txs: [tx({ amount: 220, hasFile: true, remark: '秋津~笹塚 片道' })] }))).not.toContain('K2')
    expect(rules(run({ txs: [tx({ amount: 220, hasFile: true, remark: 'バス代' })] }))).not.toContain('K2')
    expect(rules(run({ txs: [tx({ amount: 220, remark: 'Cycle 商店' })] }))).not.toContain('K2')
  })

  test('種類が未設定の科目は、要確認にして科目ごとに1回だけ出す', () => {
    const f = run({ txs: [tx({ id: 'a', itemId: 'new', itemName: '新しい科目' }), tx({ id: 'b', itemId: 'new', itemName: '新しい科目' })] }).filter(x => x.rule === 'U2')
    expect(f).toHaveLength(1)
    expect(f[0].level).toBe('confirm')
    expect(rules(run())).not.toContain('U2')
  })

  test('朝のチェックが止まったら知らせる。8時より前は待つ', () => {
    const ok = { completedDate: '2026-11-10', lastError: null }
    expect(mfRunProblem(ok, '2026-11-10', 9, '経費')).toBeNull()
    expect(mfRunProblem({ completedDate: '2026-11-09', lastError: null }, '2026-11-10', 7, '経費')).toBeNull()
    expect(mfRunProblem({ completedDate: '2026-11-09', lastError: null }, '2026-11-10', 8, '経費')).toContain('終わっていません')
    expect(mfRunProblem({ completedDate: null, lastError: null }, '2026-11-10', 12, '経費')).toContain('終わっていません')
    expect(mfRunProblem({ completedDate: '2026-11-10', lastError: 'x' }, '2026-11-10', 7, '経費')).toContain('失敗')
  })
})

describe('その月に出面が無い人', () => {
  test('事務など現場に出ない人の交通費には、交通費と出勤日を出さない', () => {
    expect(rules(run({ workDays: new Set() }))).not.toContain('T1')
    expect(rules(run({ workDays: new Set(['2026-09-05']) }))).not.toContain('T1')
  })
  test('その月に1日でも出面があれば、今までどおり休みの日の交通費を出す', () => {
    expect(rules(run({ workDays: new Set(['2026-10-06']) }))).toContain('T1')
  })
})

describe('HFU の技能実習生', () => {
  const member = (over: Partial<MfMemberLink> = {}): MfMemberLink => ({ mfId: 'm', number: '', name: 'A', active: true, workerId: null, how: null, candidates: [], ...over })

  test('HFU は技能実習生だけ。日比建設は今までどおり全員', () => {
    expect(isMfWorkerInOrg('hfu', { org: 'hfu', visa: 'jisshu' })).toBe(true)
    expect(isMfWorkerInOrg('hfu', { org: 'HFU', visa: 'jisshu3' })).toBe(true)
    expect(isMfWorkerInOrg('hfu', { org: 'hfu', visa: 'none' })).toBe(false)
    expect(isMfWorkerInOrg('hfu', { org: 'hfu', visa: 'tokutei1' })).toBe(false)
    expect(isMfWorkerInOrg('hfu', { org: 'hibi', visa: 'jisshu' })).toBe(false)
    expect(isMfWorkerInOrg('hibi', { org: 'hibi', visa: 'none' })).toBe(true)
    expect(isMfWorkerInOrg('hibi', { org: '日比', visa: 'jisshu' })).toBe(true)
    expect(isMfWorkerInOrg('hibi', { org: 'hfu', visa: 'jisshu' })).toBe(false)
  })
  test('MF の事業者から HFU を見つける。日比建設を HFU と間違えない', () => {
    const offices = [{ id: 'h', name: 'エイチエフユナイテッド株式会社' }, { id: 'n', name: '株式会社日比建設' }]
    expect(mfHfuOffice(offices, 'n')?.id).toBe('h')
    expect(mfHfuOffice([{ id: 'n', name: '株式会社日比建設' }], 'n')).toBeUndefined()
  })
  test('結びついた実習生と、候補のいる人の申請だけ読む。本部の人は読まない', () => {
    expect(mfHfuReportInScope(member({ workerId: 1, how: 'number' }))).toBe(true)
    expect(mfHfuReportInScope(member({ candidates: [1] }))).toBe(true)
    expect(mfHfuReportInScope(member())).toBe(false)
    expect(mfHfuReportInScope(member({ how: 'excluded' }))).toBe(false)
    expect(mfHfuReportInScope(undefined)).toBe(false)
  })
  test('区間の比較には結びついた実習生だけ入れる', () => {
    expect(mfHfuMemberCounts(member({ workerId: 1, how: 'manual' }))).toBe(true)
    expect(mfHfuMemberCounts(member({ candidates: [1] }))).toBe(false)
  })
  test('HFU の候補のいない人は「未確定」に数えない。日比建設は今までどおり数える', () => {
    expect(mfMemberNeedsLink(member({ org: 'hfu' }))).toBe(false)
    expect(mfMemberNeedsLink(member({ org: 'hfu', candidates: [1] }))).toBe(true)
    expect(mfMemberNeedsLink(member({ org: 'hibi' }))).toBe(true)
    expect(mfMemberNeedsLink(member())).toBe(true)
    expect(mfMemberNeedsLink(member({ active: false }))).toBe(false)
  })
  test('スイッチの既定は切。保存した値だけ入る', () => {
    expect(normalizeMfExpenseSettings(null).hfuEnabled).toBe(false)
    expect(normalizeMfExpenseSettings({ hfuEnabled: true }).hfuEnabled).toBe(true)
  })
})

describe('2026-11-09 総点検の再発防止', () => {
  test('0.6補の日は現場に行っていないので出勤に数えない', () => {
    expect(wasAtSite({ w: 1 } as AttendanceEntry)).toBe(true)
    expect(wasAtSite({ w: 0.5 } as AttendanceEntry)).toBe(true)
    expect(wasAtSite({ w: 0.6 } as AttendanceEntry)).toBe(false)
    expect(wasAtSite({ w: 1, p: 1 } as AttendanceEntry)).toBe(false)
    expect(wasAtSite(null)).toBe(false)
  })

  test('科目: 駐輪場の明細は駅名があっても止めない', () => {
    expect(rules(run({ txs: [tx({ itemId: 'o', remark: 'JR秋津駅 駐輪場代', hasFile: true })] }))).not.toContain('K1')
    expect(rules(run({ txs: [tx({ itemId: 'n', remark: 'メトロ 駐車場' })] }))).not.toContain('K1')
  })
  test('科目: 別の言葉の一部では止めない。本当の交通費は止める', () => {
    expect(mfTextHasWord('バスケット 工具入れ', 'バス')).toBe(false)
    expect(mfTextHasWord('レギュラーサイズ手袋', 'レギュラー')).toBe(false)
    expect(mfTextHasWord('シャトルバス代', 'バス')).toBe(true)
    expect(mfTextHasWord('バスケット バス代', 'バス')).toBe(true)
    expect(rules(run({ txs: [tx({ itemId: 'k', remark: 'バスケット 工具入れ', hasFile: true })] }))).not.toContain('K1')
    expect(rules(run({ txs: [tx({ itemId: 'o', remark: 'バス代', hasFile: true })] }))).toContain('K1')
  })
  test('科目: ガソリン代の店の名前に JR があっても止めない', () => {
    expect(rules(run({ txs: [tx({ itemId: 'g', remark: 'ガソリン JR川口駅前店', hasFile: true })] }))).not.toContain('K1')
  })

  const f = (rule: MfExpenseFlag['rule'], txId: string, level: MfExpenseFlag['level'] = 'confirm'): MfExpenseFlag => ({ rule, txId, level, message: '' })
  const review = (flags: MfExpenseFlag[]) => ({ note: '確認', byName: 'A', at: '2026-11-09T00:00:00Z', flagKeys: mfConfirmFlagKeys(flags) })

  test('確認のあとに増えた指摘は要確認に戻す', () => {
    const before = [f('T6', 'a')]
    const after = [f('T6', 'a'), f('R5', 'b')]
    expect(mfReviewIsCurrent(review(before), before)).toBe(true)
    expect(mfReviewIsCurrent(review(before), after)).toBe(false)
    expect(mfCheckState({ confirmCount: 1, review: review(before), flags: before })).toBe('reviewed')
    expect(mfCheckState({ confirmCount: 2, review: review(before), flags: after })).toBe('confirm')
  })
  test('確認のあとに減った指摘・参考の指摘では戻さない。古いメモは今のまま', () => {
    const before = [f('T6', 'a'), f('R5', 'b')]
    expect(mfReviewIsCurrent(review(before), [f('T6', 'a')])).toBe(true)
    expect(mfReviewIsCurrent(review(before), [...before, f('R2', 'c', 'info')])).toBe(true)
    expect(mfReviewIsCurrent({ note: '確認', byName: 'A', at: '' }, before)).toBe(true)
  })

  test('領収書を読めていない申請はチェック済みにしない', () => {
    expect(mfCheckState({ confirmCount: 0, flags: [] })).toBe('clean')
    expect(mfCheckState({ confirmCount: 0, flags: [], receiptPending: 2 })).toBe('receipt')
    expect(mfCheckState({ confirmCount: 0, flags: [f('R4', 'a', 'info')] })).toBe('receipt')
    expect(mfCheckState({ confirmCount: 0, flags: [f('R2', 'a', 'info')] })).toBe('clean')
    expect(mfCheckState({ confirmCount: 1, flags: [f('T1', 'a')], receiptPending: 2 })).toBe('confirm')
  })
  test('添付が差し替えられたら古い読み取りを使わない', () => {
    const r = { fileId: 'old' }
    expect(mfIsReceiptReadCurrent({ fileId: 'old' }, r)).toBe(true)
    expect(mfIsReceiptReadCurrent({ fileId: 'new' }, r)).toBe(false)
    expect(mfIsReceiptReadCurrent({ fileId: 'new' }, undefined)).toBe(false)
    expect(mfIsReceiptReadCurrent({}, r)).toBe(true)
  })
  test('交通費の領収書の金額が読めなければ、問題なしにしない', () => {
    const reads: Record<string, MfReceiptRead> = { x1: { fileId: '', readable: true, date: '2026-10-05', amount: null, readAt: '', model: '' } }
    expect(rules(run({ txs: [tx({ hasFile: true })], receiptReads: reads }))).toContain('R4')
  })
})

describe('同じ現場の交通費の差（T5）', () => {
  const siteA = { id: 'a', name: 'A現場' }
  const siteB = { id: 'b', name: 'B現場' }
  const day = (d: number, amount: number) => tx({ id: `t${d}`, date: `2026-10-${String(d).padStart(2, '0')}`, amount })
  const workDays = new Set(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'])
  const siteOfDay = { '2026-10-05': siteA, '2026-10-06': siteA, '2026-10-07': siteA, '2026-10-08': siteA }

  test('一番多い金額と違う日を要確認で出す', () => {
    const f = run({ workDays, siteOfDay, txs: [day(5, 1420), day(6, 1420), day(7, 1420), day(8, 2000)] }).filter(x => x.rule === 'T5')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'confirm', txId: 't8', usual: 1420 })
    expect(f[0].message).toContain('A現場')
  })
  test('決まりの金額までの小さな差は出さない', () => {
    const at = (last: number) => rules(run({ workDays, siteOfDay, txs: [day(5, 1420), day(6, 1420), day(7, 1420), day(8, last)] }))
    expect(at(1720)).not.toContain('T5')
    expect(at(1120)).not.toContain('T5')
    expect(at(1721)).toContain('T5')
  })
  test('金額がそろっていれば出さない', () => {
    expect(rules(run({ workDays, siteOfDay, txs: [day(5, 1420), day(6, 1420), day(7, 1420), day(8, 1420)] }))).not.toContain('T5')
  })
  test('別の現場どうしは比べない', () => {
    const mixed = { ...siteOfDay, '2026-10-08': siteB }
    expect(rules(run({ workDays, siteOfDay: mixed, txs: [day(5, 1420), day(6, 1420), day(7, 1420), day(8, 2000)] }))).not.toContain('T5')
  })
  test('3日未満や、一番多い金額が決まらないときは出さない', () => {
    expect(rules(run({ workDays, siteOfDay, txs: [day(5, 1420), day(6, 2000)] }))).not.toContain('T5')
    expect(rules(run({ workDays, siteOfDay, txs: [day(5, 1420), day(6, 1420), day(7, 2000), day(8, 2000)] }))).not.toContain('T5')
  })
  test('1日に複数の明細があれば合計で比べる', () => {
    const txs = [day(5, 1420), day(6, 1420), day(7, 710), tx({ id: 't7b', date: '2026-10-07', amount: 710 })]
    expect(rules(run({ workDays, siteOfDay, txs }))).not.toContain('T5')
  })
})

describe('T5 の差し戻しの文', () => {
  test('1行の金額ではなく、その日の合計を伝える', () => {
    const flags: MfExpenseFlag[] = [{ rule: 'T5', level: 'confirm', txId: 'x1', usual: 1420, dayTotal: 2210, message: '' }]
    const txs = [tx({ amount: 710 })]
    const c = (lang: 'ja' | 'vi') => buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang, flags, txs })
    expect(c('ja')).toContain('合計は 2,210円')
    expect(c('vi')).toContain('2,210 yên')
    // 古い保存データには合計が無い
    const old = buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang: 'ja', flags: [{ ...flags[0], dayTotal: undefined }], txs })
    expect(old).not.toContain('合計は')
  })
})

describe('同じ区間の社内の最安（T6）', () => {
  test('区間の読み取り', () => {
    expect(mfRouteKey('秋津~笹塚 往復電車代')).toBe('秋津~笹塚 往復')
    expect(mfRouteKey('笹塚(秋津~笹塚 往復電車代)')).toBe('秋津~笹塚 往復')
    expect(mfRouteKey('Kawasaki(新秋津~大川 往復電車・バス代)')).toBe('大川~新秋津 往復')
    expect(mfRouteKey('笹塚~秋津 往復電車代')).toBe('秋津~笹塚 往復')
    expect(mfRouteKey('中里(東京都)／西武バス~所沢 片道電車・バス代')).toBe('中里(東京都)/西武バス~所沢 片道')
    expect(mfRouteKey('ワークマンプラス')).toBeNull()
    expect(mfRouteKey('A~B')).toBeNull()
  })
  const h = (amount: number, remark = '秋津~笹塚 往復電車代', itemId = 't') => ({ itemId, amount, remark })
  test('2回以上出た金額の中で一番安いものを最安にする', () => {
    expect(buildMfRouteMinFares([h(1402), h(1402), h(1560), h(1560), h(100)], settings)).toEqual({ '秋津~笹塚 往復': 1402 })
    expect(buildMfRouteMinFares([h(1402)], settings)).toEqual({})
    expect(buildMfRouteMinFares([h(5, 'A~B 往復', 'o'), h(5, 'A~B 往復', 'o')], settings)).toEqual({})
  })
  const line = (id: string, amount: number) => tx({ id, amount, remark: '秋津~笹塚 往復電車代' })
  const routeMinFares = { '秋津~笹塚 往復': 1402 }
  test('最安より決まりの金額を超えて高ければ、区間ごとに1回だけ要確認で出す', () => {
    const f = run({ txs: [line('a', 1560), line('b', 1560)], routeMinFares }).filter(x => x.rule === 'T6')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'confirm', txId: 'a', usual: 1402 })
    expect(f[0].message).toContain('2 件')
  })
  test('差し戻しの文に、同じ区間のほかの明細の数が入る', () => {
    const txs = [line('a', 1560), line('b', 1560), line('c', 1560)]
    const flags = run({ txs, routeMinFares }).filter(x => x.rule === 'T6')
    expect(flags[0].moreLines).toBe(2)
    const c = (lang: 'ja' | 'vi') => buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang, flags, txs })
    expect(c('ja')).toContain('ほかの 2 件も')
    expect(c('vi')).toContain('2 khoản khác')
  })
  test('小さな差も既定で出す。見逃す差を決めればそこまでは出さない', () => {
    expect(rules(run({ txs: [line('a', 1412)], routeMinFares }))).toContain('T6')
    expect(rules(run({ txs: [line('a', 1402)], routeMinFares }))).not.toContain('T6')
    expect(rules(run({ txs: [line('a', 1502)], routeMinFares, settings: { ...settings, routeMargin: 100 } }))).not.toContain('T6')
  })
  test('比較表: 月ごとに人と金額でまとめ、差額の大きい区間から並べる', () => {
    const r = (memberId: string, amount: number, remark = '秋津~笹塚 往復電車代', date = '2026-10-05') => ({ itemId: 't', amount, remark, date, memberId })
    const t = buildMfRouteTable([r('a', 1560), r('a', 1560), r('b', 1402), r('c', 500, 'A~B 往復'), r('a', 1560, undefined, '2026-09-30')], settings, { '秋津~笹塚 往復': 1402, 'A~B 往復': 500 }, id => id.toUpperCase())
    expect(t['202610'][0]).toMatchObject({ route: '秋津~笹塚 往復', min: 1402, excess: 316 })
    expect(t['202610'][0].entries[0]).toEqual({ memberId: 'a', name: 'A', amount: 1560, lines: 2 })
    expect(t['202610'][1].excess).toBe(0)
    expect(t['202609'][0].excess).toBe(158)
  })
  test('差し戻しコメントに最安の金額が入る', () => {
    const txs = [line('a', 1560)]
    const flags = run({ txs, routeMinFares })
    expect(buildMfRejectComment({ targetYm: '202610', today: '2026-11-09', lang: 'ja', flags, txs })).toContain('社内で一番安い金額は 1,402円')
  })
})

describe('差し戻しコメント', () => {
  const t = (over: Partial<MfExpenseTx>) => tx({ itemName: '道具代', amount: 9874, ...over })
  const base = { targetYm: '202610', today: '2026-11-09' }
  const flag = (rule: 'D1' | 'R1' | 'T1' | 'G1' | 'U1' | 'T3', txId?: string) => ({ rule, level: 'confirm' as const, message: 'x', txId })

  test('翌月の明細は、その月の申請で出すよう日本語で書く', () => {
    const c = buildMfRejectComment({ ...base, lang: 'ja', flags: [flag('D1', 'a')], txs: [t({ id: 'a', date: '2026-11-03' })] })
    expect(c).toContain('・2026/11/03 道具代 9,874円')
    expect(c).toContain('11月分の申請で出してください')
    expect(c.startsWith('お疲れさまです')).toBe(true)
  })
  test('ベトナム語でも同じ内容を書き、科目名は MF の表示のまま', () => {
    const c = buildMfRejectComment({ ...base, lang: 'vi', flags: [flag('D1', 'a')], txs: [t({ id: 'a', date: '2026-11-03' })] })
    expect(c).toContain('・2026/11/03 道具代 9,874 yên')
    expect(c).toContain('tháng 11')
    expect(c).not.toMatch(/ください|お疲れさま/)
  })
  test('日付なし・未来・前の月を書き分ける', () => {
    const msg = (date: string) => buildMfRejectComment({ ...base, lang: 'ja', flags: [flag('D1', 'a')], txs: [t({ id: 'a', date })] })
    expect(msg('')).toContain('日付を入れてください')
    expect(msg('2026-12-01')).toContain('未来の日付')
    expect(msg('2026-09-30')).toContain('この申請（10月分）の月と違います')
  })
  test('同じ明細の指摘はまとめる', () => {
    const c = buildMfRejectComment({ ...base, lang: 'ja', flags: [flag('T1', 'a'), flag('R1', 'a')], txs: [t({ id: 'a', date: '2026-10-05' })] })
    expect(c.match(/・2026/g)).toHaveLength(1)
    expect(c).toContain('現場に出た記録がありません')
    expect(c).toContain('領収書が付いていません')
  })
  test('本人が直せない指摘だけなら文面を作らない', () => {
    const flags = [flag('G1', 'a'), flag('U1'), flag('T3', 'a')]
    expect(hasMfRejectComment(flags)).toBe(false)
    expect(buildMfRejectComment({ ...base, lang: 'ja', flags, txs: [t({ id: 'a' })] })).toBe('')
  })
})

describe('承認の段階', () => {
  const raw = [
    { step: 2, is_active: false, approved_at: null, approve_office_member: { name: '第二さん', number: '999' } },
    { step: 1, is_active: true, approved_at: null, approve_office_member: { name: '第一さん' } },
  ]
  test('段階の順に並べ、名前だけを持つ', () => {
    const s = summarizeMfApprovals(raw)
    expect(s.map(a => a.name)).toEqual(['第一さん', '第二さん'])
    expect(Object.keys(s[0]).sort()).toEqual(['active', 'approvedAt', 'name', 'step'])
  })
  test('今の承認者の名前を出す', () => {
    expect(mfApprovalWaitingLabel('waiting_step_one', summarizeMfApprovals(raw))).toBe('第一さん さんの承認待ち')
  })
  test('名前が取れないときは MF の状態から出す', () => {
    expect(mfApprovalWaitingLabel('waiting_step_two', [])).toBe('第2承認待ち')
    expect(mfApprovalWaitingLabel('waiting_step_two', undefined)).toBe('第2承認待ち')
    expect(mfApprovalWaitingLabel('approved', [])).toBe('')
    expect(summarizeMfApprovals(null)).toEqual([])
  })
})

describe('確認メモ', () => {
  test('空は受け付けず、前後の空白と改行は整える', () => {
    expect(normalizeMfReviewNote('  ').ok).toBe(false)
    expect(normalizeMfReviewNote(null).ok).toBe(false)
    expect(normalizeMfReviewNote(' 本人に\n確認 ')).toEqual({ ok: true, note: '本人に 確認' })
  })
  test('長すぎるメモは受け付けない', () => {
    expect(normalizeMfReviewNote('あ'.repeat(MF_REVIEW_NOTE_MAX)).ok).toBe(true)
    expect(normalizeMfReviewNote('あ'.repeat(MF_REVIEW_NOTE_MAX + 1)).ok).toBe(false)
  })
  test('同じ提出のあいだは残し、出し直されたら消す', () => {
    const now = { submittedAt: '2026-11-09T10:00:00+09:00', submittedIso: '2026-11-09' }
    expect(isSameMfSubmission(undefined, now)).toBe(false)
    expect(isSameMfSubmission({ ...now }, now)).toBe(true)
    expect(isSameMfSubmission({ submittedAt: '2026-11-09T08:00:00+09:00', submittedIso: '2026-11-09' }, now)).toBe(false)
  })
  test('提出日時を持たない古い控えは提出日で比べる', () => {
    const now = { submittedAt: '2026-11-09T10:00:00+09:00', submittedIso: '2026-11-09' }
    expect(isSameMfSubmission({ submittedIso: '2026-11-09' }, now)).toBe(true)
    expect(isSameMfSubmission({ submittedIso: '2026-11-08' }, now)).toBe(false)
  })
})

describe('月の声かけ', () => {
  const people = [
    { memberId: 'a', name: 'A', workDays: 20, filed: false, recentMonths: 3 },
    { memberId: 'b', name: 'B', workDays: 20, filed: true, recentMonths: 3 },
    { memberId: 'c', name: 'C', workDays: 20, filed: false, recentMonths: 0 },
    { memberId: 'd', name: 'D', workDays: 0, filed: false, recentMonths: 3 },
  ]
  const rejected = [{ memberId: 'e', name: 'E', title: '10月分' }]

  test('7日までは出さない', () => {
    expect(buildMonthlyReminders({ today: '2026-11-07', settings, people, rejected })).toEqual([])
  })
  test('8日からは毎月出している人の出し忘れだけ（参考）', () => {
    const r = buildMonthlyReminders({ today: '2026-11-08', settings, people, rejected })
    expect(r.map(x => [x.memberId, x.rule, x.level])).toEqual([['a', 'M1', 'info']])
  })
  test('11日からは要確認にし、差し戻したままの申請も出す', () => {
    const r = buildMonthlyReminders({ today: '2026-11-11', settings, people, rejected })
    expect(r.map(x => [x.memberId, x.rule, x.level])).toEqual([['a', 'M2', 'confirm'], ['e', 'M2', 'confirm']])
  })
})

describe('従業員の結びつけ', () => {
  const workers = [
    { id: 11, name: '山田 太郎', payrollNo: '1001' },
    { id: 12, name: '鈴木 一郎', payrollNo: '' },
    { id: 13, name: '佐藤 二郎', payrollNo: '2000' },
    { id: 14, name: '佐藤 三郎', payrollNo: '2000' },
  ]
  const m = (mfId: string, number: string, name: string) => ({ mfId, number, name, active: true })

  test('番号が1対1で一致した人だけ自動で結ぶ（全角・前のゼロは同じ番号として見る）', () => {
    const r = linkMfMembers([m('a', '１００１', '山田太郎'), m('b', '01001x', '別人')], workers, {})
    expect(r.a).toMatchObject({ workerId: 11, how: 'number' })
    expect(r.a.nameDiffers).toBeUndefined()
    expect(r.b).toMatchObject({ workerId: null, how: null })
  })

  test('番号が重複していたら自動で結ばない', () => {
    expect(linkMfMembers([m('a', '2000', '佐藤二郎')], workers, {}).a.how).toBeNull()
    expect(linkMfMembers([m('a', '1001', '山田太郎'), m('b', '1001', '山田次郎')], workers, {}).a.how).toBeNull()
  })

  test('氏名が同じでも自動では結ばず、候補に出すだけ', () => {
    const r = linkMfMembers([m('a', '9999', '鈴木一郎')], workers, {})
    expect(r.a).toMatchObject({ workerId: null, how: null })
    expect(r.a.candidates[0]).toBe(12)
  })

  test('番号が一致して氏名が違うときは目印を付ける', () => {
    expect(linkMfMembers([m('a', '1001', 'ヤマダ タロウ')], workers, {}).a.nameDiffers).toBe(true)
  })

  test('人が決めた結びつけは同期で上書きしない', () => {
    const existing = {
      a: { mfId: 'a', number: '1001', name: 'x', active: true, workerId: 12, how: 'manual' as const, candidates: [] },
      b: { mfId: 'b', number: '', name: 'y', active: true, workerId: null, how: 'excluded' as const, candidates: [] },
    }
    const r = linkMfMembers([m('a', '1001', '山田太郎'), m('b', '', '本部の人')], workers, existing)
    expect(r.a).toMatchObject({ workerId: 12, how: 'manual' })
    expect(r.b).toMatchObject({ workerId: null, how: 'excluded' })
  })
})

describe('設定の検証', () => {
  test('既定値は通り、おかしな値は止める', () => {
    expect(mfExpenseSettingsError(settings)).toBeNull()
    expect(mfExpenseSettingsError({ ...settings, amountPct: 0 })).not.toBeNull()
    expect(mfExpenseSettingsError({ ...settings, m1Day: 12 })).not.toBeNull()
    expect(mfExpenseSettingsError({ ...settings, itemKinds: { a: 'x' as never } })).not.toBeNull()
  })
})

describe('第1段階は MF に書き込まない', () => {
  const src = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8')
  const client = src('lib/mf-expense-client.server.ts')
  const runner = src('lib/mf-expense-run.server.ts')

  test('承認・差し戻しの権限を求めない', () => {
    const scopes = /const MF_SCOPES = '([^']+)'/.exec(client)?.[1] || ''
    expect(scopes.split(' ').sort()).toEqual(['office_setting:write', 'user_setting:write'])
  })

  test('承認・差し戻しの API を呼ばない', () => {
    for (const s of [client, runner]) {
      expect(s).not.toMatch(/\/(approve|disapprove)\b/)
    }
  })

  test('POST は /oauth/ のトークンの発行と無効化だけ', () => {
    const posts = [...client.matchAll(/fetch\(`\$\{MF_ORIGIN\}([^`]*)`,\s*\{\s*method: 'POST'/g)].map(m => m[1])
    expect(posts.sort()).toEqual(['/oauth/revoke', '/oauth/token'])
    expect((client.match(/method: 'POST'/g) || []).length).toBe(2)
    expect(runner).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
  })
})
