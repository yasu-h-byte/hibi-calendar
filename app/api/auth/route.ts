import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getSites } from '@/lib/sites'
import { isAlreadyRetired } from '@/lib/workers'
import { getWorkers } from '@/lib/workers.server'
import { buildAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { recordAccess, getRequestIp, AccessRole } from '@/lib/accessLog'
import { createForemanToken, createOwnerToken, createPersonalToken } from '@/lib/session-token'
import { verifyPassword, passwordFingerprint } from '@/lib/password'
import { loginLockedUntil, recordLoginFailure, clearLoginFailures } from '@/lib/login-throttle.server'

/** 長さが違っても時間差が出ない比較（代表・共通パスワード用。2026-10-02 総合点検。旧: `===`） */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function POST(request: NextRequest) {
  // auth: public — ログインそのもの（ここで通行証を発行する）
  const { password, workerId } = await request.json()
  const adminPassword = process.env.ADMIN_PASSWORD
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD

  if (typeof password !== 'string' || !password) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 試行回数の制限（2026-10-21 代表決定: 15 分で 10 回失敗したら 15 分止める。lib/login-throttle.server.ts）
  const ip = getRequestIp(request)
  {
    const until = await loginLockedUntil(ip)
    if (until) {
      const min = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60000))
      return NextResponse.json({ error: `パスワードの間違いが続いたため、あと ${min} 分ほどログインできません` }, { status: 429 })
    }
  }

  // Super admin login: パスワードだけで直接管理者としてログイン
  if (superAdminPassword && safeEqual(password, superAdminPassword)) {
    const user = {
      workerId: 0,
      name: '日比靖仁',
      role: 'admin' as const,
      foremanSites: [],
    }
    recordAccess({
      workerId: 0,
      workerName: user.name,
      role: 'admin',
      org: 'hibi',
      ip: getRequestIp(request),
    }).catch(() => {})
    // 以降はパスワードではなく代表の通行証を送る（ブラウザにパスワードを残さない・2026-09-26）
    await clearLoginFailures(ip)
    return NextResponse.json({ user, superAdmin: true, sessionToken: createOwnerToken() })
  }

  // 個人パスワードチェック（役員・事務は個別パスワードで直接ログイン）
  //
  // ここの `!workerId` は「workerId が送られていない」の意味。日比靖仁さんの
  // workerId は 0 で falsy だが、下の名前選択リストは職長のみのため 0 は届かない。
  // リストに役員を載せる変更をするなら、ここを undefined 判定に変えること。
  if (!workerId) {
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    const userPasswords = (mainData.userPasswords || {}) as Record<string, string>

    // 入力されたパスワードが個人パスワードにマッチするか
    // 保存値はハッシュ（古い平文も照合可・lib/password.ts）
    for (const [wid, pw] of Object.entries(userPasswords)) {
      if (pw && verifyPassword(password, pw)) {
        const [workers, sites] = await Promise.all([getWorkers(), getSites()])
        const worker = workers.find(w => w.id === Number(wid))
        // 2026-10-02 総合点検: 退職日を過ぎた人は個人パスワードでログインできない（退職日の当日まで可）。
        //   旧: 代表がパスワードを消すまでログインできた
        if (worker && isAlreadyRetired(worker.retired)) {
          return NextResponse.json({ error: '退職日を過ぎているためログインできません' }, { status: 403 })
        }
        if (worker) {
          // 月別職長 override を反映
          const mforeman = (mainData.mforeman || {}) as Record<string, { foreman?: number; wid?: number }>
          const authUser = buildAuthUser(worker, sites, mforeman)
          recordAccess({
            workerId: worker.id,
            workerName: worker.name,
            role: authUser.role as AccessRole,
            org: worker.company === 'HFU' ? 'hfu' : 'hibi',
            ip: getRequestIp(request),
          }).catch(() => {})
          // 以降はパスワードではなく本人の通行証（パスワードの指紋入り）を送る
          await clearLoginFailures(ip)
          return NextResponse.json({ user: authUser, directLogin: true, sessionToken: createPersonalToken(worker.id, passwordFingerprint(pw)) })
        }
      }
    }
  }

  // 共通パスワードチェック（代表・個人・共通のどれにも合わなかった＝失敗を 1 回数える）
  if (!adminPassword || !safeEqual(password, adminPassword)) {
    await recordLoginFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await clearLoginFailures(ip)

  if (!workerId) {
    // 名前選択リスト: 職長のみ表示（役員・事務は個別パスワードでログイン）
    const workers = await getWorkers()
    // 2026-10-02 総合点検: 退職「予定」日（未来）が入っている職長もログインできる（旧: !w.retired で予定日を入れた瞬間に消えた）
    const staffList = workers
      .filter(w => !isAlreadyRetired(w.retired))
      .filter(w => w.jobType === 'shokucho')
      .map(w => ({ id: w.id, name: w.name }))
    return NextResponse.json({ workers: staffList })
  }

  // Build auth user with role
  const [workers, sites] = await Promise.all([getWorkers(), getSites()])
  const worker = workers.find(w => w.id === workerId)
  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
  }
  // 共通パスワードで選べるのは職長だけ（名前選択リストと同じ条件）。
  //   旧: workerId を書き換えれば政仁さん・役員として入れた
  if (worker.jobType !== 'shokucho' || isAlreadyRetired(worker.retired)) {
    return NextResponse.json({ error: 'この方は個人パスワードでログインしてください' }, { status: 403 })
  }

  // 月別職長 override を反映するため main.mforeman を取得
  const mainSnap2 = await getDoc(doc(db, 'demmen', 'main'))
  const mforeman = mainSnap2.exists()
    ? ((mainSnap2.data().mforeman || {}) as Record<string, { foreman?: number; wid?: number }>)
    : {}
  const authUser = buildAuthUser(worker, sites, mforeman)
  recordAccess({
    workerId: worker.id,
    workerName: worker.name,
    role: authUser.role as AccessRole,
    org: worker.company === 'HFU' ? 'hfu' : 'hibi',
    ip: getRequestIp(request),
  }).catch(() => {})
  // 以降の API には共通パスワードではなく、この職長の通行証を送る（lib/session-token.ts）
  return NextResponse.json({ user: authUser, sessionToken: createForemanToken(worker.id) })
}
