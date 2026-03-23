import { db } from './firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { AttendanceEntry, AttendanceStatus, AttendanceApproval, Site } from '@/types'

// ────────────────────────────────────────
//  日付ヘルパー
// ────────────────────────────────────────

const DOW_JP = ['にちようび', 'げつようび', 'かようび', 'すいようび', 'もくようび', 'きんようび', 'どようび']
const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

export function ymKey(y: number, m: number): string {
  return `${y}${String(m).padStart(2, '0')}`
}

export function formatDateJP(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_JP[date.getDay()]
  return `${m}がつ ${d}にち（${dow}）`
}

export function formatDateShort(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_SHORT[date.getDay()]
  return `${m}/${d}（${dow}）`
}

export function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${String(day).padStart(2, '0')}`
}

// ────────────────────────────────────────
//  出面ステータス判定
// ────────────────────────────────────────

export function getEntryStatus(entry: AttendanceEntry | null | undefined): AttendanceStatus {
  if (!entry) return 'none'
  if (entry.p && entry.p === 1) return 'leave'
  if (entry.r && entry.r === 1) return 'rest'
  if (entry.h && entry.h === 1) return 'site_off'
  if (entry.w === 1 && entry.o && entry.o > 0) return 'overtime'
  if (entry.w === 1) return 'work'
  return 'none'
}

export function getStatusLabel(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return 'しゅっきん'
    case 'overtime': return 'しゅっきん'
    case 'rest': return 'やすみ'
    case 'leave': return 'ゆうきゅう'
    case 'site_off': return 'げんばやすみ'
    case 'none': return 'みにゅうりょく'
  }
}

export function getStatusEmoji(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return '🔨'
    case 'overtime': return '🔨'
    case 'rest': return '🏠'
    case 'leave': return '🌴'
    case 'site_off': return '🚧'
    case 'none': return '—'
  }
}

export function getStatusColor(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return 'bg-blue-100 text-blue-700'
    case 'overtime': return 'bg-orange-100 text-orange-700'
    case 'rest': return 'bg-gray-100 text-gray-500'
    case 'leave': return 'bg-green-100 text-green-700'
    case 'site_off': return 'bg-yellow-100 text-yellow-700'
    case 'none': return 'bg-red-50 text-red-400'
  }
}

// ────────────────────────────────────────
//  Firestore読み書き: att_YYYYMM
// ────────────────────────────────────────

export async function getAttendanceDoc(ym: string): Promise<Record<string, AttendanceEntry>> {
  const docRef = doc(db, 'demmen', `att_${ym}`)
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return {}
  return (docSnap.data().d as Record<string, AttendanceEntry>) || {}
}

export async function setAttendanceEntry(
  siteId: string,
  workerId: number,
  ym: string,
  day: number,
  entry: AttendanceEntry
): Promise<void> {
  const key = attKey(siteId, workerId, ym, day)
  const docRef = doc(db, 'demmen', `att_${ym}`)
  // setDoc with merge + dot-notation field path for atomic single-key update
  await setDoc(docRef, { d: { [key]: entry } }, { merge: true })
}

// ────────────────────────────────────────
//  Firestore読み書き: attendanceApprovals
// ────────────────────────────────────────

export async function getApprovalForDay(
  siteId: string,
  ym: string,
  day: number
): Promise<AttendanceApproval | null> {
  const docId = `${siteId}_${ym}_${String(day).padStart(2, '0')}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return docSnap.data() as AttendanceApproval
}

export async function setApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
  foremanId: number
): Promise<void> {
  const docId = `${siteId}_${ym}_${String(day).padStart(2, '0')}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  await setDoc(docRef, {
    foreman: { by: foremanId, at: new Date().toISOString() }
  }, { merge: true })
}

// ────────────────────────────────────────
//  スタッフの現場一覧取得（assign + massign対応）
// ────────────────────────────────────────

export async function getStaffSites(workerId: number): Promise<{ id: string; name: string }[]> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return []

  const data = mainDoc.data()
  const sites = (data.sites || []) as { id: string; name: string; archived?: boolean }[]
  const assign = (data.assign || {}) as Record<string, { workers?: number[] }>
  const massign = (data.massign || {}) as Record<string, { workers?: number[] }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  const result: { id: string; name: string }[] = []

  for (const site of sites) {
    if (site.archived) continue

    // Check monthly override first, then default assignment
    const monthKey = `${site.id}_${ym}`
    const monthAssign = massign[monthKey]
    const defaultAssign = assign[site.id]

    const workers = monthAssign?.workers || defaultAssign?.workers || []
    if (workers.includes(workerId)) {
      result.push({ id: site.id, name: site.name })
    }
  }

  return result
}

// ────────────────────────────────────────
//  職長の担当現場取得
// ────────────────────────────────────────

export async function getForemanSite(foremanId: number): Promise<Site | null> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return null

  const data = mainDoc.data()
  const sites = (data.sites || []) as Record<string, unknown>[]
  const mforeman = (data.mforeman || {}) as Record<string, { foreman?: number }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  for (const s of sites) {
    if (s.archived) continue
    const siteId = s.id as string

    // Check monthly foreman override
    const monthKey = `${siteId}_${ym}`
    const monthForeman = mforeman[monthKey]?.foreman
    const defaultForeman = s.foreman as number

    if ((monthForeman || defaultForeman) === foremanId) {
      return {
        id: siteId,
        name: s.name as string,
        start: (s.start as string) || '',
        end: (s.end as string) || '',
        foreman: foremanId,
        archived: false,
      }
    }
  }
  return null
}

// ────────────────────────────────────────
//  現場のスタッフ一覧（外国人のみ）
// ────────────────────────────────────────

export async function getForeignWorkersForSite(
  siteId: string
): Promise<{ id: number; name: string; nameVi?: string; visa: string }[]> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return []

  const data = mainDoc.data()
  const workers = (data.workers || []) as Record<string, unknown>[]
  const assign = (data.assign || {}) as Record<string, { workers?: number[] }>
  const massign = (data.massign || {}) as Record<string, { workers?: number[] }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  const monthKey = `${siteId}_${ym}`
  const monthAssign = massign[monthKey]
  const defaultAssign = assign[siteId]
  const workerIds = new Set(monthAssign?.workers || defaultAssign?.workers || [])

  return workers
    .filter(w => {
      const id = w.id as number
      const visa = w.visa as string
      return workerIds.has(id) && visa && visa !== 'none'
    })
    .map(w => ({
      id: w.id as number,
      name: w.name as string,
      nameVi: (w.nameVi as string) || undefined,
      visa: w.visa as string,
    }))
}
