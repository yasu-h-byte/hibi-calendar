import { AuthUser, UserRole, Site, Worker } from '@/types'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import {
  isForemanTokenShape, verifyForemanToken, isOwnerTokenShape, verifyOwnerToken, isPersonalTokenShape, readPersonalToken,
} from '@/lib/session-token'
import { passwordFingerprint } from '@/lib/password'
import { CAPABILITIES, permRoleOf, roleCan, capAllowed, type Capability, type PermRole } from '@/lib/permissions'
import { mapRawWorkers } from '@/lib/workers'

// 個人パスワードのキャッシュ（APIリクエストごとにFirestore読み取りを避ける）
let cachedUserPasswords: Record<string, string> | null = null
let cacheTimestamp = 0
const CACHE_TTL = 60_000 // 1分

async function getUserPasswords(): Promise<Record<string, string>> {
  const now = Date.now()
  if (cachedUserPasswords && now - cacheTimestamp < CACHE_TTL) {
    return cachedUserPasswords
  }
  try {
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    cachedUserPasswords = (mainData.userPasswords || {}) as Record<string, string>
    cacheTimestamp = now
    return cachedUserPasswords
  } catch {
    return cachedUserPasswords || {}
  }
}

/**
 * API認証チェック（共通）。正しい通行証（代表・職長・個人。lib/session-token.ts）ならOK。
 * ⚠️ 2026-09-26: パスワードそのものは API では通さない（ログイン /api/auth だけが受け付けて通行証を発行する）。
 *   旧: 共通パスワード＝誰か分からない管理者扱い、個人・代表のパスワードは毎回平文で送っていた
 */
export async function checkApiAuth(request: NextRequest): Promise<boolean> {
  return (await getApiAuthUser(request)).authorized
}


/** パスワード変更時にキャッシュをクリアする */
export function clearPasswordCache(): void {
  cachedUserPasswords = null
  cacheTimestamp = 0
}

/**
 * 認証 + 操作者の識別子取得（監査ログ用）
 * - super-admin: 日比靖仁 (workerId=0)
 * - number: 個人パスワード、または職長の通行証 → workerId
 * 2026-09-26: 旧 'admin'（共通パスワード＝誰か分からない管理者）は廃止。型からも外して、
 *   共通パスワードを特権扱いする分岐が二度と書けないようにしている
 */
export type ApiAuthResult =
  | { authorized: true; actor: number | 'super-admin' }
  | { authorized: false }

export async function getApiAuthUser(request: NextRequest): Promise<ApiAuthResult> {
  const authHeader = request.headers.get('x-admin-password')
  if (!authHeader) return { authorized: false }

  // 2026-09-26: API に届くのは通行証だけ（lib/session-token.ts）。パスワードそのもの
  //   （代表・個人・職長の共通）はログイン（/api/auth）でしか受け付けない。ブラウザにもパスワードを残さない。

  // 代表の通行証
  if (isOwnerTokenShape(authHeader)) {
    return verifyOwnerToken(authHeader) ? { authorized: true, actor: 'super-admin' } : { authorized: false }
  }

  // 職長の通行証（共通パスワード＋名前選択でログインした職長）
  if (isForemanTokenShape(authHeader)) {
    const wid = verifyForemanToken(authHeader)
    if (wid === null) return { authorized: false }
    return (await isTokenHolderActive(wid)) ? { authorized: true, actor: wid } : { authorized: false }
  }

  // 事務・役員・事業責任者の通行証。パスワードを変える・消すと指紋が合わなくなり使えない
  if (isPersonalTokenShape(authHeader)) {
    const t = readPersonalToken(authHeader)
    if (!t) return { authorized: false }
    const stored = (await getUserPasswords())[String(t.workerId)]
    if (!stored || passwordFingerprint(stored) !== t.fingerprint) return { authorized: false }
    // 日比靖仁さん（代表・開発者）は個人パスワードでも代表（全権限）。2026-10-01 代表指示。
    //   旧: 職種が役員なので「役員（見るだけ）」になり、電話URLの発行状況などが見えなかった
    if (t.workerId === OWNER_WORKER_ID) return { authorized: true, actor: 'super-admin' }
    return (await isTokenHolderActive(t.workerId)) ? { authorized: true, actor: t.workerId } : { authorized: false }
  }

  return { authorized: false }
}

/**
 * 通行証の持ち主がいま在籍しているか（2026-10-02 総合点検）。
 *
 * 旧: 通行証は署名と期限だけを見ていた。退職した職長の通行証は最長90日、退職した事務・役員の個人パスワードは
 *     代表が消すまで使えた（退職日を入れても何も効かなかった）。人員マスタから消えた人の通行証も「ログイン済み」で通った。
 * 新: 人員マスタ（getMainData・30秒キャッシュ＝読み取りは増えない）で退職日を見る。退職日の当日までは使える
 *     （lib/workers.ts isAlreadyRetired）。人員マスタに居ない人は通さない。
 * ⚠️ 人員マスタが読めないとき（クォータ超過など）は今までどおり通す。ここで 401 にすると管理画面が全員ログイン画面へ
 *    戻る（heartbeat 401）ため、読み取り障害を「全員締め出し」にしない。
 */
async function isTokenHolderActive(workerId: number): Promise<boolean> {
  try {
    const { getMainData } = await import('@/lib/compute')
    const main = (await getMainData()) as unknown as { workers?: { id: number; retired?: string }[] }
    const w = (main.workers || []).find(x => x.id === workerId)
    if (!w) return false
    const { isAlreadyRetired } = await import('@/lib/workers')
    return !isAlreadyRetired(w.retired)
  } catch (e) {
    console.warn('[auth] 退職の判定で人員マスタを読めませんでした（通行証はそのまま通します）:', e)
    return true
  }
}

const APPROVER_ID = 1 // 日比政仁
/** 日比靖仁（代表・開発者）。どのパスワードで入っても代表（全権限）として扱う（2026-10-01） */
export const OWNER_WORKER_ID = 0

/** 当月の YYYYMM を返す（JST 基準） */
function currentYm(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 当該ワーカーが「現在月で職長として担当する現場ID」を返す。
 * mforeman[siteId_ym] の月別 override を優先し、なければ sites.foreman を採用。
 *
 * 2026-05-08 修正: mforeman を反映していなかったため、月途中の職長交代で
 *   旧職長が承認できる/新職長が承認できない事態が起きていた。
 */
export function computeForemanSites(
  workerId: number,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
): string[] {
  const result: string[] = []
  for (const site of sites) {
    if (site.archived) continue
    if (foremenOfSiteForMonth(site, mforeman, ym).includes(workerId)) result.push(site.id)
  }
  return result
}

/**
 * その月にその現場の職長である人（承認の権限判定はすべてこれを通す・2026-10-01）。
 *
 * 月別の職長（mforeman[siteId_ym]. foreman ?? wid）があればその人だけ、無ければ現場の職長。
 * 旧: 出面・有給・帰国申請で別々に書いていて、有給は月別職長を「足す」（旧職長も承認できる）、
 *     帰国申請は月別職長を見ない、と食い違っていた。
 * `foremen`（配列）は書き込む画面が無い古い項目。残っているデータのために読むだけ読む。
 */
export function foremenOfSiteForMonth(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
): number[] {
  const monthKey = `${site.id}_${ym.replace('-', '')}`
  const override = mforeman[monthKey]?.foreman ?? mforeman[monthKey]?.wid
  if (override !== undefined && override !== null) return [override]
  if (site.foremen && site.foremen.length > 0) return site.foremen
  return site.foreman !== undefined && site.foreman !== null ? [site.foreman] : []
}

/**
 * 職長承認ができる人（2026-10-01 代表決定）。
 *
 * 「その月の現場の職長として登録されている」かつ「人員マスタの職種が職長（jobType='shokucho'）」の人だけ。
 * 職長でない人（とび・役員など）が現場マスタの職長に登録されている現場は、事業責任者（政仁さん）が
 * 職長承認を代行する（{@link isProxyApprovalSite}）。出面の入力などの権限は変えない（承認だけの決まり）。
 */
export function approvingForemenOfSite(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
): number[] {
  // 職種は Firestore の生データでは job、lib/workers で整形後は jobType
  return foremenOfSiteForMonth(site, mforeman, ym)
    .filter(id => { const w = workers.find(x => x.id === id); return (w?.jobType ?? w?.job) === 'shokucho' })
}

/** 職長承認を政仁さんが代行する現場か（承認できる職長がいない現場） */
export function isProxyApprovalSite(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
): boolean {
  return approvingForemenOfSite(site, mforeman, ym, workers).length === 0
}

export function determineRole(
  workerId: number,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }> = {},
  ym: string = currentYm(),
): { role: UserRole; foremanSites: string[] } {
  const foremanSites = computeForemanSites(workerId, sites, mforeman, ym)

  if (workerId === APPROVER_ID) {
    return { role: 'approver', foremanSites }
  }

  if (foremanSites.length > 0) {
    return { role: 'foreman', foremanSites }
  }

  // 2026-09-26: 旧は 'admin'（何でもできる）に落ちていた。役割の決まらない人は最小権限（担当現場なしの職長）
  return { role: 'foreman', foremanSites: [] }
}

export function buildAuthUser(
  worker: Worker,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }> = {},
): AuthUser {
  const ym = currentYm()
  // 日比靖仁さん（代表・開発者）は代表（全権限）。代表パスワードでのログインと同じ役割（2026-10-01）
  if (worker.id === OWNER_WORKER_ID) {
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'admin',
      foremanSites: computeForemanSites(worker.id, sites, mforeman, ym),
      token: worker.token || undefined,
    }
  }

  // 事務ロールはjobTypeで直接判定
  if (worker.jobType === 'jimu') {
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'jimu',
      foremanSites: [],
      token: worker.token || undefined,
    }
  }

  // 役員ロールはjobTypeで直接判定。ただし政仁さん（APPROVER_ID=1）は事業責任者ロール
  // 2026-09-26: 政仁さん以外の役員は 'officer'（事業責任者と同じものを見るだけ）。旧は 'admin'（何でもできる）
  if (worker.jobType === 'yakuin') {
    const foremanSites = computeForemanSites(worker.id, sites, mforeman, ym)
    return {
      workerId: worker.id,
      name: worker.name,
      role: worker.id === APPROVER_ID ? 'approver' : 'officer',
      foremanSites,
      token: worker.token || undefined,
    }
  }

  // 職長ロールはjobTypeでも判定（アーカイブ済み現場の職長に対応）
  if (worker.jobType === 'shokucho') {
    const foremanSites = computeForemanSites(worker.id, sites, mforeman, ym)
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'foreman',
      foremanSites,
      token: worker.token || undefined,
    }
  }

  const { role, foremanSites } = determineRole(worker.id, sites, mforeman, ym)
  return {
    workerId: worker.id,
    name: worker.name,
    role,
    foremanSites,
    token: worker.token || undefined,
  }
}

/**
 * サーバ側でリクエスト元の「ロール」を解決する（2026-06 追加）。
 *
 * これまで承認系API（submit/approve/bulk-confirm/revert/reject）は checkApiAuth の
 * パスワード一致のみで、ロール強制はフロントだけだった（＝API直叩きで誰でも承認できた）。
 * 本関数で個人パスワード→実ロールを解決し、各ルートで権限を強制する。
 *
 * - super-admin / admin（共通管理者パスワード）: 全権限
 * - 個人パスワード: 人員マスタの jobType / 職長割当からロールを判定（buildAuthUser と同じ）
 * @param ym 職長判定の対象月（"YYYY-MM" or "YYYYMM"）。省略時は当月。
 */
export interface ApiRole {
  role: UserRole | 'super-admin'
  workerId: number | null
  foremanSites: string[]
}

/** 承認・差し戻し等の管理操作を行える権限か（職長は不可・最終承認は管理者/事業責任者） */
/**
 * 賃金・給与などの最高機密APIに使う「代表・管理者のみ」の認証（2026-08-27 追加）。
 * admin / super-admin パスワード、または事業責任者（政仁さん workerId=1）の個人パスワードのみ許可。
 * checkApiAuth は任意の個人パスワードでも通るため、機密系には使わないこと。
 * 通れば null、拒否なら NextResponse を返す。
 */
export async function requireExecutiveAuth(request: NextRequest): Promise<Response | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const ok = auth.actor === 'super-admin' || auth.actor === 1
  if (!ok) {
    return NextResponse.json({ error: 'この操作は管理者・事業責任者のみ実行できます' }, { status: 403 })
  }
  return null
}

/**
 * 権限表（lib/permissions.ts）でサーバー側の可否を決める（2026-09-26）。
 * 代表 = super-admin、それ以外は本人（個人パスワード・職長の通行証）の役割。通れば null。
 * 担当現場の制限（職長は自分の現場だけ）は呼び出し側で別途チェックする。
 */
export async function requireCap(request: NextRequest, cap: Capability): Promise<Response | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await callerCan(request, cap)) return null
  return NextResponse.json({ error: `この操作の権限がありません（${CAPABILITIES[cap].label}）` }, { status: 403 })
}

/**
 * リクエスト元がそのことをできるか（requireCap と同じ判定を真偽で返す）。
 * 給与の権限（PAY_CAPS）は役割に加えて本人（PAY_VIEWER_WORKER_IDS）も確かめる（2026-10-02 代表）。
 * 代表パスワード・代表の通行証は workerId 0 として扱う。
 */
export async function callerCan(request: NextRequest, cap: Capability): Promise<boolean> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return false
  const r = await getApiRole(request)
  const role = permRoleOf(r ? { role: r.role } : null)
  const workerId = auth.actor === 'super-admin' ? OWNER_WORKER_ID : auth.actor
  return capAllowed(role, workerId, cap)
}

/**
 * 代表（super-admin パスワード）だけ（2026-09-26）。本番データを直接書き換える保守ツール（/api/debug/*）用。
 */
export async function requireSuperAdmin(request: NextRequest): Promise<Response | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (auth.actor !== 'super-admin') return NextResponse.json({ error: 'この操作は代表のみ実行できます' }, { status: 403 })
  return null
}

/**
 * 読み取り API で「中身を役割に合わせて絞る」ための役割（2026-09-26）。
 * main（30秒キャッシュ）を使うので Firestore 読み取りを増やさない。不明なら null。
 */
export async function getCallerPermRole(request: NextRequest): Promise<PermRole | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return null
  if (auth.actor === 'super-admin') return 'owner'
  const { getMainData } = await import('@/lib/compute')
  const main = await getMainData()
  const workers = mapRawWorkers((main.workers || []) as unknown[])
  const w = workers.find(x => x.id === auth.actor)
  if (!w) return null
  return permRoleOf({ role: buildAuthUser(w, main.sites as unknown as Site[], main.mforeman).role })
}

export function isManagerRole(role: string): boolean {
  return role === 'super-admin' || role === 'admin' || role === 'approver'
}

export async function getApiRole(request: NextRequest, ym?: string): Promise<ApiRole | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return null
  if (auth.actor === 'super-admin') return { role: 'super-admin', workerId: 0, foremanSites: [] }

  // 個人パスワード → 人員マスタから実ロールを解決
  // 2026-10-02: getMainData（30秒キャッシュ）経由に。requireCap / callerCan が1リクエストで何度も呼ぶため、
  //   毎回 main（約260KB）を読み直していた（CLAUDE.md「読み取り回数を増やさない」）
  const { getMainData } = await import('@/lib/compute')
  const main = (await getMainData()) as unknown as Record<string, unknown>
  // ⚠️ Firestore の生データは職種が `job`（Worker 型は `jobType`）。必ず mapRawWorkers で写像してから
  //   buildAuthUser に渡す（2026-09-26: 生のまま渡すと jobType が空になり、事務・役員の役割を取り違えた）
  const workers = mapRawWorkers((main.workers || []) as unknown[])
  const sites = (main.sites || []) as Site[]
  const mforeman = (main.mforeman || {}) as Record<string, { foreman?: number; wid?: number }>
  const worker = workers.find(w => w.id === auth.actor)
  if (!worker) return null

  const u = buildAuthUser(worker, sites, mforeman)
  const targetYm = ym ? ym.replace('-', '') : currentYm()
  const foremanSites = computeForemanSites(worker.id, sites, mforeman, targetYm)
  return { role: u.role, workerId: u.workerId, foremanSites }
}
