/**
 * 人員マスタ API（app/api/workers・2026-10-02 総合点検）
 *
 * - update は許可リスト方式（知らない項目は 400）。空文字・null は「その項目を消す」（誤って入れた退職日を消せる）
 * - 給与欄（WORKER_OWNER_ONLY_KEYS＝給与の項目すべて）の変更は代表だけ。rateFrom / prevRate / salaryFrom / prevSalary も含む
 *   （旧: 手書きの一覧から抜けていて事務が書き換えられ、監査ログにも残らなかった）
 * - add でも給与欄を入れられるのは代表だけ
 * - 代表(0)・政仁さん(1)・役員・事務の合言葉は代表だけに返し、発行・失効も代表だけ
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

type Caller = { actor: number | 'super-admin'; caps: Set<string> }
const caller: Caller = { actor: 303, caps: new Set() }
const workers = [
  { id: 0, name: '日比靖仁', org: 'hibi', visa: 'none', job: 'yakuin', token: 'tok-owner', rate: 0, otMul: 1.25, hireDate: '' },
  { id: 1, name: '日比政仁', org: 'hibi', visa: 'none', job: 'yakuin', token: 'tok-masahito', rate: 0, otMul: 1.25, hireDate: '' },
  { id: 303, name: '森田', org: 'hibi', visa: 'none', job: 'jimu', token: '', rate: 0, otMul: 1.25, hireDate: '' },
  { id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi', token: 'tok-104', rate: 14000, hourlyRate: 2000, otMul: 1.25, hireDate: '2022-01-01', retired: '2026-12-31', prevRate: 13000, rateFrom: '2026-10-01', memo: 'めも' },
]
const calls: { update: unknown[]; add: unknown[]; gen: unknown[]; revoke: unknown[]; audit: unknown[] } = { update: [], add: [], gen: [], revoke: [], audit: [] }

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: (_db: unknown, col: string, id: string) => ({ col, id }),
  getDoc: async () => ({ exists: () => true, data: () => ({ workers: structuredClone(workers) }) }),
  setDoc: async (ref: unknown, data: unknown) => { calls.audit.push({ ref, data }) },
  getDocs: async () => ({ forEach: () => {} }),
  collection: () => ({}),
}))
vi.mock('@/lib/activity', () => ({ logActivity: async () => {} }))
vi.mock('@/lib/auth', () => ({
  requireCap: async (_r: unknown, cap: string) => caller.caps.has(cap) ? null : new Response(JSON.stringify({ error: `no ${cap}` }), { status: 403 }),
  callerCan: async (_r: unknown, cap: string) => caller.caps.has(cap),
  getApiAuthUser: async () => ({ authorized: true, actor: caller.actor }),
  checkApiAuth: async () => true,
}))
vi.mock('@/lib/worker-crud', () => ({
  addWorker: async (w: unknown) => { calls.add.push(w); return { id: 999, ...(w as object) } },
  updateWorker: async (id: number, updates: unknown, unsetFields: string[]) => { calls.update.push({ id, updates, unsetFields }) },
  deleteWorker: async () => {},
  generateWorkerToken: async (id: number) => { calls.gen.push(id); return 'new-token' },
  revokeWorkerToken: async (id: number) => { calls.revoke.push(id) },
}))

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/workers/route')
  return POST(new Request('http://x/api/workers', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as never)
}
const get = async () => {
  const { GET } = await import('@/app/api/workers/route')
  return (await GET(new Request('http://x/api/workers') as never)).json() as Promise<{ workers: Record<string, unknown>[] }>
}
const asJimu = () => { caller.actor = 303; caller.caps = new Set(['workers.view', 'workers.edit', 'pay.view']) }
const asOwner = () => { caller.actor = 'super-admin'; caller.caps = new Set(['workers.view', 'workers.edit', 'workers.editPay', 'pay.view', 'system.admin']) }
const asForeman = () => { caller.actor = 2; caller.caps = new Set() }

beforeEach(() => { calls.update = []; calls.add = []; calls.gen = []; calls.revoke = []; calls.audit = [] })

describe('update: 許可リストと「消す」', () => {
  test('知らない項目（token・scheduledChanges など）は 400', async () => {
    asJimu()
    expect((await post({ action: 'update', id: 104, token: 'xxx' })).status).toBe(400)
    expect((await post({ action: 'update', id: 104, scheduledChanges: [] })).status).toBe(400)
    expect(calls.update).toEqual([])
  })
  test("空文字・null は項目を消す（retired: '' で退職日が消える）。キーを送らなければ変更なし", async () => {
    asJimu()
    const res = await post({ action: 'update', id: 104, name: 'フン', retired: '', visaExpiry: null })
    expect(res.status).toBe(200)
    expect(calls.update).toHaveLength(1)
    const c = calls.update[0] as { updates: Record<string, unknown>; unsetFields: string[] }
    expect(c.unsetFields.sort()).toEqual(['retired', 'visaExpiry'])
    expect(c.updates).toEqual({ name: 'フン' })
  })
  test('消せない項目（名前・入社日）に空が来ても消さない（変更なし）', async () => {
    asJimu()
    await post({ action: 'update', id: 104, name: '', hireDate: '', memo: '新しいめも' })
    const c = calls.update[0] as { updates: Record<string, unknown>; unsetFields: string[] }
    expect(c.unsetFields).toEqual([])
    expect(c.updates).toEqual({ memo: '新しいめも' })
  })
})

describe('update: 給与欄は代表だけ', () => {
  test('事務が prevRate / rateFrom / salaryFrom / prevSalary を変えると 403（旧: 一覧から抜けていた）', async () => {
    asJimu()
    for (const body of [
      { prevRate: 99999 }, { rateFrom: '2099-01-01' }, { salaryFrom: '2026-10-01', prevSalary: 300000 }, { prevJpStep: 5 },
    ]) {
      const res = await post({ action: 'update', id: 104, ...body })
      expect(res.status, JSON.stringify(body)).toBe(403)
    }
    expect(calls.update).toEqual([])
  })
  test('事務が給与欄を「消す」（空で送る）のも変更＝403', async () => {
    asJimu()
    expect((await post({ action: 'update', id: 104, hourlyRate: '' })).status).toBe(403)
  })
  test('同じ値を送り返すだけなら通る（画面は全項目を送り返す）', async () => {
    asJimu()
    const res = await post({ action: 'update', id: 104, rate: 14000, hourlyRate: '2000', prevRate: 13000, rateFrom: '2026-10-01', memo: 'x' })
    expect(res.status).toBe(200)
  })
  test('代表は変えられ、監査ログ（auditTrail）に prevRate の前後が残る', async () => {
    asOwner()
    const res = await post({ action: 'update', id: 104, prevRate: 13500 })
    expect(res.status).toBe(200)
    expect(calls.audit).toHaveLength(1)
    const a = calls.audit[0] as { ref: { col: string }; data: { changes: Record<string, { from: unknown; to: unknown }>; actor: string } }
    expect(a.ref.col).toBe('auditTrail')
    expect(a.data.changes.prevRate).toEqual({ from: 13000, to: 13500 })
    expect(a.data.actor).toBe('super-admin')
  })
})

describe('add: 給与欄は代表だけ', () => {
  test('事務が時給つきで登録すると 403。給与欄なし（残業倍率の既定 1.25・日額 0）なら登録できる', async () => {
    asJimu()
    expect((await post({ action: 'add', name: '新人', hourlyRate: 1500 })).status).toBe(403)
    expect((await post({ action: 'add', name: '新人', jpGrade: '1G', jpStep: 1 })).status).toBe(403)
    expect((await post({ action: 'add', name: '新人', rate: 0, otMul: 1.25, hourlyRate: '' })).status).toBe(200)
    expect(calls.add).toHaveLength(1)
  })
  test('知らない項目は 400', async () => {
    asJimu()
    expect((await post({ action: 'add', name: '新人', token: 'x' })).status).toBe(400)
  })
})

describe('合言葉（スマホURL）', () => {
  test('GET: 事務には政仁さん・代表の合言葉を返さない（tokenHidden）。スタッフの分は返す。代表には全部返す', async () => {
    asJimu()
    const j = (await get()).workers
    const byId = (id: number) => j.find(w => w.id === id)!
    expect(byId(1).token).toBeUndefined()
    expect(byId(1).tokenHidden).toBe(true)
    expect(byId(0).token).toBeUndefined()
    expect(byId(104).token).toBe('tok-104')
    expect(byId(104).memo).toBe('めも')
    asOwner()
    const o = (await get()).workers
    expect(o.find(w => w.id === 1)!.token).toBe('tok-masahito')
    expect(o.find(w => w.id === 1)!.tokenHidden).toBeUndefined()
  })
  test('GET: 職長には合言葉も給与欄も返さない', async () => {
    asForeman()
    const j = (await get()).workers
    for (const w of j) {
      expect(w.token).toBeUndefined()
      expect(w.hourlyRate).toBeUndefined()
      expect(w.prevRate).toBeUndefined()
    }
  })
  test('発行・失効: 政仁さんの分は事務には 403、スタッフの分はできる。代表はどちらも', async () => {
    asJimu()
    expect((await post({ action: 'generateToken', id: 1 })).status).toBe(403)
    expect((await post({ action: 'revokeToken', id: 0 })).status).toBe(403)
    expect((await post({ action: 'generateToken', id: 104 })).status).toBe(200)
    expect(calls.gen).toEqual([104])
    asOwner()
    expect((await post({ action: 'generateToken', id: 1 })).status).toBe(200)
    expect((await post({ action: 'revokeToken', id: 1 })).status).toBe(200)
    expect(calls.gen).toEqual([104, 1])
    expect(calls.revoke).toEqual([1])
  })
})
