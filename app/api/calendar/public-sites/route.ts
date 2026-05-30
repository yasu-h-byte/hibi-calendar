import { NextResponse } from 'next/server'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const ym = url.searchParams.get('ym')
  if (!ym) {
    return NextResponse.json({ error: 'ym required' }, { status: 400 })
  }

  try {
    const m = await loadCalendarMatrix(ym)

    // Build site list (backwards compatible) — 配置済みスタッフ数ベースの旧仕様維持
    const sites = m.sitesWithWorkers
      .filter(sw => m.approvedSiteIds.has(sw.site.id))
      .map(sw => {
        const eligibleWorkers = sw.workers.filter(w => !!w.token && !m.fullMonthHlIds.has(w.id))
        const cal = m.siteCalendars[sw.site.id]
        return {
          id: sw.site.id,
          name: sw.site.name,
          workerCount: eligibleWorkers.length,
          signedCount: eligibleWorkers.filter(w => m.signaturesBySite[`${w.id}_${sw.site.id}`]).length,
          days: cal?.days || {},
        }
      })

    // Worker × Site のマトリックス（公開ページの全員 × 全現場モデル）
    const approvedSiteList = m.sitesWithWorkers.filter(sw => m.approvedSiteIds.has(sw.site.id))
    const workers = m.eligibleForeignWorkers.map(w => {
      const sitesArr = approvedSiteList.map(sw => {
        const sigKey = `${w.id}_${sw.site.id}`
        const sigVal = m.signaturesBySite[sigKey]
        return {
          siteId: sw.site.id,
          siteName: sw.site.name,
          signed: !!sigVal,
          signedAt: sigVal && sigVal !== 'true' ? sigVal : null,
        }
      })
      return {
        id: w.id,
        name: w.name,
        nameVi: w.nameVi,
        token: w.token,
        sites: sitesArr,
        allSigned: sitesArr.every(s => s.signed),
        unsignedCount: sitesArr.filter(s => !s.signed).length,
      }
    })

    return NextResponse.json({ sites, workers })
  } catch (error) {
    console.error('Failed to fetch public sites:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
