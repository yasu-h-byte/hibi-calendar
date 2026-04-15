import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    if (!snap.exists()) return NextResponse.json({ subcons: [], siteAssign: {}, sites: [] })
    const data = snap.data()

    // Build subcon -> sites assignment map and per-site rate override map
    const assign = (data.assign || {}) as Record<string, {
      workers?: number[]
      subcons?: string[]
      subconRates?: Record<string, { rate?: number; otRate?: number }>
    }>
    const sites = ((data.sites || []) as { id: string; name: string; archived?: boolean }[])
      .filter(s => !s.archived)
      .map(s => ({ id: s.id, name: s.name }))

    const subconSites: Record<string, string[]> = {}
    const subconRates: Record<string, Record<string, { rate?: number; otRate?: number }>> = {}
    for (const [siteId, val] of Object.entries(assign)) {
      const subs = (val.subcons || []) as string[]
      for (const scId of subs) {
        if (!subconSites[scId]) subconSites[scId] = []
        subconSites[scId].push(siteId)
      }
      // per-site rate overrides
      if (val.subconRates) {
        for (const [scId, rateOv] of Object.entries(val.subconRates)) {
          if (!subconRates[scId]) subconRates[scId] = {}
          subconRates[scId][siteId] = rateOv
        }
      }
    }

    return NextResponse.json({ subcons: data.subcons || [], subconSites, subconRates, sites })
  } catch (error) {
    console.error('Subcons GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const { action } = body
    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Data not found' }, { status: 404 })
    const subcons = (snap.data().subcons || []) as Record<string, unknown>[]

    if (action === 'add') {
      const { name, type, rate, otRate, note } = body
      if (!name) return NextResponse.json({ error: '名前を入力してください' }, { status: 400 })
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20) + '_' + Date.now().toString(36).slice(-4)
      const newSubcon = { id, name, type: type || '鳶業者', rate: Number(rate) || 0, otRate: Number(otRate) || 0, note: note || '' }
      subcons.push(newSubcon)
      await updateDoc(docRef, { subcons })
      await logActivity('admin', 'subcon.add', `${name} を追加`)
      return NextResponse.json({ success: true, subcon: newSubcon })
    }

    if (action === 'update') {
      const { id, ...updates } = body
      delete updates.action
      const idx = subcons.findIndex(s => s.id === id)
      if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (updates.rate !== undefined) updates.rate = Number(updates.rate)
      if (updates.otRate !== undefined) updates.otRate = Number(updates.otRate)
      subcons[idx] = { ...subcons[idx], ...updates }
      await updateDoc(docRef, { subcons })
      await logActivity('admin', 'subcon.update', `${id} を更新`)
      return NextResponse.json({ success: true })
    }

    if (action === 'updateSiteRates') {
      const { subconId, siteRates } = body as {
        subconId: string
        siteRates: Record<string, number | null>
      }
      if (!subconId || !siteRates || typeof siteRates !== 'object') {
        return NextResponse.json({ error: 'subconId and siteRates required' }, { status: 400 })
      }

      const assign = (snap.data().assign || {}) as Record<string, {
        workers?: number[]
        subcons?: string[]
        subconRates?: Record<string, { rate?: number; otRate?: number }>
      }>

      // 各現場について、単価を設定 or 削除
      for (const [siteId, rate] of Object.entries(siteRates)) {
        if (!assign[siteId]) assign[siteId] = {}
        const currentRates = assign[siteId].subconRates || {}

        if (rate === null || rate === 0 || !rate) {
          // 削除: その現場・外注先のoverrideを消す
          delete currentRates[subconId]
        } else {
          // 設定: 日次単価のみ（otRateは設定せず getSubconRate 側で自動計算）
          currentRates[subconId] = { rate: Number(rate) }
        }

        // subconRatesが空になったらフィールドごと削除して綺麗に
        if (Object.keys(currentRates).length === 0) {
          delete assign[siteId].subconRates
        } else {
          assign[siteId].subconRates = currentRates
        }
      }

      await updateDoc(docRef, { assign })
      await logActivity('admin', 'subcon.updateSiteRates', `${subconId} の現場別単価を更新`)
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      const filtered = subcons.filter(s => s.id !== id)
      if (filtered.length === subcons.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await updateDoc(docRef, { subcons: filtered })
      await logActivity('admin', 'subcon.delete', `${id} を削除`)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Subcons POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
