import { NextRequest, NextResponse } from 'next/server'
import { getSites } from '@/lib/sites'
import { getWorkers } from '@/lib/workers'
import { buildAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { recordAccess, getRequestIp, AccessRole } from '@/lib/accessLog'

export async function POST(request: NextRequest) {
  const { password, workerId } = await request.json()
  const adminPassword = process.env.ADMIN_PASSWORD
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD

  // Super admin login: パスワードだけで直接管理者としてログイン
  if (superAdminPassword && password === superAdminPassword) {
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
    return NextResponse.json({ user, superAdmin: true })
  }

  // 個人パスワードチェック（役員・事務は個別パスワードで直接ログイン）
  if (!workerId) {
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    const userPasswords = (mainData.userPasswords || {}) as Record<string, string>

    // 入力されたパスワードが個人パスワードにマッチするか
    for (const [wid, pw] of Object.entries(userPasswords)) {
      if (pw && password === pw) {
        const [workers, sites] = await Promise.all([getWorkers(), getSites()])
        const worker = workers.find(w => w.id === Number(wid))
        if (worker) {
          const authUser = buildAuthUser(worker, sites)
          recordAccess({
            workerId: worker.id,
            workerName: worker.name,
            role: authUser.role as AccessRole,
            org: worker.company === 'HFU' ? 'hfu' : 'hibi',
            ip: getRequestIp(request),
          }).catch(() => {})
          return NextResponse.json({ user: authUser, directLogin: true })
        }
      }
    }
  }

  // 共通パスワードチェック
  if (!adminPassword || password !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!workerId) {
    // 名前選択リスト: 職長のみ表示（役員・事務は個別パスワードでログイン）
    const workers = await getWorkers()
    const staffList = workers
      .filter(w => !w.retired)
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

  const authUser = buildAuthUser(worker, sites)
  recordAccess({
    workerId: worker.id,
    workerName: worker.name,
    role: authUser.role as AccessRole,
    org: worker.company === 'HFU' ? 'hfu' : 'hibi',
    ip: getRequestIp(request),
  }).catch(() => {})
  return NextResponse.json({ user: authUser })
}
