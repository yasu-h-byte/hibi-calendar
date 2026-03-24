import { NextRequest, NextResponse } from 'next/server'
import { getSites } from '@/lib/sites'
import { getWorkers } from '@/lib/workers'
import { buildAuthUser } from '@/lib/auth'

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
    return NextResponse.json({ user, superAdmin: true })
  }

  if (!adminPassword || password !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!workerId) {
    // Return worker list for selection
    const workers = await getWorkers()
    const staffList = workers
      .filter(w => !w.retired)
      .filter(w => w.jobType && ['yakuin', 'shokucho', 'jimu'].includes(w.jobType))
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
  return NextResponse.json({ user: authUser })
}
