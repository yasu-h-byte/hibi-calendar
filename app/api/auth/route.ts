import { NextRequest, NextResponse } from 'next/server'
import { getSites } from '@/lib/sites'
import { getWorkers } from '@/lib/workers'
import { buildAuthUser } from '@/lib/auth'

export async function POST(request: NextRequest) {
  const { password, workerId } = await request.json()
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || password !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!workerId) {
    // Return worker list for selection
    const workers = await getWorkers()
    const staffList = workers
      .filter(w => !w.token || w.jobType === '役員' || w.jobType === '職長')
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
