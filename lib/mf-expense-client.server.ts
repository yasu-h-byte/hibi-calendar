import 'server-only'
/**
 * MF クラウド経費の API への接続（OAuth 2.0 認可コード・2026-11-08）。docs/mf-expense-check.md「安全」。
 *
 * - 鍵（Client ID・Secret）は環境変数 MF_EXPENSE_CLIENT_ID / MF_EXPENSE_CLIENT_SECRET だけに置く
 * - トークンは暗号化して Firestore の mfExpenseSecrets/connection に置く（鍵は Client Secret から作る。
 *   Firestore だけが漏れても読めない。バックアップの対象からも外している）
 * - 申請の承認・差し戻しの権限（report:write）は**求めない**。第4段階まで MF には書き込まない
 *   事業者全体の申請を読むには office_setting:write が要る（MF に読み取りだけの権限が無い）ので、
 *   ここには GET しか置かない。POST するのはトークンの発行と無効化（/oauth/*）だけ。
 *   __tests__/mfExpense.test.ts がこの決まりを見張る
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { db } from '@/lib/firebase'
import { deleteDoc, doc, getDoc, setDoc } from '@/lib/fsdb'
import { PRODUCTION_ORIGIN } from '@/lib/public-origin'

const MF_ORIGIN = 'https://expense.moneyforward.com'
const MF_SCOPES = 'office_setting:write user_setting:write'
/** MF のアプリ登録の Redirect URI と完全に同じにする（本番のドメインだけ） */
export const MF_REDIRECT_URI = `${PRODUCTION_ORIGIN}/api/mf-expense/callback`
/** 第1段階は日比建設だけ */
const TARGET_OFFICE_NAME = '日比建設'

function credentials(): { id: string; secret: string } | null {
  const id = process.env.MF_EXPENSE_CLIENT_ID
  const secret = process.env.MF_EXPENSE_CLIENT_SECRET
  return id && secret ? { id, secret } : null
}

export const isMfConfigured = (): boolean => credentials() !== null

// ────────────────────────────────────────
//  トークンの暗号化
// ────────────────────────────────────────

interface TokenSet {
  access: string
  refresh: string
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(`mf-expense-token:${secret}`).digest()
}

function encryptTokens(tokens: TokenSet, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function decryptTokens(enc: string, secret: string): TokenSet {
  const raw = Buffer.from(enc, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as TokenSet
}

// ────────────────────────────────────────
//  接続の情報
// ────────────────────────────────────────

export interface MfOffice {
  id: string
  name: string
}

interface ConnectionDoc {
  enc: string
  accessExpiresAt: number
  officeId: string | null
  officeName: string | null
  offices: MfOffice[]
  connectedAt: string
  connectedBy: string
  authorizedMember: string
  needsReconnect: boolean
  lastError: string | null
}

/** 画面に出してよい接続の状態（トークンは入れない） */
export interface MfConnectionStatus {
  configured: boolean
  connected: boolean
  officeId: string | null
  officeName: string | null
  offices: MfOffice[]
  connectedAt: string | null
  connectedBy: string | null
  authorizedMember: string | null
  needsReconnect: boolean
  lastError: string | null
}

const connectionRef = () => doc(db, 'mfExpenseSecrets', 'connection')

async function loadConnection(): Promise<ConnectionDoc | null> {
  const snap = await getDoc(connectionRef())
  return snap.exists() ? (snap.data() as ConnectionDoc) : null
}

export async function getMfConnectionStatus(): Promise<MfConnectionStatus> {
  const c = await loadConnection()
  return {
    configured: isMfConfigured(),
    connected: !!c,
    officeId: c?.officeId ?? null,
    officeName: c?.officeName ?? null,
    offices: c?.offices ?? [],
    connectedAt: c?.connectedAt ?? null,
    connectedBy: c?.connectedBy ?? null,
    authorizedMember: c?.authorizedMember ?? null,
    needsReconnect: c?.needsReconnect ?? false,
    lastError: c?.lastError ?? null,
  }
}

// ────────────────────────────────────────
//  認可（代表が画面の「MF経費につなぐ」を押す）
// ────────────────────────────────────────

const stateRef = (state: string) =>
  doc(db, 'mfExpenseSecrets', `oauth_${createHash('sha256').update(state).digest('hex')}`)

const STATE_TTL_MS = 10 * 60_000

export async function createMfAuthorizeUrl(actor: string): Promise<string> {
  const c = credentials()
  if (!c) throw new Error('MF経費の鍵が環境変数に設定されていません')
  const state = randomBytes(32).toString('hex')
  await setDoc(stateRef(state), { createdAt: Date.now(), actor })
  const q = new URLSearchParams({
    client_id: c.id, redirect_uri: MF_REDIRECT_URI, response_type: 'code', scope: MF_SCOPES, state,
  })
  return `${MF_ORIGIN}/oauth/authorize?${q.toString()}`
}

/** state を1回限りで使う。正しければ「つなぐ」を押した人の名前を返す */
export async function consumeMfState(state: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(state)) return null
  const ref = stateRef(state)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  await deleteDoc(ref)
  const data = snap.data() as { createdAt?: number; actor?: string }
  if (!data.createdAt || Date.now() - data.createdAt > STATE_TTL_MS) return null
  return data.actor || '代表'
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/** MF にトークンを断られた（status が 400/401/403 なら本当に切れている。それ以外は一時的な障害） */
class MfTokenError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** MF が返す「次のページ」。同じ API の中だけをたどり、形が違えば途中で黙って止めずにエラーにする */
export function mfNextPath(next: unknown): string | null {
  if (next === null || next === undefined || next === '') return null
  if (typeof next === 'string') {
    if (next.startsWith('/api/external/')) return next
    if (next.startsWith(`${MF_ORIGIN}/api/external/`)) return next.slice(MF_ORIGIN.length)
  }
  throw new Error('MF の応答の形が想定と違います（次のページ）')
}

async function requestToken(params: Record<string, string>): Promise<Required<Pick<TokenResponse, 'access_token'>> & TokenResponse> {
  const res = await fetch(`${MF_ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => null)) as TokenResponse | null
  // 応答の中身はログにもエラーにも出さない（トークンが入っているかもしれない）
  if (!res.ok || !json?.access_token) throw new MfTokenError(`MF のトークン発行に失敗しました（${res.status}）`, res.status)
  return json as Required<Pick<TokenResponse, 'access_token'>> & TokenResponse
}

const expiresAt = (t: TokenResponse) => Date.now() + (t.expires_in ?? 3600) * 1000

/** 認可コードをトークンに換え、接続先の事業者を決めて保存する */
export async function completeMfConnection(code: string, actor: string): Promise<void> {
  const c = credentials()
  if (!c) throw new Error('MF経費の鍵が環境変数に設定されていません')
  const t = await requestToken({
    client_id: c.id, client_secret: c.secret, redirect_uri: MF_REDIRECT_URI, grant_type: 'authorization_code', code,
  })
  if (!t.refresh_token) throw new Error('MF からリフレッシュトークンが返りませんでした')

  const authHeaders = { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' }
  const officesRes = await fetch(`${MF_ORIGIN}/api/external/v1/offices`, { headers: authHeaders, cache: 'no-store' })
  if (!officesRes.ok) throw new Error(`MF の事業者一覧を読めませんでした（${officesRes.status}）`)
  const officesJson = (await officesRes.json()) as { offices?: { id: string; name: string }[] } | { id: string; name: string }[]
  const rawOffices = Array.isArray(officesJson) ? officesJson : officesJson.offices || []
  const offices: MfOffice[] = rawOffices.map(o => ({ id: o.id, name: o.name }))

  // 名前で1つに決まれば自動で選ぶ。決まらなければ画面で代表が選ぶ
  const matched = offices.filter(o => o.name.includes(TARGET_OFFICE_NAME))
  const chosen = matched.length === 1 ? matched[0] : offices.length === 1 ? offices[0] : null

  let authorizedMember = ''
  if (chosen) {
    const meRes = await fetch(`${MF_ORIGIN}/api/external/v2/offices/${chosen.id}/me`, { headers: authHeaders, cache: 'no-store' })
    if (meRes.ok) {
      const me = (await meRes.json().catch(() => null)) as { name?: string } | null
      authorizedMember = me?.name || ''
    }
  }

  const data: ConnectionDoc = {
    enc: encryptTokens({ access: t.access_token, refresh: t.refresh_token }, c.secret),
    accessExpiresAt: expiresAt(t),
    officeId: chosen?.id ?? null,
    officeName: chosen?.name ?? null,
    offices,
    connectedAt: new Date().toISOString(),
    connectedBy: actor,
    authorizedMember,
    needsReconnect: false,
    lastError: null,
  }
  await setDoc(connectionRef(), data)
}

export async function selectMfOffice(officeId: string): Promise<boolean> {
  const c = await loadConnection()
  const office = c?.offices.find(o => o.id === officeId)
  if (!c || !office) return false
  await setDoc(connectionRef(), { officeId: office.id, officeName: office.name }, { merge: true })
  return true
}

/** MF 側のトークンも無効にしてから、こちらの保存を消す（MF が失敗しても、こちらは必ず消す） */
export async function disconnectMf(): Promise<void> {
  const c = credentials()
  const conn = await loadConnection()
  if (c && conn) {
    try {
      const tokens = decryptTokens(conn.enc, c.secret)
      await fetch(`${MF_ORIGIN}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, token: tokens.access }).toString(),
        cache: 'no-store',
      })
    } catch (e) {
      console.error('MF のトークン無効化に失敗:', e instanceof Error ? e.message : 'unknown')
    }
  }
  await deleteDoc(connectionRef())
}

// ────────────────────────────────────────
//  読むだけの API（GET しか持たない）
// ────────────────────────────────────────

export class MfTimeBudgetError extends Error {}
export class MfReconnectError extends Error {}

export interface MfApi {
  officeId: string
  officeName: string
  /** このトークンで見られる事業者 */
  offices: MfOffice[]
  /** 同じ接続（トークンの更新も共有）のまま、別の事業者を読む道具にする */
  forOffice(office: MfOffice): MfApi
  get<T>(path: string, query?: Record<string, string>): Promise<T>
  /** next をたどって全ページ読む。key は配列が入っている項目名 */
  getAll<T>(path: string, key: string, query?: Record<string, string>, opts?: { requireKey?: boolean }): Promise<T[]>
  /** 添付ファイルをそのまま読む（領収書の読み取り用） */
  getFile(path: string): Promise<{ bytes: Buffer; contentType: string }>
}

/**
 * 接続を読み、トークンを必要に応じて更新しながら GET する道具を返す。
 * deadline を過ぎると MfTimeBudgetError を投げる（残りは次の回に続ける）。
 */
export async function openMfApi(deadline: number): Promise<MfApi> {
  const c = credentials()
  if (!c) throw new MfReconnectError('MF経費の鍵が環境変数に設定されていません')
  const conn = await loadConnection()
  if (!conn) throw new MfReconnectError('MF経費につながっていません')
  if (!conn.officeId) throw new MfReconnectError('MF経費の事業者が選ばれていません')
  const officeId = conn.officeId

  let tokens: TokenSet
  try {
    tokens = decryptTokens(conn.enc, c.secret)
  } catch {
    // Client Secret を入れ替えると読めなくなる
    await setDoc(connectionRef(), { needsReconnect: true, lastError: '保存した接続情報を読めません。つなぎ直してください' }, { merge: true })
    throw new MfReconnectError('保存した接続情報を読めません。つなぎ直してください')
  }
  let accessExpires = conn.accessExpiresAt
  let currentEnc = conn.enc

  /** 同じ時に別の処理（朝のチェック・画面の読み直し）がトークンを更新していたら、その新しいトークンに乗り換える */
  async function adoptNewerTokens(): Promise<boolean> {
    await new Promise(r => setTimeout(r, 1500)) // 相手の保存が終わるのを待つ
    const latest = await loadConnection()
    if (!latest || latest.enc === currentEnc) return false
    try {
      tokens = decryptTokens(latest.enc, c!.secret)
    } catch {
      return false
    }
    currentEnc = latest.enc
    accessExpires = latest.accessExpiresAt
    return true
  }

  async function refresh(): Promise<void> {
    let t
    try {
      t = await requestToken({ client_id: c!.id, client_secret: c!.secret, grant_type: 'refresh_token', refresh_token: tokens.refresh })
    } catch (e) {
      // MF の一時的な障害（5xx・通信エラー）で「つなぎ直して」と出さない。次の回に自然に直る
      if (!(e instanceof MfTokenError) || ![400, 401, 403].includes(e.status)) throw new Error('MF経費が一時的に応答しません。次の回にやり直します')
      if (await adoptNewerTokens()) return
      await setDoc(connectionRef(), { needsReconnect: true, lastError: 'MF との接続が切れました。代表がつなぎ直してください' }, { merge: true })
      throw new MfReconnectError('MF との接続が切れました。代表がつなぎ直してください')
    }
    tokens = { access: t.access_token, refresh: t.refresh_token || tokens.refresh }
    accessExpires = expiresAt(t)
    currentEnc = encryptTokens(tokens, c!.secret)
    await setDoc(connectionRef(), { enc: currentEnc, accessExpiresAt: accessExpires, needsReconnect: false, lastError: null }, { merge: true })
  }

  async function fetchJson<T>(pathWithQuery: string, attempt = 0): Promise<T> {
    if (Date.now() > deadline) throw new MfTimeBudgetError('時間切れ')
    if (accessExpires - Date.now() < 5 * 60_000) await refresh()
    const res = await fetch(`${MF_ORIGIN}${pathWithQuery}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.access}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (res.status === 401 && attempt === 0) {
      await refresh()
      return fetchJson<T>(pathWithQuery, attempt + 1)
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      return fetchJson<T>(pathWithQuery, attempt + 1)
    }
    if (!res.ok) throw new Error(`MF の読み取りに失敗しました（${res.status}）`)
    return (await res.json()) as T
  }

  async function fetchFile(pathOnly: string, attempt = 0): Promise<{ bytes: Buffer; contentType: string }> {
    if (Date.now() > deadline) throw new MfTimeBudgetError('時間切れ')
    if (accessExpires - Date.now() < 5 * 60_000) await refresh()
    const res = await fetch(`${MF_ORIGIN}${pathOnly}`, { method: 'GET', headers: { Authorization: `Bearer ${tokens.access}` }, cache: 'no-store' })
    if (res.status === 401 && attempt === 0) {
      await refresh()
      return fetchFile(pathOnly, attempt + 1)
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      return fetchFile(pathOnly, attempt + 1)
    }
    if (!res.ok) throw new Error(`MF の添付の読み取りに失敗しました（${res.status}）`)
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' }
  }

  const withQuery = (path: string, query?: Record<string, string>) => {
    const q = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : ''
    return `${path}${q}`
  }

  const makeApi = (office: MfOffice): MfApi => {
    const officePath = (path: string) => `/api/external/${path.replace('{office}', office.id)}`
    return {
      officeId: office.id,
      officeName: office.name,
      offices: conn.offices,
      forOffice: makeApi,
      get: <T,>(path: string, query?: Record<string, string>) => fetchJson<T>(withQuery(officePath(path), query)),
      getFile: (path: string) => fetchFile(officePath(path)),
      async getAll<T>(path: string, key: string, query?: Record<string, string>, opts?: { requireKey?: boolean }): Promise<T[]> {
        const rows: T[] = []
        let next: string | null = withQuery(officePath(path), query)
        for (let guard = 0; next && guard < 500; guard++) {
          const json: Record<string, unknown> = await fetchJson<Record<string, unknown>>(next)
          if (opts?.requireKey && !Array.isArray(json[key])) throw new Error('MF の応答の形が想定と違います')
          rows.push(...((json[key] as T[] | undefined) || []))
          next = mfNextPath(json.next)
        }
        return rows
      },
    }
  }
  return makeApi({ id: officeId, name: conn.officeName || '' })
}
