import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { recordAccess, getRequestIp, AccessRole } from '@/lib/accessLog'
import { getApiAuthUser } from '@/lib/auth'

/**
 * ハートビート API
 *
 * ユーザーが管理画面を開いている間、定期的にアクセスを記録する。
 * /api/auth は初回ログイン時しか呼ばれないため、日々のアクセス追跡には
 * このエンドポイントが必要。
 *
 * 認証（2026-09-26 以降）:
 * - スーパー管理者パスワード → workerId=0 で記録
 * - 個人パスワード・職長の通行証 → その workerId で記録（本人はサーバー側で特定。body の自己申告は使わない）
 * - 共通パスワードそのもの（通行証導入前にログインしたままの職長）→ 401。
 *   管理画面（app/(app)/layout.tsx）は 401 を受けるとログイン画面へ戻す＝ログインし直しで通行証に切り替わる
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getApiAuthUser(request)
    if (!auth.authorized) {
      return NextResponse.json({ error: 'Unauthorized', relogin: true }, { status: 401 })
    }

    if (auth.actor === 'super-admin') {
      await recordAccess({ workerId: 0, workerName: '日比靖仁', role: 'admin', org: 'hibi', ip: getRequestIp(request) })
      return NextResponse.json({ recorded: true })
    }
    if (typeof auth.actor !== 'number') {
      return NextResponse.json({ recorded: false, reason: 'identity not resolved' })
    }

    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    const workers = (mainData.workers || []) as { id: number; name: string; org?: string; job?: string; jobType?: string }[]
    const w = workers.find(x => x.id === auth.actor)
    if (!w) return NextResponse.json({ recorded: false, reason: 'identity not resolved' })

    // ロール判定（auth.ts の determineRole と整合）
    const job = w.jobType || w.job
    const role: AccessRole = w.id === 1 ? 'approver'
      : job === 'shokucho' ? 'foreman'
      : job === 'yakuin' ? 'approver'
      : job === 'jimu' ? 'jimu'
      : 'staff'

    await recordAccess({ workerId: w.id, workerName: w.name, role, org: w.org || 'hibi', ip: getRequestIp(request) })
    return NextResponse.json({ recorded: true })
  } catch (error) {
    console.error('Heartbeat error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
