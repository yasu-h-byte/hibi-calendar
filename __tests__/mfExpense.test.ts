/**
 * MF経費の申請の事前チェック（docs/mf-expense-check.md）の決まりと、「読むだけ」の見張り。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  DEFAULT_MF_EXPENSE_SETTINGS, buildMonthlyReminders, checkExpenseReport, linkMfMembers, mfExpenseSettingsError,
  MF_HOT_HISTORY_TTL_MS, MF_REVIEW_NOTE_MAX, isMfHistoryFresh, isSameMfSubmission, mfApprovalWaitingLabel, normalizeMfReviewNote, shiftYm, summarizeMfApprovals, targetYmOf,
  type MfExpenseSettings, type MfExpenseTx, type MfHistoryTx, type MfReportCheckInput, type MfToolContext,
} from '@/lib/mf-expense-rules'

import { buildMfRejectComment, hasMfRejectComment } from '@/lib/mf-expense-comment'

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
    expect(msg('2026-09-30')).toContain('申請の月より前')
  })
  test('同じ明細の指摘はまとめる', () => {
    const c = buildMfRejectComment({ ...base, lang: 'ja', flags: [flag('T1', 'a'), flag('R1', 'a')], txs: [t({ id: 'a', date: '2026-10-05' })] })
    expect(c.match(/・2026/g)).toHaveLength(1)
    expect(c).toContain('出面がありません')
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
