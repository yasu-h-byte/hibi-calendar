/**
 * MF経費の事前チェックの通し運転（docs/mf-expense-check.md）。
 * 偽の MF（fetch）と偽の Firestore（メモリ）で、cron の入口から保存先まで動かす。
 * 本番の Firestore・MF・Anthropic API には接続しない。登場人物と金額はすべて架空。
 *
 * サーバは UTC で動くので `TZ=UTC npx vitest run __tests__/mfExpense.integration.test.ts` でも通すこと。
 * test.fails の【不具合】は、期待どおりに動かないことを確かめたもの。直すと赤くなるので test に戻す。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ────────────────────────────────────────
//  偽の Firestore・偽の周辺モジュール
// ────────────────────────────────────────

const h = vi.hoisted(() => {
  const DELETE = { __fakeDeleteField: true }
  const docs = new Map<string, Record<string, unknown>>()
  const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && v !== DELETE
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  /** ignoreUndefinedProperties と同じく undefined は書かない（lib/firebase-admin.ts） */
  const strip = (v: unknown): unknown => {
    if (v === DELETE) return v
    if (Array.isArray(v)) return v.map(strip)
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]))
    return v
  }
  /** set(merge:true) と同じ。子のマップは深く合わせ、空のマップは置き換える */
  const deepMerge = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE) delete out[k]
      else if (isPlain(v) && Object.keys(v).length > 0 && isPlain(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v)
      else if (isPlain(v)) out[k] = deepMerge({}, v)
      else out[k] = v
    }
    return out
  }
  const hasDelete = (v: unknown): boolean => v === DELETE || (Array.isArray(v) ? v.some(hasDelete) : isPlain(v) && Object.values(v).some(hasDelete))
  const snap = (key: string) => {
    const d = docs.get(key)
    return { exists: () => d !== undefined, data: () => clone(d), id: key.split('/').pop() as string, ref: { key } }
  }
  const writeLog: { op: string; key: string }[] = []
  const write = (key: string, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    const clean = strip(data) as Record<string, unknown>
    if (!opts?.merge && hasDelete(clean)) throw new Error('deleteField は merge なしの set では使えない')
    docs.set(key, opts?.merge ? deepMerge(docs.get(key) || {}, clean) : (deepMerge({}, clean)))
    writeLog.push({ op: 'set', key })
  }
  let txChain: Promise<unknown> = Promise.resolve()
  const fs = {
    doc: (_db: unknown, coll: string, id: string) => ({ key: `${coll}/${id}` }),
    collection: (_db: unknown, name: string) => ({ collection: name }),
    query: (c: { collection: string }, ...wheres: { field: string; value: unknown }[]) => ({ collection: c.collection, wheres }),
    where: (field: string, _op: string, value: unknown) => ({ field, value }),
    orderBy: () => ({}), limit: () => ({}),
    deleteField: () => DELETE,
    getDoc: async (ref: { key: string }) => snap(ref.key),
    getDocs: async (q: { collection: string; wheres?: { field: string; value: unknown }[] }) => {
      const rows = Array.from(docs.keys())
        .filter(k => k.startsWith(`${q.collection}/`))
        .filter(k => (q.wheres || []).every(w => (docs.get(k) as Record<string, unknown>)[w.field] === w.value))
        .map(snap)
      return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (cb: (d: unknown) => void) => rows.forEach(cb) }
    },
    setDoc: async (ref: { key: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => write(ref.key, data, opts),
    updateDoc: async (ref: { key: string }, patch: Record<string, unknown>) => {
      const cur = docs.get(ref.key)
      if (!cur) throw new Error(`NOT_FOUND ${ref.key}`)
      const out = clone(cur)
      for (const [path, v] of Object.entries(strip(patch) as Record<string, unknown>)) {
        const parts = path.split('.')
        let node = out as Record<string, unknown>
        for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>
        if (v === DELETE) delete node[parts[parts.length - 1]]
        else node[parts[parts.length - 1]] = v
      }
      docs.set(ref.key, out)
      writeLog.push({ op: 'update', key: ref.key })
    },
    deleteDoc: async (ref: { key: string }) => { docs.delete(ref.key) },
    runTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      // 本物と同じく、同時に2つのトランザクションが同じ値を読んで両方通ることはない
      const run = txChain.then(() => fn({
        get: async (ref: { key: string }) => snap(ref.key),
        set: (ref: { key: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => write(ref.key, data, opts),
      }))
      txChain = run.catch(() => undefined)
      return run
    },
  }
  const data = {
    docs, writeLog,
    main: { workers: [] as unknown[], sites: [] as unknown[] },
    att: {} as Record<string, { d: Record<string, unknown> }>,
    attCalls: [] as { ym: string; cached: boolean }[],
    activity: [] as string[],
    readReceipt: null as null | ((bytes: Buffer, type: string) => Promise<unknown>),
    receiptReads: [] as string[],
    FatalReceiptError: class FatalReceiptError extends Error {},
  }
  return { fs, ...data }
})

vi.mock('@/lib/firebase', () => ({ db: { fake: true } }))
vi.mock('@/lib/fsdb', () => h.fs)
vi.mock('@/lib/activity', () => ({ logActivity: async (actor: string, _a: string, msg: string) => { h.activity.push(`${actor}:${msg}`) } }))
vi.mock('@/lib/auth', () => ({ requireCap: async () => null, actorLabel: async () => 'tester' }))
vi.mock('@/lib/compute.server', () => ({
  getMainData: async () => h.main,
  getAttData: async (ym: string) => { h.attCalls.push({ ym, cached: false }); return h.att[ym] || { d: {} } },
  getAttDataCached: async (ym: string) => { h.attCalls.push({ ym, cached: true }); return h.att[ym] || { d: {} } },
}))
vi.mock('@/lib/mf-expense-receipt.server', () => ({
  MF_RECEIPT_MODEL: 'fake-model',
  isReceiptReaderConfigured: () => !!process.env.ANTHROPIC_API_KEY,
  isReceiptFatalError: (e: unknown) => e instanceof h.FatalReceiptError,
  readReceiptFile: (b: Buffer, t: string) => {
    h.receiptReads.push(b.toString('utf8'))
    return h.readReceipt ? h.readReceipt(b, t) : Promise.resolve(JSON.parse(b.toString('utf8')))
  },
}))

import { GET as cronGET } from '@/app/api/mf-expense/cron/route'
import { GET as receiptsGET } from '@/app/api/mf-expense/receipts/route'
import { completeMfConnection } from '@/lib/mf-expense-client.server'
import { loadMfRejected, loadMfRouteTable, runMfExpenseCheck, runMfReceiptReads, saveExpenseReview, syncMfExpenseStatus } from '@/lib/mf-expense-run.server'
import { mfCheckState } from '@/lib/mf-expense-rules'

// ────────────────────────────────────────
//  偽の MF
// ────────────────────────────────────────

const HIBI = 'off-hibi'
const HFU = 'off-hfu'

interface FakeRead { readable: boolean; date: string | null; amount: number | null }
interface FakeTx {
  id: string; recognized_at: string | null; value: number; remark: string; memo: string; ex_item_id: string
  ex_item: { name: string }; mf_file: { id: string } | null; office_member_id?: string; ex_report?: { id: string; status: string }
  fileBody?: FakeRead
}
interface FakeReport {
  id: string; number: number; title: string; status: string; office_member_id: string
  submitted_at: string; updated_at: string; ex_report_approvals: unknown[]; txs: FakeTx[]
}
interface FakeOffice {
  name: string
  members: { id: string; number: string; name: string; is_active: boolean }[]
  items: { id: string; name: string; is_active: boolean }[]
  reports: FakeReport[]
}

class FakeMf {
  offices: Record<string, FakeOffice> = {
    [HIBI]: {
      name: '日比建設株式会社',
      members: [
        { id: 'm-h1', number: '1001', name: '鈴木一郎', is_active: true },
        { id: 'm-h2', number: '1002', name: '田中花子', is_active: true },
      ],
      items: [{ id: 'i-t', name: '交通費', is_active: true }, { id: 'i-g', name: 'ガソリン代', is_active: true }, { id: 'i-k', name: '道具代', is_active: true }, { id: 'i-o', name: '消耗品', is_active: true }],
      reports: [],
    },
    [HFU]: {
      name: 'エイチエフユナイテッド株式会社',
      members: [
        { id: 'm-f1', number: '3001', name: 'グエンバンアー', is_active: true },
        { id: 'm-f2', number: '', name: 'チャンティビー', is_active: true },
        { id: 'm-f3', number: '9001', name: '山本太郎', is_active: true },
      ],
      items: [{ id: 'j-t', name: '旅費交通費', is_active: true }, { id: 'j-g', name: 'ガソリン', is_active: true }],
      reports: [],
    },
  }
  access = 'access-1'
  refreshToken = 'refresh-1'
  expiresIn = 10 * 365 * 24 * 3600
  refreshCount = 0
  latencyMs = 0
  pageSize = 0
  calls: { method: string; path: string; search: string }[] = []
  /** 応答を差し替える（undefined なら普通に答える） */
  hook: ((path: string, method: string, url: URL) => Response | undefined | Promise<Response | undefined>) | null = null

  callsTo(re: RegExp) { return this.calls.filter(c => re.test(c.path)) }

  fetch = async (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method || 'GET'
    this.calls.push({ method, path: url.pathname, search: url.search })
    if (this.latencyMs) vi.setSystemTime(Date.now() + this.latencyMs)
    const hooked = await this.hook?.(url.pathname, method, url)
    if (hooked) return hooked
    if (url.pathname === '/oauth/token') return this.token(init?.body || '')
    if (url.origin !== 'https://expense.moneyforward.com') throw new Error(`よその宛先へ通信: ${url}`)
    if (init?.headers?.Authorization !== `Bearer ${this.access}`) return new Response('{}', { status: 401 })
    if (method !== 'GET') return new Response('{}', { status: 405 })
    return this.route(url)
  }

  private token(body: string): Response {
    const p = new URLSearchParams(body)
    if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') !== this.refreshToken) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      this.refreshCount++
      this.access = `access-r${this.refreshCount}`
      this.refreshToken = `refresh-r${this.refreshCount}`
    }
    return Response.json({ access_token: this.access, refresh_token: this.refreshToken, expires_in: this.expiresIn })
  }

  private list(url: URL, key: string, rows: unknown[]): Response {
    if (!this.pageSize) return Response.json({ [key]: rows })
    const page = Number(url.searchParams.get('page') || '1')
    const out: Record<string, unknown> = { [key]: rows.slice((page - 1) * this.pageSize, page * this.pageSize) }
    if (page * this.pageSize < rows.length) {
      const q = new URLSearchParams(url.search); q.set('page', String(page + 1))
      out.next = `${url.pathname}?${q.toString()}`
    }
    return Response.json(out)
  }

  private publicTx(r: FakeReport, t: FakeTx) {
    const { fileBody: _f, ...rest } = t
    return { ...rest, office_member_id: r.office_member_id, ex_report: { id: r.id, status: r.status }, secret_bank_account: '0000000' }
  }

  private route(url: URL): Response {
    if (url.pathname === '/api/external/v1/offices') return Response.json({ offices: Object.entries(this.offices).map(([id, o]) => ({ id, name: o.name })) })
    const m = url.pathname.match(/^\/api\/external\/v[12]\/offices\/([^/]+)\/(.*)$/)
    if (!m) return new Response('{}', { status: 404 })
    const o = this.offices[m[1]]
    const rest = m[2]
    if (!o) return new Response('{}', { status: 404 })
    if (rest === 'me') return Response.json({ name: '管理者' })
    if (rest === 'ex_items') return this.list(url, 'ex_items', o.items)
    if (rest === 'office_members') return this.list(url, 'office_members', o.members.map(x => ({ ...x, bank_account: 'xxx' })))
    if (rest === 'approving_ex_reports') {
      return this.list(url, 'ex_reports', o.reports.filter(r => r.status.startsWith('waiting')).map(({ txs: _t, ...r }) => r))
    }
    if (rest === 'expense_reports') {
      const from = url.searchParams.get('query_object[submitted_at_from]') || ''
      return this.list(url, 'expense_reports', o.reports.filter(r => r.submitted_at.slice(0, 10) >= from).map(({ txs: _t, ...r }) => r))
    }
    if (rest === 'ex_transactions') {
      const from = url.searchParams.get('query_object[recognized_at_from]') || ''
      const to = url.searchParams.get('query_object[recognized_at_to]') || ''
      return this.list(url, 'ex_transactions', o.reports.flatMap(r => r.txs
        .filter(t => (t.recognized_at || '').slice(0, 10) >= from && (t.recognized_at || '').slice(0, 10) <= to)
        .map(t => this.publicTx(r, t))))
    }
    let t = rest.match(/^ex_reports\/([^/]+)\/ex_transactions$/)
    if (t) {
      const r = o.reports.find(x => x.id === t![1])
      return r ? this.list(url, 'ex_transactions', r.txs.map(x => this.publicTx(r, x))) : new Response('{}', { status: 404 })
    }
    t = rest.match(/^ex_transactions\/([^/]+)\/mf_file$/)
    if (t) {
      const tx = o.reports.flatMap(r => r.txs).find(x => x.id === t![1])
      if (!tx?.fileBody) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(tx.fileBody), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    return new Response('{}', { status: 404 })
  }
}

// ────────────────────────────────────────
//  舞台
// ────────────────────────────────────────

let mf: FakeMf
const realSetTimeout = globalThis.setTimeout

const at = (jst: string) => vi.setSystemTime(new Date(`${jst}+09:00`))
const fsDoc = <T = Record<string, any>>(key: string) => h.docs.get(key) as T | undefined
const check = (id: string) => fsDoc<Record<string, any>>(`expenseChecks/${id}`)!
const rulesOf = (id: string) => (check(id).flags as { rule: string }[]).map(f => f.rule).sort()
const stateOf = (id: string) => mfCheckState(check(id) as never)
const req = (path: string) => new NextRequest(`https://hibi-calendar.vercel.app${path}`, { headers: { authorization: 'Bearer test-cron' } })
const cron = async (org?: 'hfu') => {
  const res = await cronGET(req(`/api/mf-expense/cron${org ? `?org=${org}` : ''}`))
  return { http: res.status, body: await res.json() as Record<string, any> }
}
const receipts = async () => {
  const res = await receiptsGET(req('/api/mf-expense/receipts'))
  return { http: res.status, body: await res.json() as Record<string, any> }
}

function tx(id: string, date: string | null, amount: number, item: string, remark = '', file?: { id: string; read: FakeRead }, memo = ''): FakeTx {
  const names: Record<string, string> = { 'i-t': '交通費', 'i-g': 'ガソリン代', 'i-k': '道具代', 'i-o': '消耗品', 'j-t': '旅費交通費', 'j-g': 'ガソリン' }
  return { id, recognized_at: date, value: amount, remark, memo, ex_item_id: item, ex_item: { name: names[item] || item }, mf_file: file ? { id: file.id } : null, fileBody: file?.read }
}

function report(office: string, id: string, member: string, submitted: string, txs: FakeTx[], over: Partial<FakeReport> = {}): FakeReport {
  const r: FakeReport = {
    id, number: 1, title: `${id} の申請`, status: 'waiting_step_one', office_member_id: member,
    submitted_at: `${submitted}T10:00:00+09:00`, updated_at: `${submitted}T10:00:00+09:00`, ex_report_approvals: [], txs, ...over,
  }
  mf.offices[office].reports.push(r)
  return r
}

function worked(workerId: number, site: string, ym: string, days: number[], entry: Record<string, unknown> = { w: 1 }) {
  h.att[ym] ??= { d: {} }
  for (const d of days) h.att[ym].d[`${site}_${workerId}_${ym}_${String(d).padStart(2, '0')}`] = entry
}

function settings(over: Record<string, unknown> = {}) {
  h.docs.set('mfExpense/settings', {
    hfuEnabled: false,
    itemKinds: { 'i-t': 'transit', 'i-g': 'gas', 'i-k': 'tool', 'i-o': 'other', 'j-t': 'transit', 'j-g': 'gas' },
    ...over,
  })
}

const approved = (id: string) => fsDoc<Record<string, any>>(`expenseApprovedChecks/${id}`)
const hfuKeys = () => Array.from(h.docs.keys()).filter(k => /_hfu$|\/hfu_/.test(k))
const noHfuTraffic = () => mf.callsTo(new RegExp(`/offices/${HFU}/`))

beforeEach(async () => {
  h.docs.clear(); h.writeLog.length = 0; h.attCalls.length = 0; h.activity.length = 0; h.receiptReads.length = 0
  h.readReceipt = null
  for (const k of Object.keys(h.att)) delete h.att[k]
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T07:00:00+09:00') })
  // 再試行の待ち時間は、偽の時計を進めるだけにする（45 秒の持ち時間に効くように）
  vi.stubGlobal('setTimeout', (fn: () => void, ms = 0) => { vi.setSystemTime(Date.now() + ms); return realSetTimeout(fn, 0) })
  mf = new FakeMf()
  vi.stubGlobal('fetch', mf.fetch)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  process.env.MF_EXPENSE_CLIENT_ID = 'test-client'
  process.env.MF_EXPENSE_CLIENT_SECRET = 'test-secret'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.CRON_SECRET = 'test-cron'
  h.main.workers = [
    { id: 101, name: '鈴木一郎', org: 'hibi', visa: 'none', job: 'tobi', payrollNo: '1001', hireDate: '2020-01-01' },
    { id: 102, name: '田中花子', org: '日比', visa: 'none', job: 'tobi', payrollNo: '1002', hireDate: '2020-01-01' },
    { id: 301, name: 'グエンバンアー', org: 'hfu', visa: 'jisshu2', job: 'tobi', payrollNo: '3001', hireDate: '2024-01-01' },
    { id: 302, name: 'チャンティビー', org: 'HFU', visa: 'jisshu1', job: 'tobi', payrollNo: '', hireDate: '2025-01-01' },
    { id: 303, name: '特定一号', org: 'hfu', visa: 'tokutei1', job: 'tobi', payrollNo: '3999', hireDate: '2024-01-01' },
  ]
  h.main.sites = [{ id: 'siteA', name: 'A現場' }, { id: 'siteB', name: 'B現場' }]
  settings()
  mf.expiresIn = 10 * 365 * 24 * 3600
  await completeMfConnection('code', '代表')
  mf.calls.length = 0
  h.writeLog.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ────────────────────────────────────────
//  1. 日比建設だけ
// ────────────────────────────────────────

describe('1. 日比建設だけ（hfuEnabled=false）', () => {
  function stage() {
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [
      tx('t1', '2026-10-05', 500, 'i-t', '秋津~笹塚 往復電車代'),
      tx('t2', '2026-10-06', 500, 'i-t', '秋津~笹塚 往復電車代', { id: 'f2', read: { readable: true, date: '2026-10-06', amount: 500 } }),
      tx('g1', '2026-10-07', 4000, 'i-g', 'ガソリン給油', { id: 'fg', read: { readable: true, date: '2026-10-07', amount: 4000 } }),
    ])
    report(HIBI, 'r2', 'm-h2', '2026-11-06', [tx('t3', '2026-10-08', 3000, 'i-o', '養生テープ', { id: 'f3', read: { readable: true, date: '2026-10-08', amount: 3000 } })])
    worked(101, 'siteA', '202610', [5, 6, 7])
    worked(102, 'siteA', '202610', [8])
  }

  test('朝の一連 7:00 → 7:10 → 7:20 → 再チェック → 7:40、HFU には触らない', async () => {
    stage()
    at('2026-11-10T07:00:00')
    const first = await cron()
    expect(first.http).toBe(200)
    expect(first.body).toMatchObject({ ok: true, status: 'done', summary: { open: 2, flagged: 0, fetched: 2 } })
    expect(check('r1')).toMatchObject({ org: 'hibi', workerId: 101, open: true, targetYm: '202610', receiptPending: 2, confirmCount: 0, total: 5000, commentLang: 'ja' })
    expect(stateOf('r1')).toBe('receipt')
    expect(JSON.stringify(check('r1'))).not.toContain('secret_bank_account')
    expect(JSON.stringify(fsDoc('mfExpense/members'))).not.toContain('bank_account')

    at('2026-11-10T07:10:00')
    const before = mf.calls.length
    expect((await cron()).body.status).toBe('skipped')
    expect(mf.calls.length).toBe(before)

    at('2026-11-10T07:20:00')
    const rc = await receipts()
    expect(rc.body).toMatchObject({ ok: true, status: 'done', read: 3, remaining: 0 })
    expect(check('r1').receiptPending).toBe(0)
    expect(check('r2').receiptPending).toBe(0)
    expect(stateOf('r1')).toBe('clean')
    expect(check('r1').txs.find((t: { id: string }) => t.id === 't2').receipt).toEqual({ readable: true, date: '2026-10-06', amount: 500 })

    at('2026-11-10T07:40:00')
    const n = h.receiptReads.length
    const last = await receipts()
    expect(last.body).toMatchObject({ ok: true, read: 0, remaining: 0 })
    expect(h.receiptReads.length).toBe(n)

    expect(hfuKeys()).toEqual([])
    expect(noHfuTraffic()).toEqual([])
    expect(Array.from(h.docs.values()).some(d => (d as { org?: string }).org === 'hfu')).toBe(false)
  })

  test('?org=hfu の cron は何もしない', async () => {
    stage()
    const r = await cron('hfu')
    expect(r.body).toMatchObject({ ok: true, status: 'skipped', summary: null })
    expect(mf.calls).toEqual([])
    expect(h.writeLog).toEqual([])
    expect(hfuKeys()).toEqual([])
  })

  test('合言葉なしの cron は通さない', async () => {
    const res = await cronGET(new NextRequest('https://x.test/api/mf-expense/cron'))
    expect(res.status).toBe(401)
    expect(mf.calls).toEqual([])
  })

  test('MF には GET しかしない（トークンの更新を除く）', async () => {
    stage()
    await cron()
    await receipts()
    expect(mf.calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  test('ページ送り（relative な next）も全部読む', async () => {
    stage()
    for (let i = 0; i < 5; i++) report(HIBI, `p${i}`, 'm-h2', '2026-11-06', [tx(`pt${i}`, '2026-10-08', 100, 'i-t', '')])
    worked(102, 'siteA', '202610', [8])
    mf.pageSize = 2
    const r = await cron()
    expect(r.body.summary.open).toBe(7)
  })
})

// ────────────────────────────────────────
//  2. 2社で動かす
// ────────────────────────────────────────

describe('2. 2社（hfuEnabled=true）', () => {
  function stage() {
    settings({ hfuEnabled: true })
    report(HIBI, 'h1', 'm-h1', '2026-12-05', [tx('th1', '2026-11-05', 500, 'i-t', '清瀬~池袋 往復電車代', { id: 'fh1', read: { readable: true, date: '2026-11-05', amount: 500 } })])
    report(HFU, 'f1', 'm-f1', '2026-12-05', [tx('tf1', '2026-11-06', 700, 'j-t', '新小岩~亀戸 往復電車代', { id: 'ff1', read: { readable: true, date: '2026-11-06', amount: 700 } })])
    worked(101, 'siteA', '202611', [5])
    worked(301, 'siteB', '202611', [6])
    at('2026-12-10T07:00:00')
  }

  test('7:00 → 7:05 → 7:10 → 7:15 → 7:20 で、保存先も読み先も混ざらない', async () => {
    stage()
    expect((await cron()).body).toMatchObject({ status: 'done', summary: { open: 1 } })
    expect(noHfuTraffic()).toEqual([])
    expect(check('h1').org).toBe('hibi')
    expect(fsDoc('expenseChecks/f1')).toBeUndefined()

    at('2026-12-10T07:05:00')
    expect((await cron('hfu')).body).toMatchObject({ status: 'done', summary: { open: 1 } })
    expect(check('f1')).toMatchObject({ org: 'hfu', workerId: 301, commentLang: 'vi', open: true })
    expect(check('h1').open).toBe(true)
    expect(fsDoc('mfExpense/members_hfu')!.members['m-f1'].workerId).toBe(301)
    expect(fsDoc('mfExpense/members')!.members['m-f1']).toBeUndefined()
    expect(fsDoc('mfExpense/members_hfu')!.members['m-h1']).toBeUndefined()
    expect(fsDoc('mfExpense/items_hfu')!.items.map((i: { id: string }) => i.id)).toEqual(['j-t', 'j-g'])
    expect(fsDoc('expenseHistory/hfu_202611')!.rows.map((r: { id: string }) => r.id)).toEqual(['tf1'])
    expect(fsDoc('expenseHistory/202611')!.rows.map((r: { id: string }) => r.id)).toEqual(['th1'])
    expect(fsDoc('mfExpense/runState_hfu')!.completedDate).toBe('2026-12-10')
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2026-12-10')

    at('2026-12-10T07:10:00')
    expect((await cron()).body.status).toBe('skipped')
    at('2026-12-10T07:15:00')
    expect((await cron('hfu')).body.status).toBe('skipped')

    at('2026-12-10T07:20:00')
    mf.calls.length = 0
    const rc = await receipts()
    expect(rc.body).toMatchObject({ read: 2, remaining: 0, ok: true })
    const files = mf.callsTo(/mf_file$/).map(c => c.path).sort()
    expect(files).toEqual([
      `/api/external/v1/offices/${HFU}/ex_transactions/tf1/mf_file`,
      `/api/external/v1/offices/${HIBI}/ex_transactions/th1/mf_file`,
    ])
    expect(check('h1').receiptPending).toBe(0)
    expect(check('f1').receiptPending).toBe(0)
    expect(check('h1').org).toBe('hibi')
    expect(check('f1').org).toBe('hfu')
  })

  test('片方の実行は、もう片方の申請を閉じない', async () => {
    stage()
    await cron()
    await cron('hfu')
    // 日比の申請が承認待ちから消えた。HFU の実行では閉じず、日比の実行で閉じる
    mf.offices[HIBI].reports[0].status = 'approved'
    await runMfExpenseCheck({ actor: 't', force: true, org: 'hfu' })
    expect(check('h1').open).toBe(true)
    await runMfExpenseCheck({ actor: 't', force: true })
    expect(check('h1').open).toBe(false)
    expect(check('f1').open).toBe(true)
    // 逆も同じ
    mf.offices[HFU].reports[0].status = 'approved'
    await runMfExpenseCheck({ actor: 't', force: true })
    expect(check('f1').open).toBe(true)
    await runMfExpenseCheck({ actor: 't', force: true, org: 'hfu' })
    expect(check('f1').open).toBe(false)
  })

  test('会社ごとにロックと完了日が別', async () => {
    stage()
    h.docs.set('mfExpense/runState', { runningUntil: Date.now() + 60_000 })
    expect((await cron()).body.status).toBe('busy')
    expect((await cron('hfu')).body.status).toBe('done')
  })
})

// ────────────────────────────────────────
//  3. HFU の絞り込み
// ────────────────────────────────────────

describe('3. HFU の絞り込み', () => {
  function stage() {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:05:00')
    worked(301, 'siteB', '202611', [6])
    report(HFU, 'linked', 'm-f1', '2026-12-05', [tx('a1', '2026-11-06', 700, 'j-t', '')])
    report(HFU, 'cand', 'm-f2', '2026-12-05', [tx('a2', '2026-11-07', 800, 'j-t', '')])
    report(HFU, 'honbu', 'm-f3', '2026-12-05', [tx('a3', '2026-11-08', 9000, 'j-t', '本部の出張 新幹線')])
    report(HFU, 'oct', 'm-f1', '2026-11-05', [tx('a4', '2026-10-06', 700, 'j-t', '')])
  }

  test('実習生・候補のいる人だけ保存し、本部の人の申請の明細は要求しない', async () => {
    stage()
    const r = await cron('hfu')
    expect(r.body).toMatchObject({ status: 'done', summary: { open: 2 } })
    expect(check('linked')).toMatchObject({ org: 'hfu', workerId: 301 })
    expect(check('cand')).toMatchObject({ org: 'hfu', workerId: null })
    expect(rulesOf('cand')).toContain('U1')
    expect(fsDoc('expenseChecks/honbu')).toBeUndefined()
    expect(mf.callsTo(/ex_reports\/honbu\/ex_transactions/)).toEqual([])
    expect(fsDoc('expenseChecks/oct')).toBeUndefined()
    const link = fsDoc('mfExpense/members_hfu')!.members
    expect(link['m-f2'].candidates).toEqual([302])
    expect(link['m-f3'].candidates).toEqual([])
  })

  test('特定技能の人（HFU）は結びつけの対象にならない', async () => {
    stage()
    mf.offices[HFU].members.push({ id: 'm-f4', number: '3999', name: '特定一号', is_active: true })
    report(HFU, 'tokutei', 'm-f4', '2026-12-05', [tx('a5', '2026-11-09', 500, 'j-t', '')])
    await cron('hfu')
    expect(fsDoc('mfExpense/members_hfu')!.members['m-f4'].workerId).toBeNull()
    expect(fsDoc('expenseChecks/tokutei')).toBeUndefined()
  })

  test.fails('【不具合】本部の人の明細は、月の控え（expenseHistory）にも残さない（docs:「本部・不動産の明細は読まない」）', async () => {
    stage()
    await cron('hfu')
    const rows = fsDoc('expenseHistory/hfu_202611')!.rows as { memberId: string }[]
    expect(rows.map(r => r.memberId)).not.toContain('m-f3')
  })

  test.fails('【不具合】対象外の10月分の申請を、毎回 MF に読みに行かない', async () => {
    stage()
    await cron('hfu')
    await runMfExpenseCheck({ actor: 't', force: true, org: 'hfu' })
    expect(mf.callsTo(/ex_reports\/oct\/ex_transactions/).length).toBeLessThanOrEqual(1)
  })

  test('11月の月末に出した11月分の申請は保存される', async () => {
    settings({ hfuEnabled: true })
    at('2026-11-30T07:05:00')
    worked(301, 'siteB', '202611', [6])
    report(HFU, 'nov', 'm-f1', '2026-11-29', [tx('a1', '2026-11-06', 700, 'j-t', '')])
    await cron('hfu')
    expect(check('nov')).toMatchObject({ targetYm: '202611', org: 'hfu' })
  })

  test.fails('【不具合】11月分の申請の明細が読めなくても、X1 として一覧に出る', async () => {
    settings({ hfuEnabled: true })
    at('2026-11-30T07:05:00')
    report(HFU, 'nov404', 'm-f1', '2026-11-29', [tx('a1', '2026-11-06', 700, 'j-t', '')])
    mf.hook = p => (p.endsWith('/ex_reports/nov404/ex_transactions') ? new Response('{}', { status: 404 }) : undefined)
    await cron('hfu')
    expect(fsDoc('expenseChecks/nov404')).toBeDefined()
  })

  test.fails('【不具合】M2 の差し戻し一覧に本部の人を出さない', async () => {
    settings({ hfuEnabled: true })
    at('2026-12-11T07:05:00')
    report(HFU, 'rej', 'm-f3', '2026-12-05', [tx('a3', '2026-11-08', 9000, 'j-t', '')], { status: 'rejected' })
    report(HFU, 'rej2', 'm-f1', '2026-12-05', [tx('a4', '2026-11-08', 900, 'j-t', '')], { status: 'rejected' })
    await cron('hfu')
    const names = (fsDoc('mfExpense/reminders_hfu')!.entries as { memberId: string }[]).map(e => e.memberId)
    expect(names).toContain('m-f1')
    expect(names).not.toContain('m-f3')
  })

  test.fails('【不具合】対象が11月分からなので、10月分の出し忘れは声をかけない', async () => {
    settings({ hfuEnabled: true })
    at('2026-11-08T07:05:00')
    worked(301, 'siteB', '202610', [6])
    report(HFU, 'aug', 'm-f1', '2026-09-05', [tx('b1', '2026-08-06', 700, 'j-t', '')], { status: 'approved' })
    report(HFU, 'sep', 'm-f1', '2026-10-05', [tx('b2', '2026-09-06', 700, 'j-t', '')], { status: 'approved' })
    await cron('hfu')
    expect(fsDoc('mfExpense/reminders_hfu')!.entries).toEqual([])
  })
})

// ────────────────────────────────────────
//  4. 区間の比較
// ────────────────────────────────────────

describe('4. 区間の比較は2社一緒', () => {
  const ROUTE = '秋津~笹塚 往復電車代'
  function stage() {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:00:00')
    report(HIBI, 'h1', 'm-h1', '2026-12-05', [tx('h-a', '2026-11-05', 1000, 'i-t', ROUTE), tx('h-b', '2026-11-06', 1000, 'i-t', ROUTE)])
    report(HFU, 'f1', 'm-f1', '2026-12-05', [tx('f-a', '2026-11-05', 800, 'j-t', ROUTE), tx('f-b', '2026-11-06', 800, 'j-t', ROUTE)])
    report(HFU, 'f2', 'm-f2', '2026-12-05', [tx('f-c', '2026-11-05', 500, 'j-t', ROUTE), tx('f-d', '2026-11-06', 500, 'j-t', ROUTE)])
    report(HFU, 'f3', 'm-f3', '2026-12-05', [tx('f-e', '2026-11-05', 300, 'j-t', ROUTE), tx('f-f', '2026-11-06', 300, 'j-t', ROUTE)])
    worked(101, 'siteA', '202611', [5, 6])
    worked(301, 'siteB', '202611', [5, 6])
  }

  test('最安は2社の結びついた人だけ。未結びつけ・本部の金額は混ざらない', async () => {
    stage()
    await cron()
    at('2026-12-10T07:05:00')
    await cron('hfu')
    await runMfExpenseCheck({ actor: 't', force: true })
    const key = '秋津~笹塚 往復'
    const t6 = (check('h1').flags as { rule: string; usual?: number }[]).find(f => f.rule === 'T6')
    expect(t6?.usual).toBe(800)
    const table = await loadMfRouteTable()
    const row = table['202611'].find(r => r.route === key)!
    expect(row.min).toBe(800)
    expect(row.entries.map(e => [e.name, e.amount, e.lines])).toEqual([['鈴木一郎', 1000, 2], ['グエンバンアー', 800, 2]])
    expect(row.excess).toBe(400)
  })

  test('HFU の実行の後も、表は2社分（後から書いた方に潰されない）', async () => {
    stage()
    await cron()
    at('2026-12-10T07:05:00')
    await cron('hfu')
    const row = (await loadMfRouteTable())['202611'][0]
    expect(row.entries.map(e => e.name).sort()).toEqual(['グエンバンアー', '鈴木一郎'].sort())
    expect(row.entries.map(e => e.name)).not.toContain('（不明）')
  })

  test('hfuEnabled=false なら、控えが残っていても HFU を混ぜない', async () => {
    stage()
    await cron()
    at('2026-12-10T07:05:00')
    await cron('hfu')
    settings({ hfuEnabled: false })
    await runMfExpenseCheck({ actor: 't', force: true })
    const row = (await loadMfRouteTable())['202611'][0]
    expect(row.min).toBe(1000)
    expect(row.entries.map(e => e.name)).toEqual(['鈴木一郎'])
  })

  test('初日の 7:00 の日比は HFU の控えがまだ無い。領収書の再チェックが無くても翌朝には比較に入る', async () => {
    stage()
    await cron()
    expect(rulesOf('h1')).not.toContain('T6')
    at('2026-12-10T07:05:00')
    await cron('hfu')
    at('2026-12-10T07:10:00')
    await cron()
    expect(rulesOf('h1')).not.toContain('T6') // 7:10 は完了済みで skipped（同じ朝のうちは入らない）
    at('2026-12-11T07:00:00')
    await cron()
    expect(rulesOf('h1')).toContain('T6')
  })
})

// ────────────────────────────────────────
//  5. 途中失敗
// ────────────────────────────────────────

describe('5. 途中失敗', () => {
  function six(day = '2026-11-05') {
    for (let i = 1; i <= 6; i++) report(HIBI, `r${i}`, 'm-h2', day, [tx(`t${i}`, '2026-10-08', 100 * i, 'i-t', '')])
    worked(102, 'siteA', '202610', [8])
  }

  test('45 秒で区切り partial、7:10 で続きを読む', async () => {
    six()
    mf.latencyMs = 4000 // items, members, 控え5か月, 一覧 = 8回で 32 秒。明細は 4 通目で 45 秒を超える
    const first = await cron()
    expect(first.body).toMatchObject({ ok: true, status: 'partial' })
    expect(first.body.summary.fetched).toBeGreaterThan(0)
    expect(first.body.summary.fetched).toBeLessThan(6)
    const state = fsDoc('mfExpense/runState')!
    expect(state.partial).toBe(true)
    expect(state.completedDate ?? null).toBeNull()
    expect(state.runningUntil).toBe(0)

    at('2026-11-10T07:10:00')
    mf.latencyMs = 100
    const second = await cron()
    expect(second.body).toMatchObject({ ok: true, status: 'done' })
    expect(second.body.summary.open).toBe(6)
    expect(second.body.summary.fetched).toBe(6 - first.body.summary.fetched)
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2026-11-10')
    for (let i = 1; i <= 6; i++) expect(check(`r${i}`).open).toBe(true)
  })

  test('控えの読み込み中に時間切れでも partial になり、ロックは外れる', async () => {
    six()
    mf.latencyMs = 15_000
    const r = await cron()
    expect(r.body).toMatchObject({ ok: true, status: 'partial' })
    expect(fsDoc('mfExpense/runState')!.runningUntil).toBe(0)
    expect(fsDoc('mfExpense/runState')!.lastError).toBeNull()
  })

  test('M2 の差し戻し一覧の直前で時間切れでも、続きの回で声かけまで終わる', async () => {
    at('2026-11-12T07:00:00')
    six('2026-11-09')
    report(HIBI, 'rj', 'm-h2', '2026-11-09', [], { status: 'rejected' })
    // 全部の読みが終わった直後に持ち時間を使い切る
    mf.hook = (p) => { if (p.endsWith('/ex_reports/r6/ex_transactions')) vi.setSystemTime(Date.now() + 46_000); return undefined }
    const first = await cron()
    expect(first.body.status).toBe('partial')
    for (let i = 1; i <= 6; i++) expect(check(`r${i}`).open).toBe(true)
    at('2026-11-12T07:10:00')
    mf.hook = null
    expect((await cron()).body.status).toBe('done')
    expect((fsDoc('mfExpense/reminders')!.entries as { rule: string }[]).some(e => e.rule === 'M2')).toBe(true)
  })

  test('1件の明細だけ 404: X1 で残り、他は読み、次の回に読み直す', async () => {
    six()
    mf.hook = p => (p.endsWith('/ex_reports/r3/ex_transactions') ? new Response('{}', { status: 404 }) : undefined)
    const r = await cron()
    expect(r.body).toMatchObject({ ok: true, status: 'done', summary: { open: 6, fetched: 5, flagged: 1 } })
    expect(rulesOf('r3')).toEqual(['X1'])
    expect(check('r3').updatedAt).toBe('')
    expect(stateOf('r3')).toBe('confirm')
    mf.hook = null
    at('2026-11-11T07:00:00')
    await cron()
    expect(rulesOf('r3')).not.toContain('X1')
    expect(check('r3').total).toBe(300)
    expect(check('r3').updatedAt).not.toBe('')
  })

  test('読めなかったとき、前回の明細があれば消さない', async () => {
    six()
    await cron()
    mf.offices[HIBI].reports[2].updated_at = '2026-11-10T20:00:00+09:00'
    mf.hook = p => (p.endsWith('/ex_reports/r3/ex_transactions') ? new Response('{}', { status: 500 }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r3').total).toBe(300)
    expect(rulesOf('r3')).toEqual(['X1'])
  })

  test('MF が 503 を返し続ける: error で止まり、既存は壊さず、ロックは外れる', async () => {
    six()
    await cron()
    const open = check('r1').open
    mf.hook = (p, m) => (m === 'GET' ? new Response('{}', { status: 503 }) : undefined)
    at('2026-11-11T07:00:00')
    mf.calls.length = 0
    const r = await cron()
    expect(r.http).toBe(500)
    expect(r.body).toMatchObject({ ok: false, status: 'error' })
    expect(mf.calls.length).toBe(3) // 最初の呼び出しを 3 回試して諦める
    expect(check('r1').open).toBe(open)
    const st = fsDoc('mfExpense/runState')!
    expect(st.runningUntil).toBe(0)
    expect(st.lastError).toContain('503')
    expect(st.completedDate).toBe('2026-11-10')
  })

  test('明細だけ 503 が続く: 再試行の待ちで時間切れになっても partial で落ちない', async () => {
    for (let i = 1; i <= 20; i++) report(HIBI, `r${i}`, 'm-h2', '2026-11-05', [tx(`t${i}`, '2026-10-08', 100, 'i-t', '')])
    mf.hook = p => (/\/ex_reports\/.*\/ex_transactions$/.test(p) ? new Response('{}', { status: 503 }) : undefined)
    const r = await cron()
    expect(r.body).toMatchObject({ ok: true, status: 'partial' })
    expect(fsDoc('mfExpense/runState')!.runningUntil).toBe(0)
  })

  test('トークン切れは更新して続ける（新しいトークンを保存する）', async () => {
    six()
    const old = fsDoc('mfExpenseSecrets/connection')!.enc
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    const r = await cron()
    expect(r.body.status).toBe('done')
    expect(mf.refreshCount).toBe(1)
    const conn = fsDoc('mfExpenseSecrets/connection')!
    expect(conn.enc).not.toBe(old)
    expect(conn.needsReconnect).toBe(false)
    expect(JSON.stringify(conn)).not.toContain('access-r1')
    expect(JSON.stringify(conn)).not.toContain('refresh-r1')
  })

  test('途中で 401 になったら更新して読み直す。HFU の道具も同じトークンを使う', async () => {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:05:00')
    report(HFU, 'f1', 'm-f1', '2026-12-05', [tx('a', '2026-11-06', 700, 'j-t', '')])
    let revoked = false
    mf.hook = p => {
      if (!revoked && p.endsWith('/approving_ex_reports')) { revoked = true; mf.access = 'rotated-by-mf' }
      return undefined
    }
    const r = await cron('hfu')
    expect(r.body.status).toBe('done')
    expect(mf.refreshCount).toBe(1)
  })

  test('refresh の失敗（invalid_grant）: notConnected で、つなぎ直しの印が付き、申請は閉じない', async () => {
    six()
    await cron()
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    mf.refreshToken = 'revoked-on-mf'
    at('2026-11-11T07:00:00')
    const r = await cron()
    expect(r.http).toBe(500)
    expect(r.body).toMatchObject({ ok: false, status: 'notConnected' })
    expect(fsDoc('mfExpenseSecrets/connection')!.needsReconnect).toBe(true)
    expect(check('r1').open).toBe(true)
    expect(fsDoc('mfExpense/runState')!.runningUntil).toBe(0)
  })

  test('refresh の一時的な 503 では、つなぎ直しの印を付けない', async () => {
    six()
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    mf.hook = (p, m) => (p === '/oauth/token' && m === 'POST' ? new Response('{}', { status: 503 }) : undefined)
    const r = await cron()
    expect(r.body.status).toBe('error')
    expect(fsDoc('mfExpenseSecrets/connection')!.needsReconnect).toBe(false)
  })

  test('refresh が一度失敗しても、次に成功すれば印は消える', async () => {
    six()
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    mf.hook = (p, m) => (p === '/oauth/token' && m === 'POST' ? new Response('{}', { status: 503 }) : undefined)
    await cron()
    mf.hook = null
    at('2026-11-10T07:10:00')
    expect((await cron()).body.status).toBe('done')
    expect(fsDoc('mfExpenseSecrets/connection')!.needsReconnect).toBe(false)
  })

  test('Client Secret を替えると notConnected', async () => {
    process.env.MF_EXPENSE_CLIENT_SECRET = 'other'
    const r = await cron()
    expect(r.body.status).toBe('notConnected')
    expect(fsDoc('mfExpenseSecrets/connection')!.needsReconnect).toBe(true)
  })

  test.each([
    ['2026-11-10T01:00:00', true], ['2026-11-10T03:30:00', true], ['2026-11-10T05:59:59', true],
    ['2026-11-10T00:59:59', false], ['2026-11-10T06:00:00', false],
  ])('メンテナンス時間 %s → %s', async (time, blocked) => {
    six()
    at(time)
    const r = await runMfExpenseCheck({ actor: 't', force: true })
    const rc = await runMfReceiptReads()
    if (blocked) {
      expect(r).toMatchObject({ ok: false, status: 'maintenance' })
      expect(rc.status).toBe('maintenance')
      expect(mf.calls).toEqual([])
      expect(fsDoc('mfExpense/runState')).toBeUndefined()
    } else {
      expect(r.ok).toBe(true)
      expect(rc.status).toBe('done')
    }
  })

  test('ロック中の二重起動は busy で MF に行かず、持ち主のロックを消さない', async () => {
    six()
    h.docs.set('mfExpense/runState', { runningUntil: Date.now() + 30_000 })
    const r = await cron()
    expect(r.body.status).toBe('busy')
    expect(mf.calls).toEqual([])
    expect(fsDoc('mfExpense/runState')!.runningUntil).toBeGreaterThan(Date.now())
  })

  test('本当に同時に2つ動かしても片方だけ', async () => {
    six()
    const [a, b] = await Promise.all([runMfExpenseCheck({ actor: 'a', force: true }), runMfExpenseCheck({ actor: 'b', force: true })])
    expect([a.status, b.status].sort()).toEqual(['busy', 'done'])
    expect(mf.callsTo(/ex_reports\/r1\/ex_transactions/).length).toBe(1)
  })

  test('期限切れのロックは取り直せる', async () => {
    six()
    h.docs.set('mfExpense/runState', { runningUntil: Date.now() - 1 })
    expect((await cron()).body.status).toBe('done')
  })

  test('差し戻し一覧が読めなくても done で、声かけに1行', async () => {
    at('2026-11-11T07:00:00')
    six()
    mf.hook = p => (p.endsWith('/expense_reports') ? new Response('{}', { status: 500 }) : undefined)
    const r = await cron()
    expect(r.body.status).toBe('done')
    const e = fsDoc('mfExpense/reminders')!.entries as { name: string; rule: string }[]
    expect(e).toContainEqual(expect.objectContaining({ rule: 'M2', name: '確認できません' }))
  })

  test('空の従業員一覧: 手で決めた結びつけを消さない', async () => {
    six()
    await cron()
    fsDoc('mfExpense/members')!.members['m-h1'].how = 'manual'
    mf.hook = p => (p.endsWith('/office_members') ? Response.json({ office_members: [] }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(fsDoc('mfExpense/members')!.members['m-h1'].how).toBe('manual')
    expect(check('r1').workerId).toBe(102)
  })

  test('空の科目一覧: 控えを消さない', async () => {
    six()
    await cron()
    mf.hook = p => (p.endsWith('/ex_items') ? Response.json({ ex_items: [] }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(fsDoc('mfExpense/items')!.items.length).toBe(4)
  })

  test('空の明細の控え: 上書きしない', async () => {
    six()
    await cron()
    const rows = fsDoc('expenseHistory/202610')!.rows.length
    expect(rows).toBe(6)
    mf.hook = p => (p.endsWith('/ex_transactions') && !p.includes('ex_reports') ? Response.json({ ex_transactions: [] }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(fsDoc('expenseHistory/202610')!.rows.length).toBe(rows)
  })

  test('本当に空の承認待ち一覧: 全部閉じ、翌日戻ればそのまま開く', async () => {
    six()
    await cron()
    mf.hook = p => (p.endsWith('/approving_ex_reports') ? Response.json({ ex_reports: [] }) : undefined)
    at('2026-11-11T07:00:00')
    const r = await cron()
    expect(r.body.status).toBe('done')
    expect(check('r1').open).toBe(false)
    mf.hook = null
    at('2026-11-12T07:00:00')
    mf.calls.length = 0
    await cron()
    expect(check('r1').open).toBe(true)
    expect(mf.callsTo(/ex_reports\/r1\/ex_transactions/)).toEqual([])
  })

  test('未接続の cron は静かに終わる', async () => {
    h.docs.delete('mfExpenseSecrets/connection')
    expect((await cron()).body).toMatchObject({ ok: true, status: 'notConnected' })
    expect((await receipts()).body).toMatchObject({ ok: true, status: 'notConnected' })
    expect(mf.calls).toEqual([])
  })

  test('HFU の partial も 7:15 で続く', async () => {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:05:00')
    for (let i = 1; i <= 6; i++) report(HFU, `f${i}`, 'm-f1', '2026-12-05', [tx(`tf${i}`, '2026-11-08', 100 * i, 'j-t', '')])
    mf.latencyMs = 4000
    const first = await cron('hfu')
    expect(first.body.status).toBe('partial')
    expect(fsDoc('mfExpense/runState_hfu')!.partial).toBe(true)
    expect(fsDoc('mfExpense/runState')).toBeUndefined()
    at('2026-12-10T07:15:00')
    mf.latencyMs = 100
    expect((await cron('hfu')).body).toMatchObject({ status: 'done', summary: { open: 6 } })
  })

  test('事業者に HFU が無い接続: HFU は error、日比の領収書は読む', async () => {
    settings({ hfuEnabled: true })
    h.docs.get('mfExpenseSecrets/connection')!.offices = [{ id: HIBI, name: '日比建設株式会社' }]
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [tx('t1', '2026-10-05', 500, 'i-t', '', { id: 'f1', read: { readable: true, date: '2026-10-05', amount: 500 } })])
    worked(101, 'siteA', '202610', [5])
    await cron()
    const r = await cron('hfu')
    expect(r.http).toBe(500)
    expect(r.body.message).toContain('HFU')
    expect((await receipts()).body).toMatchObject({ ok: true, read: 1 })
  })

  test.fails('【不具合】控えの1か月だけ読めなくても、申請のチェックは止めない', async () => {
    six()
    await cron()
    mf.hook = (p, _m, url) => (p.endsWith('/ex_transactions') && !p.includes('ex_reports') && url.search.includes('2026-11-01') ? new Response('{}', { status: 500 }) : undefined)
    report(HIBI, 'new1', 'm-h2', '2026-11-11', [tx('n1', '2026-10-08', 999, 'i-t', '')])
    at('2026-11-11T07:00:00')
    const r = await cron()
    expect(r.body.ok).toBe(true)
    expect(fsDoc('expenseChecks/new1')).toBeDefined()
  })

  test('承認待ち一覧の項目ごと無い応答（形が違う）では、全部閉じない', async () => {
    six()
    await cron()
    mf.hook = p => (p.endsWith('/approving_ex_reports') ? Response.json({ error: 'temporarily unavailable' }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r1').open).toBe(true)
  })

  test('一覧の2ページ目だけ失敗したら、残りの申請を閉じない', async () => {
    six()
    await cron()
    mf.pageSize = 2
    mf.hook = (p, _m, url) => (p.endsWith('/approving_ex_reports') && url.searchParams.get('page') === '2' ? new Response('{}', { status: 500 }) : undefined)
    at('2026-11-11T07:00:00')
    const r = await cron()
    expect(r.body.status).toBe('error')
    expect(check('r6').open).toBe(true)
  })
})

// ────────────────────────────────────────
//  6. 確認メモ
// ────────────────────────────────────────

describe('6. 確認メモ', () => {
  function stage() {
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [
      tx('t1', '2026-10-05', 500, 'i-t', ''),
      tx('t2', '2026-10-06', 500, 'i-t', ''),
    ])
    worked(101, 'siteA', '202610', [6, 7]) // 10/5 は出面なし → T1（その月に出面がある人だけ見る）
  }

  test('付ける → 翌朝も残る → 指摘が増えて要確認に戻る → 出し直しで消える', async () => {
    stage()
    await cron()
    expect(rulesOf('r1')).toEqual(['T1'])
    expect(stateOf('r1')).toBe('confirm')

    expect(await saveExpenseReview('r1', '休日出勤の振替で確認済み', 'super-admin')).toBe('鈴木一郎')
    expect(check('r1').review).toMatchObject({ note: '休日出勤の振替で確認済み', byName: '日比靖仁', flagKeys: ['T1:t1'] })
    expect(stateOf('r1')).toBe('reviewed')

    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r1').review?.note).toBe('休日出勤の振替で確認済み')
    expect(stateOf('r1')).toBe('reviewed')

    // 出面が消えて指摘が増える
    delete h.att['202610'].d['siteA_101_202610_06']
    at('2026-11-12T07:00:00')
    await cron()
    expect(rulesOf('r1')).toEqual(['T1', 'T1'])
    expect(check('r1').review).toBeDefined()
    expect(stateOf('r1')).toBe('confirm')

    // 出し直し（提出日時が変わる）
    const r = mf.offices[HIBI].reports[0]
    r.submitted_at = '2026-11-12T12:00:00+09:00'
    r.updated_at = '2026-11-12T12:00:00+09:00'
    at('2026-11-13T07:00:00')
    await cron()
    expect(check('r1').review).toBeUndefined()
    expect(stateOf('r1')).toBe('confirm')
  })

  test('一覧から消えて戻っても確認メモは残る', async () => {
    stage()
    await cron()
    await saveExpenseReview('r1', 'メモ', 'super-admin')
    const r = mf.offices[HIBI].reports[0]
    r.status = 'waiting_step_two_hidden'
    mf.hook = p => (p.endsWith('/approving_ex_reports') ? Response.json({ ex_reports: [] }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r1').open).toBe(false)
    expect(check('r1').review?.note).toBe('メモ')
    // 閉じている間は確認メモを受け付けない
    expect(await saveExpenseReview('r1', 'x', 'super-admin')).toBeNull()

    mf.hook = null
    r.status = 'waiting_step_two'
    at('2026-11-12T07:00:00')
    await cron()
    expect(check('r1').open).toBe(true)
    expect(check('r1').review?.note).toBe('メモ')
    expect(stateOf('r1')).toBe('reviewed')
  })

  test('承認の段階が進んで updated_at だけ変わった申請は、メモを消さない', async () => {
    stage()
    await cron()
    await saveExpenseReview('r1', 'メモ', 'super-admin')
    mf.offices[HIBI].reports[0].updated_at = '2026-11-10T15:00:00+09:00'
    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r1').review?.note).toBe('メモ')
  })

  test('取り消しができる・要確認でない申請には付けられない', async () => {
    stage()
    await cron()
    await saveExpenseReview('r1', 'メモ', 'super-admin')
    await saveExpenseReview('r1', null, 'super-admin')
    expect(check('r1').review).toBeUndefined()
    report(HIBI, 'r2', 'm-h1', '2026-11-05', [tx('t9', '2026-10-06', 600, 'i-t', '')])
    await runMfExpenseCheck({ actor: 't', force: true })
    expect(await saveExpenseReview('r2', 'メモ', 'super-admin')).toBeNull()
    expect(await saveExpenseReview('nothing', 'メモ', 'super-admin')).toBeNull()
  })

  test('X1 が出た朝は「確認済み」に隠れない', async () => {
    stage()
    await cron()
    await saveExpenseReview('r1', 'メモ', 'super-admin')
    mf.offices[HIBI].reports[0].updated_at = '2026-11-10T15:00:00+09:00'
    mf.hook = p => (p.endsWith('/ex_reports/r1/ex_transactions') ? new Response('{}', { status: 500 }) : undefined)
    at('2026-11-11T07:00:00')
    await cron()
    expect(rulesOf('r1')).toContain('X1')
    expect(stateOf('r1')).toBe('confirm')
  })
})

// ────────────────────────────────────────
//  7. 領収書
// ────────────────────────────────────────

describe('7. 領収書', () => {
  const ok = (date: string, amount: number): FakeRead => ({ readable: true, date, amount })

  function stage() {
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [
      tx('tr', '2026-10-05', 700, 'i-t', '秋津~笹塚 往復電車代', { id: 'f-tr', read: ok('2026-10-05', 500) }), // 金額ずれ → R5
      tx('ga', '2026-10-06', 4000, 'i-g', 'ガソリン', { id: 'f-ga', read: ok('2026-10-07', 4000) }),         // 日付ずれ → R2
      tx('ot', '2026-10-07', 3000, 'i-o', '養生テープ', { id: 'f-ot', read: ok('2026-10-07', 2800) }),       // 金額ずれ → R3
      tx('un', '2026-10-07', 1000, 'i-o', '軍手', { id: 'f-un', read: { readable: false, date: null, amount: null } }), // R4
    ])
    worked(101, 'siteA', '202610', [5, 6, 7])
  }

  test('未読 → receiptPending → 読む → 再チェックで R5/R2/R3 が出て 0 になる', async () => {
    stage()
    await cron()
    expect(check('r1').receiptPending).toBe(4)
    expect(rulesOf('r1')).toEqual([])
    expect(stateOf('r1')).toBe('receipt')
    at('2026-11-10T07:20:00')
    const r = await receipts()
    expect(r.body).toMatchObject({ read: 4, remaining: 0, ok: true })
    expect(check('r1').receiptPending).toBe(0)
    expect(rulesOf('r1')).toEqual(['R2', 'R3', 'R4', 'R5'])
    const flag = (rule: string) => (check('r1').flags as Record<string, any>[]).find(f => f.rule === rule)!
    expect(flag('R5')).toMatchObject({ level: 'confirm', txId: 'tr', receipt: { amount: 500 } })
    expect(flag('R2')).toMatchObject({ level: 'info', txId: 'ga', receipt: { date: '2026-10-07' } })
    expect(flag('R3')).toMatchObject({ level: 'info', txId: 'ot', receipt: { amount: 2800 } })
    expect(stateOf('r1')).toBe('confirm')
    // 画像は保存しない
    expect(Object.keys(fsDoc('expenseReceiptReads/r1')!.reads).sort()).toEqual(['ga', 'ot', 'tr', 'un'])
    expect(fsDoc('expenseReceiptReads/r1')!.reads.tr).toMatchObject({ fileId: 'f-tr', amount: 500, model: 'fake-model' })
  })

  test('2度目の cron では読み直さない（1枚1回）', async () => {
    stage()
    await cron()
    await receipts()
    const n = h.receiptReads.length
    at('2026-11-10T07:40:00')
    await receipts()
    at('2026-11-11T07:20:00')
    await cron()
    await receipts()
    expect(h.receiptReads.length).toBe(n)
  })

  test('添付の差し替え: 読み直すまで receiptPending に戻り、古い読み取りの指摘も表示も残らない', async () => {
    stage()
    await cron()
    await receipts()
    expect(rulesOf('r1')).toContain('R5')
    const r = mf.offices[HIBI].reports[0]
    const t = r.txs[0]
    t.mf_file = { id: 'f-tr-new' }
    t.fileBody = ok('2026-10-05', 700)
    r.updated_at = '2026-11-10T20:00:00+09:00'
    at('2026-11-11T07:00:00')
    await cron()
    expect(check('r1').receiptPending).toBe(1)
    expect(rulesOf('r1')).not.toContain('R5')
    const saved = (check('r1').txs as Record<string, any>[]).find(x => x.id === 'tr')!
    expect(saved.fileId).toBe('f-tr-new')
  })

  test('添付の差し替え後、一覧の明細に古い領収書の読み取りを表示しない', async () => {
    stage()
    await cron()
    await receipts()
    const r = mf.offices[HIBI].reports[0]
    r.txs[0].mf_file = { id: 'f-tr-new' }
    r.txs[0].fileBody = ok('2026-10-05', 700)
    r.updated_at = '2026-11-10T20:00:00+09:00'
    at('2026-11-11T07:00:00')
    await cron()
    expect((check('r1').txs as Record<string, any>[]).find(x => x.id === 'tr')!.receipt).toBeUndefined()
  })

  test('添付の差し替えの後、読み直すと R5 が消える', async () => {
    stage()
    await cron()
    await receipts()
    const r = mf.offices[HIBI].reports[0]
    r.txs[0].mf_file = { id: 'f-tr-new' }
    r.txs[0].fileBody = ok('2026-10-05', 700)
    r.updated_at = '2026-11-10T20:00:00+09:00'
    at('2026-11-11T07:00:00')
    await cron()
    at('2026-11-11T07:20:00')
    const rc = await receipts()
    expect(rc.body.read).toBe(1)
    expect(rulesOf('r1')).not.toContain('R5')
    expect(check('r1').receiptPending).toBe(0)
    expect(fsDoc('expenseReceiptReads/r1')!.reads.tr.fileId).toBe('f-tr-new')
    expect(fsDoc('expenseReceiptReads/r1')!.reads.ot.fileId).toBe('f-ot') // ほかの明細は保たれる
  })

  test('1枚の読み取り例外: 他は読み、残りは次の回に', async () => {
    stage()
    await cron()
    h.readReceipt = async b => {
      const v = JSON.parse(b.toString('utf8'))
      if (v.amount === 2800) throw new Error('一時的な失敗')
      return v
    }
    const r = await receipts()
    expect(r.body).toMatchObject({ ok: true, read: 3, remaining: 1 })
    expect(check('r1').receiptPending).toBe(1)
    expect(fsDoc('mfExpense/receiptState')!.lastError).toContain('一時的な失敗')
    expect(fsDoc('mfExpense/receiptState')!.runningUntil).toBe(0)
    h.readReceipt = null
    at('2026-11-10T07:40:00')
    const again = await receipts()
    expect(again.body).toMatchObject({ read: 1, remaining: 0 })
    expect(check('r1').receiptPending).toBe(0)
    expect(fsDoc('mfExpense/receiptState')!.lastError).toBeNull()
  })

  test('全部失敗: error で、再チェックしない', async () => {
    stage()
    await cron()
    h.readReceipt = async () => { throw new Error('down') }
    mf.calls.length = 0
    const r = await receipts()
    expect(r.http).toBe(500)
    expect(r.body).toMatchObject({ ok: false, status: 'error', read: 0 })
    expect(mf.callsTo(/approving/)).toEqual([])
  })

  test('続けても無駄な失敗で止まる（次の組を読まない）', async () => {
    for (let i = 0; i < 10; i++) report(HIBI, `b${i}`, 'm-h2', '2026-11-05', [tx(`bt${i}`, '2026-10-08', 100, 'i-o', '', { id: `bf${i}`, read: ok('2026-10-08', 100) })])
    await cron()
    h.readReceipt = async () => { throw new h.FatalReceiptError('credit') }
    await receipts()
    expect(h.receiptReads.length).toBe(4)
  })

  test('7:20 の再チェックが失敗しても、7:40 で読み取り結果を一覧に反映する', async () => {
    stage()
    await cron()
    at('2026-11-10T07:20:00')
    mf.hook = (p, m) => (p.endsWith('/ex_items') && m === 'GET' ? new Response('{}', { status: 503 }) : undefined)
    const r = await receipts()
    expect(r.body.read).toBe(4)
    expect(check('r1').receiptPending).toBe(4)
    mf.hook = null
    at('2026-11-10T07:40:00')
    await receipts()
    expect(check('r1').receiptPending).toBe(0)
    expect(rulesOf('r1')).toContain('R5')
  })

  test('1回の上限 100 枚: 残りは次の回', async () => {
    for (let i = 0; i < 105; i++) report(HIBI, `b${i}`, 'm-h2', '2026-11-05', [tx(`bt${i}`, '2026-10-08', 100 + i, 'i-o', '', { id: `bf${i}`, read: ok('2026-10-08', 100 + i) })])
    mf.latencyMs = 0
    await cron()
    const r = await receipts()
    expect(r.body).toMatchObject({ read: 100, remaining: 5 })
    at('2026-11-10T07:40:00')
    expect((await receipts()).body).toMatchObject({ read: 5, remaining: 0 })
    expect(check('b0').receiptPending).toBe(0)
    expect(check('b104').receiptPending).toBe(0)
  })

  test('領収書の持ち時間切れ: 読めた分は残し、ロックを外して残数を返す', async () => {
    for (let i = 0; i < 12; i++) report(HIBI, `b${i}`, 'm-h2', '2026-11-05', [tx(`bt${i}`, '2026-10-08', 100 + i, 'i-o', '', { id: `bf${i}`, read: ok('2026-10-08', 100 + i) })])
    await cron()
    mf.hook = p => { if (p.endsWith('mf_file')) vi.setSystemTime(Date.now() + 30_000); return undefined }
    const r = await runMfReceiptReads()
    expect(r.ok).toBe(true)
    expect(r.read).toBeGreaterThan(0)
    expect(r.read).toBeLessThan(12)
    expect(r.remaining).toBe(12 - r.read)
    expect(fsDoc('mfExpense/receiptState')!.runningUntil).toBe(0)
  })

  test('領収書の二重起動は busy', async () => {
    stage()
    await cron()
    h.docs.set('mfExpense/receiptState', { runningUntil: Date.now() + 60_000 })
    const r = await receipts()
    expect(r.http).toBe(500)
    expect(r.body).toMatchObject({ ok: false, status: 'busy' })
    expect(h.receiptReads).toEqual([])
  })

  test('鍵が無ければ何もしない', async () => {
    stage()
    delete process.env.ANTHROPIC_API_KEY
    await cron()
    const r = await receipts()
    expect(r.body.status).toBe('notConfigured')
    expect(mf.callsTo(/mf_file/)).toEqual([])
    expect(check('r1').receiptPending).toBe(4) // 読んでいない枚数は鍵が無くても数える（チェック済みにしない）
  })

  test('差し戻された（閉じた）申請の領収書は読まない', async () => {
    stage()
    await cron()
    mf.offices[HIBI].reports[0].status = 'rejected'
    await runMfExpenseCheck({ actor: 't', force: true })
    const r = await receipts()
    expect(r.body.read).toBe(0)
  })

  test('hfuEnabled を切ったあとは、HFU の領収書に費用をかけない', async () => {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:05:00')
    report(HFU, 'f1', 'm-f1', '2026-12-05', [tx('tf1', '2026-11-06', 700, 'j-t', '', { id: 'ff1', read: ok('2026-11-06', 700) })])
    await cron('hfu')
    settings({ hfuEnabled: false })
    at('2026-12-10T07:20:00')
    const r = await receipts()
    expect(r.body.read).toBe(0)
    expect(mf.callsTo(/mf_file/)).toEqual([])
  })

  test('HFU の領収書が読めたら HFU も再チェックされる', async () => {
    settings({ hfuEnabled: true })
    at('2026-12-10T07:05:00')
    report(HFU, 'f1', 'm-f1', '2026-12-05', [tx('tf1', '2026-11-06', 700, 'j-t', '', { id: 'ff1', read: ok('2026-11-06', 500) })])
    worked(301, 'siteB', '202611', [6])
    await cron('hfu')
    expect(check('f1').receiptPending).toBe(1)
    at('2026-12-10T07:20:00')
    await receipts()
    expect(check('f1').receiptPending).toBe(0)
    expect(rulesOf('f1')).toContain('R5')
  })
})

describe('道具代（通しで G1・G2 が動くか）', () => {
  test('残額を超える申請は G2、対象外の人は G1', async () => {
    h.docs.set('demmen/toolBudget', { defaultBudget: 10000, periodAnchors: { 101: '2026-04-01', 104: '2026-04-01' } })
    h.main.workers = [...h.main.workers, { id: 104, name: '事務員', org: 'hibi', visa: 'none', job: 'jimu', payrollNo: '1004', hireDate: '2020-01-01' }]
    mf.offices[HIBI].members.push({ id: 'm-h4', number: '1004', name: '事務員', is_active: true })
    report(HIBI, 'over', 'm-h1', '2026-11-05', [tx('k1', '2026-10-05', 15000, 'i-k', 'インパクト', { id: 'fk1', read: { readable: true, date: '2026-10-05', amount: 15000 } })])
    report(HIBI, 'jimu', 'm-h4', '2026-11-05', [tx('k2', '2026-10-05', 1000, 'i-k', '軍手', { id: 'fk2', read: { readable: true, date: '2026-10-05', amount: 1000 } })])
    await cron()
    expect(rulesOf('over')).toEqual(['G2'])
    expect(rulesOf('jimu')).toEqual(['G1'])
  })
})

// ────────────────────────────────────────
//  8. 月またぎと日時
// ────────────────────────────────────────

describe('8. 月またぎと日時', () => {
  test('11/30 → 12/1: 月末に当月分を出した申請は11月分のまま、控えの窓も動く', async () => {
    report(HIBI, 'r1', 'm-h1', '2026-11-30', [tx('t1', '2026-11-27', 500, 'i-t', ''), tx('t2', '2026-11-28', 500, 'i-t', '')])
    worked(101, 'siteA', '202611', [27, 28])
    at('2026-11-30T07:00:00')
    expect((await cron()).body.status).toBe('done')
    expect(check('r1').targetYm).toBe('202611')
    expect(rulesOf('r1')).toEqual([])
    expect(h.attCalls.filter(c => !c.cached).map(c => c.ym).sort()).toEqual(['202610', '202611'])

    h.attCalls.length = 0
    at('2026-12-01T07:00:00') // UTC では 11/30 22:00
    expect((await cron()).body.status).toBe('done')
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2026-12-01')
    expect(check('r1').targetYm).toBe('202611')
    expect(rulesOf('r1')).toEqual([])
    expect(h.attCalls.filter(c => !c.cached).map(c => c.ym).sort()).toEqual(['202611', '202612'])
    expect(h.attCalls.filter(c => c.cached).map(c => c.ym).sort()).toEqual(['202608', '202609', '202610'])
  })

  test('1日の朝（UTC ではまだ前月末）に出た申請の月', async () => {
    report(HIBI, 'r1', 'm-h1', '2026-12-01', [tx('t1', '2026-11-27', 500, 'i-t', '')], { submitted_at: '2026-11-30T16:00:00Z', updated_at: '2026-11-30T16:00:00Z' })
    worked(101, 'siteA', '202611', [27])
    at('2026-12-01T07:00:00')
    await cron()
    expect(check('r1')).toMatchObject({ submittedIso: '2026-12-01', targetYm: '202611' })
    expect(rulesOf('r1')).toEqual([])
  })

  test('日付が変わる前後: 23:59 の完了は翌日 0:10 には持ち越さない（JST で判定）', async () => {
    at('2026-11-10T23:59:00')
    expect((await cron()).body.status).toBe('done')
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2026-11-10')
    at('2026-11-11T00:10:00') // UTC では 11/10 15:10
    expect((await cron()).body.status).toBe('done')
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2026-11-11')
    at('2026-11-11T08:59:00') // UTC では 11/10 23:59
    expect((await cron()).body.status).toBe('skipped')
  })

  test('未来の日付は JST の今日で判定する（朝の 8 時に今日の日付は未来でない）', async () => {
    report(HIBI, 'r1', 'm-h1', '2026-12-01', [tx('t1', '2026-12-01', 500, 'i-t', '')])
    worked(101, 'siteA', '202612', [1])
    at('2026-12-01T08:00:00')
    await cron()
    const msgs = (check('r1').flags as { rule: string; message: string }[]).filter(f => f.rule === 'D1').map(f => f.message)
    expect(msgs.join()).not.toContain('未来')
    expect(msgs.length).toBe(1) // 1日に出した当月の日付は D1（当月の日付が混ざった）
  })

  function reminderStage() {
    report(HIBI, 'aug', 'm-h1', '2026-09-05', [tx('b1', '2026-08-06', 700, 'i-t', '')], { status: 'approved' })
    report(HIBI, 'sep', 'm-h1', '2026-10-05', [tx('b2', '2026-09-06', 700, 'i-t', '')], { status: 'approved' })
    report(HIBI, 'rj', 'm-h2', '2026-11-03', [tx('b3', '2026-10-06', 700, 'i-t', '')], { status: 'rejected' })
    worked(101, 'siteA', '202610', [5, 6])
  }

  test.each([
    ['2026-11-07', []],
    ['2026-11-08', [['M1', 'info', 'm-h1']]],
    ['2026-11-10', [['M1', 'info', 'm-h1']]],
    ['2026-11-11', [['M2', 'confirm', 'm-h1'], ['M2', 'confirm', 'm-h2']]],
  ])('m1Day・m2Day の当日: %s', async (date, expected) => {
    reminderStage()
    at(`${date}T07:00:00`)
    await cron()
    const got = (fsDoc('mfExpense/reminders')!.entries as { rule: string; level: string; memberId: string }[]).map(e => [e.rule, e.level, e.memberId])
    expect(got).toEqual(expected)
  })

  test('m2Day の差し戻し一覧は前月1日以降の提出で引く（1月なら前年12月1日）', async () => {
    at('2027-01-11T07:00:00')
    await cron()
    const c = mf.callsTo(/expense_reports$/)
    expect(c.length).toBe(1)
    expect(decodeURIComponent(c[0].search)).toContain('submitted_at_from]=2026-12-01')
  })

  test('1月の前年12月分: 月・出面・控え・T1 が年をまたいで合う', async () => {
    report(HIBI, 'r1', 'm-h1', '2027-01-08', [tx('t1', '2026-12-10', 500, 'i-t', ''), tx('t2', '2026-12-11', 500, 'i-t', '')])
    worked(101, 'siteA', '202612', [10])
    at('2027-01-10T07:00:00')
    await cron()
    expect(check('r1').targetYm).toBe('202612')
    expect(rulesOf('r1')).toEqual(['T1'])
    expect((check('r1').flags as { txId: string }[])[0].txId).toBe('t2')
    expect(h.attCalls.map(c => c.ym).sort()).toEqual(['202609', '202610', '202611', '202612', '202701'])
    expect(h.attCalls.filter(c => !c.cached).map(c => c.ym).sort()).toEqual(['202612', '202701'])
    const hist = mf.callsTo(/\/ex_transactions$/).filter(c => c.search.includes('recognized_at_from')).map(c => decodeURIComponent(c.search))
    expect(hist.some(s => s.includes('from]=2026-12-01') && s.includes('to]=2026-12-31'))).toBe(true)
    expect(hist.some(s => s.includes('from]=2027-01-01') && s.includes('to]=2027-01-31'))).toBe(true)
  })

  test('元日の朝 7:00（UTC では前年の大晦日）', async () => {
    report(HIBI, 'r1', 'm-h1', '2026-12-31', [tx('t1', '2026-12-30', 500, 'i-t', '')])
    worked(101, 'siteA', '202612', [30])
    at('2027-01-01T07:00:00')
    await cron()
    expect(fsDoc('mfExpense/runState')!.completedDate).toBe('2027-01-01')
    expect(check('r1').targetYm).toBe('202612')
    expect(rulesOf('r1')).toEqual([])
  })

  test('0.6補の日は現場に出ていない扱い（T1）', async () => {
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [tx('t1', '2026-10-05', 500, 'i-t', '')])
    worked(101, 'siteA', '202610', [5], { w: 0.6 })
    worked(101, 'siteA', '202610', [7])
    await cron()
    expect(rulesOf('r1')).toEqual(['T1'])
  })
})



describe('承認済みの申請', () => {
  const load = async (ym: string, budget?: number) => {
    const { runMfApprovedCheck } = await import('@/lib/mf-expense-run.server')
    return runMfApprovedCheck(ym, 'tester', budget)
  }
  function stage() {
    report(HIBI, 'ap1', 'm-h1', '2026-11-05', [tx('p1', '2026-10-05', 500, 'i-t', '秋津~笹塚 往復電車代')], { status: 'approved', approved_at: '2026-11-07T10:00:00+09:00' } as never)
    report(HIBI, 'ap2', 'm-h1', '2026-10-05', [tx('p2', '2026-09-05', 500, 'i-t', '秋津~笹塚 往復電車代')], { status: 'approved' })
    report(HIBI, 'wait', 'm-h1', '2026-11-06', [tx('p3', '2026-10-06', 500, 'i-t', '秋津~笹塚 往復電車代')])
    report(HIBI, 'rej', 'm-h1', '2026-11-06', [tx('p4', '2026-10-07', 500, 'i-t', '秋津~笹塚 往復電車代')], { status: 'rejected' })
    worked(101, 'siteA', '202610', [6])
    at('2026-11-10T09:00:00')
  }

  test('その月の承認済みだけを、別の保存先に入れる。休みの日の交通費も指摘する', async () => {
    stage()
    await cron() // 従業員の結びつけは朝のチェックで読み込まれる
    const r = await load('202610')
    expect(r).toMatchObject({ ok: true, status: 'done', count: 1 })
    expect(approved('ap1')!.open).toBe(false)
    expect((approved('ap1')!.flags as { rule: string }[]).map(f => f.rule)).toContain('T1')
    expect(approved('ap2')).toBeUndefined()
    expect(approved('wait')).toBeUndefined()
    expect(approved('rej')).toBeUndefined()
    expect(fsDoc('expenseChecks/ap1')).toBeUndefined()
  })
  test('毎朝の一覧と閉じる処理に影響しない', async () => {
    stage()
    await load('202610')
    await cron()
    expect(approved('ap1')).toBeDefined()
    expect(approved('ap1')!.open).toBe(false)
  })
  test('二度目は明細を読み直さない。承認が取り消されたら消す', async () => {
    stage()
    await load('202610')
    const before = mf.callsTo(/ex_reports\/ap1\/ex_transactions/).length
    await load('202610')
    expect(mf.callsTo(/ex_reports\/ap1\/ex_transactions/).length).toBe(before)
    mf.offices[HIBI].reports.find(x => x.id === 'ap1')!.status = 'canceled'
    await load('202610')
    expect(approved('ap1')).toBeUndefined()
  })
  test('MF のメンテナンス中は読まない', async () => {
    stage()
    at('2026-11-10T03:00:00')
    expect(await load('202610')).toMatchObject({ ok: false, status: 'maintenance' })
  })
})

describe('MF の今の状態だけの読み直し（画面を開いたとき）', () => {
  const stage = async () => {
    settings()
    report(HIBI, 'r1', 'm-h1', '2026-11-05', [tx('t1', '2026-10-20', 500, 'i-o', '文具')], {
      ex_report_approvals: [{ step: 1, is_active: true, approved_at: null, approve_office_member: { name: '森田陽子' } }],
    })
    report(HIBI, 'r2', 'm-h2', '2026-11-05', [tx('t2', '2026-10-20', 800, 'i-o', '文具')])
    await cron()
    mf.calls.length = 0
    h.writeLog.length = 0
    at('2026-11-10T09:00:00')
  }
  const mfReport = (id: string) => mf.offices[HIBI].reports.find(x => x.id === id)!

  test('差し戻すと、朝を待たずに一覧から外れ、差し戻し中に入る（明細は読まない）', async () => {
    await stage()
    mfReport('r1').status = 'rejected'
    expect(await syncMfExpenseStatus()).toMatchObject({ synced: true, changed: true })
    expect(check('r1').open).toBe(false)
    expect(check('r2').open).toBe(true)
    expect(await loadMfRejected()).toMatchObject([{ reportId: 'r1', name: '鈴木一郎', submittedIso: '2026-11-05' }])
    expect(mf.callsTo(/ex_transactions/).length).toBe(0)
  })

  test('1段目の承認は、一覧に残したまま次の人の番に変わる', async () => {
    await stage()
    const r = mfReport('r1')
    r.status = 'waiting_step_two'
    r.ex_report_approvals = [
      { step: 1, is_active: false, approved_at: '2026-11-10T08:50:00+09:00', approve_office_member: { name: '森田陽子' } },
      { step: 2, is_active: true, approved_at: null, approve_office_member: { name: '日比靖仁' } },
    ]
    expect(await syncMfExpenseStatus()).toMatchObject({ changed: true })
    expect(check('r1').open).toBe(true)
    expect(check('r1').status).toBe('waiting_step_two')
    expect(check('r1').approvals[1]).toMatchObject({ name: '日比靖仁', active: true })
  })

  test('何も変わっていなければ書かない。項目の順が変わって戻っても「変わった」にしない', async () => {
    await stage()
    const c = h.docs.get('expenseChecks/r1') as Record<string, any>
    c.approvals = c.approvals.map((a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).reverse()))
    expect(await syncMfExpenseStatus()).toMatchObject({ synced: true, changed: false })
    expect(h.writeLog.filter(w => w.key.startsWith('expenseChecks/'))).toEqual([])
  })

  test('1分以内は MF を読まない。1分たてば読む', async () => {
    await stage()
    await syncMfExpenseStatus()
    const n = mf.calls.length
    at('2026-11-10T09:00:30')
    expect((await syncMfExpenseStatus()).synced).toBe(false)
    expect(mf.calls.length).toBe(n)
    at('2026-11-10T09:01:01')
    expect((await syncMfExpenseStatus()).synced).toBe(true)
  })

  test('出し直されると差し戻し中から外れ、次のチェックで一覧に戻って確認メモは消える', async () => {
    await stage()
    h.docs.get('expenseChecks/r1')!.review = { note: 'x', byName: 'y', at: '', flagKeys: [] }
    const r = mfReport('r1')
    r.status = 'rejected'
    await syncMfExpenseStatus()
    r.status = 'waiting_step_one'
    r.submitted_at = '2026-11-12T10:00:00+09:00'
    r.updated_at = r.submitted_at
    at('2026-11-12T09:00:00')
    expect(await syncMfExpenseStatus()).toMatchObject({ changed: true })
    expect(await loadMfRejected()).toEqual([])
    at('2026-11-12T11:00:00')
    await runMfExpenseCheck({ actor: 'tester', force: true })
    expect(check('r1').open).toBe(true)
    expect(check('r1').review).toBeUndefined()
  })

  test('形の違う応答や MF の障害では申請を閉じない', async () => {
    await stage()
    mf.hook = p => (p.endsWith('/approving_ex_reports') ? Response.json({ oops: true }) : undefined)
    expect((await syncMfExpenseStatus()).synced).toBe(false)
    expect(check('r1').open).toBe(true)
  })

  test('差し戻しの一覧が読めなくても、承認待ちの反映は活かす', async () => {
    await stage()
    mfReport('r1').status = 'approved'
    mf.hook = p => (p.endsWith('/expense_reports') ? new Response('{}', { status: 404 }) : undefined)
    expect(await syncMfExpenseStatus()).toMatchObject({ synced: true, changed: true })
    expect(check('r1').open).toBe(false)
  })

  test('チェックの途中とメンテナンス中は読まない', async () => {
    await stage()
    h.docs.get('mfExpense/runState')!.runningUntil = Date.now() + 30_000
    expect((await syncMfExpenseStatus()).synced).toBe(false)
    h.docs.get('mfExpense/runState')!.runningUntil = 0
    at('2026-11-10T03:00:00')
    expect((await syncMfExpenseStatus()).synced).toBe(false)
    expect(mf.calls.length).toBe(0)
  })

  test('HFU のスイッチを切っている間は、HFU を読まない', async () => {
    await stage()
    report(HFU, 'f1', 'm-f3', '2026-11-05', [tx('x1', '2026-11-01', 500, 'j-t')], { status: 'rejected' })
    await syncMfExpenseStatus()
    expect(noHfuTraffic().length).toBe(0)
    expect(await loadMfRejected('hfu')).toEqual([])
  })

  test('同じ時に別の処理がトークンを更新していたら、つなぎ直しにせず新しいトークンで続ける', async () => {
    await stage()
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    const stale = h.docs.get('mfExpenseSecrets/connection')!.enc
    // 相手が先に更新して保存した状態を作る
    await runMfExpenseCheck({ actor: 'tester', force: true })
    const fresh = h.docs.get('mfExpenseSecrets/connection')!.enc
    expect(fresh).not.toBe(stale)
    h.docs.get('mfExpenseSecrets/connection')!.enc = stale
    h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() - 1000
    let swapped = false
    mf.hook = (p, m) => {
      if (p === '/oauth/token' && m === 'POST' && !swapped) {
        swapped = true
        h.docs.get('mfExpenseSecrets/connection')!.enc = fresh
        h.docs.get('mfExpenseSecrets/connection')!.accessExpiresAt = Date.now() + 3600_000
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return undefined
    }
    expect((await syncMfExpenseStatus()).synced).toBe(true)
    expect(fsDoc('mfExpenseSecrets/connection')!.needsReconnect).toBe(false)
  })
})
