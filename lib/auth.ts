import { AuthUser, UserRole, Site, Worker } from '@/types'

const APPROVER_ID = 1 // 日比政仁

export function determineRole(workerId: number, sites: Site[]): { role: UserRole; foremanSites: string[] } {
  const foremanSites = sites.filter(s => s.foreman === workerId).map(s => s.id)

  if (workerId === APPROVER_ID) {
    return { role: 'approver', foremanSites }
  }

  if (foremanSites.length > 0) {
    return { role: 'foreman', foremanSites }
  }

  return { role: 'admin', foremanSites: [] }
}

export function buildAuthUser(worker: Worker, sites: Site[]): AuthUser {
  const { role, foremanSites } = determineRole(worker.id, sites)
  return {
    workerId: worker.id,
    name: worker.name,
    role,
    foremanSites,
  }
}
