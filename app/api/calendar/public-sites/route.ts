import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkers } from '@/lib/sites'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { isCalendarSignTarget } from '@/lib/workers'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const ym = url.searchParams.get('ym')
  if (!ym) {
    return NextResponse.json({ error: 'ym required' }, { status: 400 })
  }

  try {
    // 5 つの独立した I/O を並列化（以前は sequential で 5 RTT、いまは 1 RTT 相当）
    const [calSnap, sitesWithWorkers, signSnap, homeLeaves, mainDoc] = await Promise.all([
      // approved カレンダーのみ
      getDocs(query(
        collection(db, 'siteCalendar'),
        where('ym', '==', ym),
        where('status', '==', 'approved'),
      )),
      getAllSitesWithWorkers(ym),
      getDocs(query(collection(db, 'calendarSign'), where('ym', '==', ym))),
      getAllActiveHomeLeaves(),
      getDoc(doc(db, 'demmen', 'main')),
    ])

    const approvedSites = new Set<string>()
    const approvedCalendars: Record<string, Record<string, string>> = {}
    calSnap.forEach(d => {
      const data = d.data()
      approvedSites.add(data.siteId)
      approvedCalendars[data.siteId] = data.days || {}
    })

    const sigs: Record<string, string> = {} // key: workerId_siteId, value: signedAt
    signSnap.forEach(d => {
      const data = d.data()
      sigs[`${data.workerId}_${data.siteId}`] = data.signedAt || 'true'
    })

    const ymKey = normalizeYm(ym)

    // 全期間帰国中の workerId 集合（共通フィルタで使う）
    const allRawWorkers = mainDoc.exists() ? ((mainDoc.data().workers || []) as Record<string, unknown>[]) : []
    const fullMonthHlIds = new Set(
      allRawWorkers
        .map(w => w.id as number)
        .filter(id => isFullMonthHomeLeave(id, ymKey, homeLeaves))
    )

    // Build site list (backwards compatible) — 配置済みスタッフ数ベースの旧仕様維持
    const sites = sitesWithWorkers
      .filter(sw => approvedSites.has(sw.site.id))
      .map(sw => {
        const eligibleWorkers = sw.workers.filter(w => !!w.token && !fullMonthHlIds.has(w.id))
        return {
          id: sw.site.id,
          name: sw.site.name,
          workerCount: eligibleWorkers.length,
          signedCount: eligibleWorkers.filter(w => sigs[`${w.id}_${sw.site.id}`]).length,
          days: approvedCalendars[sw.site.id] || {},
        }
      })

    // Build foreign workers list: ALL foreign workers × ALL approved sites
    // (全員が全現場のカレンダーに署名する方式 — 共通述語 isCalendarSignTarget で判定)
    const foreignWorkers = allRawWorkers.filter(w =>
      isCalendarSignTarget(
        { id: w.id as number, visa: w.visa as string, token: w.token as string, retired: w.retired as string | undefined },
        ym,
        fullMonthHlIds,
      )
    )

    const approvedSiteList = sitesWithWorkers.filter(sw => approvedSites.has(sw.site.id))

    const workers = foreignWorkers.map(w => {
      const wId = w.id as number
      const sites = approvedSiteList.map(sw => {
        const sigKey = `${wId}_${sw.site.id}`
        return {
          siteId: sw.site.id,
          siteName: sw.site.name,
          signed: !!sigs[sigKey],
          signedAt: sigs[sigKey] && sigs[sigKey] !== 'true' ? sigs[sigKey] : null,
        }
      })
      return {
        id: wId,
        name: w.name as string,
        nameVi: (w.nameVi as string) || '',
        token: w.token as string,
        sites,
        allSigned: sites.every(s => s.signed),
        unsignedCount: sites.filter(s => !s.signed).length,
      }
    })

    return NextResponse.json({ sites, workers })
  } catch (error) {
    console.error('Failed to fetch public sites:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
