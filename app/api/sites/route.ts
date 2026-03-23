import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'

function checkAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD
  return !!(adminPassword && authHeader === adminPassword)
}

interface RawSite {
  id: string
  name: string
  start?: string
  end?: string
  foreman?: number
  archived?: boolean
  tobiRate?: number
  dokoRate?: number
}

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return { ref: docRef, data: docSnap.data() }
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ sites: [], assign: {}, workers: [] })
    }

    const { data } = result
    const rawSites = (data.sites || []) as RawSite[]
    const sites = rawSites.map(s => ({
      id: s.id,
      name: s.name,
      start: s.start || '',
      end: s.end || '',
      foreman: s.foreman || 0,
      archived: s.archived || false,
      tobiRate: (s as unknown as Record<string, unknown>).tobiRate as number || 0,
      dokoRate: (s as unknown as Record<string, unknown>).dokoRate as number || 0,
    }))

    const assign: Record<string, { workers: number[]; subcons: string[] }> = {}
    if (data.assign) {
      for (const [siteId, val] of Object.entries(data.assign as Record<string, Record<string, unknown>>)) {
        assign[siteId] = {
          workers: (val.workers as number[]) || [],
          subcons: (val.subcons as string[]) || [],
        }
      }
    }

    const workers = ((data.workers || []) as Record<string, unknown>[]).map(w => ({
      id: w.id as number,
      name: w.name as string,
      jobType: (w.job as string) || '',
      retired: (w.retired as string) || '',
    }))

    return NextResponse.json({ sites, assign, workers })
  } catch (error) {
    console.error('Failed to fetch sites:', error)
    return NextResponse.json({ error: 'Failed to fetch sites' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ error: 'No data found' }, { status: 404 })
    }

    const { ref, data } = result
    const sites = (data.sites || []) as RawSite[]

    if (action === 'add') {
      const { name, start, end, foreman, tobiRate, dokoRate } = body
      if (!name) {
        return NextResponse.json({ error: '現場名を入力してください' }, { status: 400 })
      }

      const newId = 'site_' + Date.now()
      const newSite: RawSite = {
        id: newId,
        name,
        start: start || '',
        end: end || '',
        foreman: Number(foreman) || 0,
        archived: false,
        tobiRate: Number(tobiRate) || 0,
        dokoRate: Number(dokoRate) || 0,
      }

      await updateDoc(ref, { sites: [...sites, newSite] })
      return NextResponse.json({ success: true, site: newSite })
    }

    if (action === 'update') {
      const { id, name, start, end, foreman, archived, tobiRate, dokoRate } = body
      if (!id) {
        return NextResponse.json({ error: 'id required' }, { status: 400 })
      }

      const idx = sites.findIndex(s => s.id === id)
      if (idx === -1) {
        return NextResponse.json({ error: 'Site not found' }, { status: 404 })
      }

      const updated = [...sites]
      updated[idx] = {
        ...updated[idx],
        ...(name !== undefined && { name }),
        ...(start !== undefined && { start }),
        ...(end !== undefined && { end }),
        ...(foreman !== undefined && { foreman: Number(foreman) }),
        ...(archived !== undefined && { archived: Boolean(archived) }),
        ...(tobiRate !== undefined && { tobiRate: Number(tobiRate) }),
        ...(dokoRate !== undefined && { dokoRate: Number(dokoRate) }),
      }

      await updateDoc(ref, { sites: updated })
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Sites POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
