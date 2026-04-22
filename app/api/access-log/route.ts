import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getWorkerLastAccessMap, getAccessLogsInRange, AccessRole, WorkerLastAccess } from '@/lib/accessLog'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'

interface WorkerEntry {
  id: number
  name: string
  org: string
  visa?: string
  jobType?: string
  retired?: string
}

function determineRoleFromJob(w: WorkerEntry): AccessRole {
  if (w.jobType === 'shokucho') return 'foreman'
  if (w.jobType === 'yakuin') return 'approver'
  if (w.jobType === 'jimu') return 'jimu'
  if (w.visa && w.visa !== 'none') return 'staff'
  return 'staff'
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const days = parseInt(request.nextUrl.searchParams.get('days') || '30')
    const mode = request.nextUrl.searchParams.get('mode') || 'summary'  // 'summary' or 'detail'

    // 全スタッフ一覧取得
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const allWorkers: WorkerEntry[] = mainSnap.exists() ? (mainSnap.data().workers || []) : []
    const activeWorkers = allWorkers.filter(w => !w.retired)

    // アクセス履歴取得
    const accessMap = await getWorkerLastAccessMap(days)

    // detail モード: 期間内のログをそのまま返す
    if (mode === 'detail') {
      const from = new Date()
      from.setDate(from.getDate() - days)
      const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
      const today = new Date()
      const toStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const logs = await getAccessLogsInRange(fromStr, toStr)
      return NextResponse.json({ logs })
    }

    // summary モード（デフォルト）: 各スタッフ1行、最終アクセス情報
    const rows: (WorkerLastAccess & { currentRole: AccessRole })[] = activeWorkers.map(w => {
      const access = accessMap.get(w.id)
      const role = determineRoleFromJob(w)
      return {
        workerId: w.id,
        workerName: w.name,
        role: access?.role ?? role,
        currentRole: role,
        org: w.org || 'hibi',
        lastAccessDate: access?.lastAccessDate ?? null,
        lastAccessAt: access?.lastAccessAt ?? null,
        accessCountLast7Days: access?.accessCountLast7Days ?? 0,
      }
    })

    return NextResponse.json({ rows, days })
  } catch (error) {
    console.error('Access log GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
