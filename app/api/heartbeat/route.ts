import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { recordAccess, getRequestIp, AccessRole } from '@/lib/accessLog'

/**
 * ハートビート API
 *
 * ユーザーが管理画面を開いている間、定期的にアクセスを記録する。
 * /api/auth は初回ログイン時しか呼ばれないため、日々のアクセス追跡には
 * このエンドポイントが必要。
 *
 * 認証:
 * - x-admin-password ヘッダで認証（既存のAPIと同じパターン）
 * - スーパー管理者パスワード → workerId=0 で記録
 * - 個人パスワード → 該当する workerId で記録
 * - 共通パスワード → workerId/name の指定が必要
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('x-admin-password')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminPassword = process.env.ADMIN_PASSWORD
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD

    // bodyから現在ログインしているユーザー情報を取得（クライアントから送ってもらう）
    const body = await request.json().catch(() => ({}))
    const { workerId, workerName, role } = body as {
      workerId?: number
      workerName?: string
      role?: AccessRole
    }

    let recordWorkerId: number | null = null
    let recordWorkerName: string | null = null
    let recordRole: AccessRole | null = null
    let recordOrg = 'hibi'

    // ① スーパー管理者パスワード
    if (superAdminPassword && authHeader === superAdminPassword) {
      recordWorkerId = 0
      recordWorkerName = '日比靖仁'
      recordRole = 'admin'
      recordOrg = 'hibi'
    }
    // ② 個人パスワード（main.userPasswords）
    else {
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const mainData = mainSnap.exists() ? mainSnap.data() : {}
      const userPasswords = (mainData.userPasswords || {}) as Record<string, string>
      const workers = (mainData.workers || []) as { id: number; name: string; org?: string; jobType?: string }[]

      // 個人パスワードと一致するかチェック
      let matchedWorkerId: number | null = null
      for (const [wid, pw] of Object.entries(userPasswords)) {
        if (pw && authHeader === pw) {
          matchedWorkerId = Number(wid)
          break
        }
      }

      if (matchedWorkerId !== null) {
        const w = workers.find(w => w.id === matchedWorkerId)
        if (w) {
          recordWorkerId = w.id
          recordWorkerName = w.name
          recordOrg = w.org || 'hibi'
          // ロール判定（auth.ts の determineRole と整合）
          if (w.id === 1) recordRole = 'approver'
          else if (w.jobType === 'shokucho') recordRole = 'foreman'
          else if (w.jobType === 'yakuin') recordRole = 'approver'
          else if (w.jobType === 'jimu') recordRole = 'jimu'
          else recordRole = 'staff'
        }
      }
      // ③ 共通パスワード（admin password）— body の workerId/role が必要
      else if (adminPassword && authHeader === adminPassword && workerId !== undefined) {
        const w = workers.find(w => w.id === workerId)
        if (w) {
          recordWorkerId = w.id
          recordWorkerName = w.name
          recordOrg = w.org || 'hibi'
          if (role) {
            recordRole = role
          } else if (w.id === 1) recordRole = 'approver'
          else if (w.jobType === 'shokucho') recordRole = 'foreman'
          else if (w.jobType === 'yakuin') recordRole = 'approver'
          else if (w.jobType === 'jimu') recordRole = 'jimu'
          else recordRole = 'staff'
        } else if (workerName) {
          // 人員マスタにない workerId（workerId=0 の社長など）
          recordWorkerId = workerId
          recordWorkerName = workerName
          recordRole = role || 'admin'
        }
      }
    }

    // 認証OKだが ID 特定できなかった場合
    if (recordWorkerId === null || !recordWorkerName || !recordRole) {
      // 認証は通っているのでエラーにしない（無視して終了）
      return NextResponse.json({ recorded: false, reason: 'identity not resolved' })
    }

    // 記録（同日は accessCount を増やすだけ）
    await recordAccess({
      workerId: recordWorkerId,
      workerName: recordWorkerName,
      role: recordRole,
      org: recordOrg,
      ip: getRequestIp(request),
    })

    return NextResponse.json({ recorded: true })
  } catch (error) {
    console.error('Heartbeat error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
