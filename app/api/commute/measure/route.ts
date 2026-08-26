/**
 * 通勤時間の自動測定（Vercel Cron: 朝6:00 JST / 夕17:30 JST）。
 *
 * Google Routes API（交通状況込み）で 清瀬本社⇄現場 の所要時間をその場で測り、
 * 測定中（judgedMin 未凍結）の現場にサンプルとして追記する。
 * サンプルは日時つきで残る＝旅費規程の「測定方法」の証跡になる。
 *
 * 必要な環境変数:
 * - CRON_SECRET            … backup/snapshot と同じ方式の認証
 * - GOOGLE_MAPS_API_KEY    … Routes API を有効にしたキー。未設定なら何もせず204
 *
 * 呼び出し時刻で朝便/夕便を自動判別する（JST 12時前=朝、以降=夕）。
 * 日曜は測定しない（規程の「営業日」に合わせる。土曜は稼働があるため測る）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { todayJstIso } from '@/lib/date-utils'
import type { SiteCommuteData, CommuteSample } from '@/types'

export const dynamic = 'force-dynamic'

/** 出発地（清瀬本社）。規程に書く測定条件の一部なので変更時は規程も直すこと。 */
const ORIGIN_ADDRESS = '東京都清瀬市中里2-1620-1'

async function measureMinutes(apiKey: string, origin: string, destination: string): Promise<number | null> {
  // Routes API: departureTime を少し先に置くと TRAFFIC_AWARE の現在交通で計算される
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration',
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: new Date(Date.now() + 60_000).toISOString(),
      languageCode: 'ja',
    }),
  })
  if (!res.ok) {
    console.error('[commute/measure] Routes API error', res.status, await res.text())
    return null
  }
  const j = await res.json()
  const dur = j.routes?.[0]?.duration as string | undefined   // 例 "5581s"
  if (!dur) return null
  return Math.round(Number(dur.replace('s', '')) / 60)
}

export async function GET(request: NextRequest) {
  // backup/snapshot と同じ認証方式
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  const auth = request.headers.get('authorization')
  const qs = request.nextUrl.searchParams.get('secret')
  if (auth !== `Bearer ${secret}` && qs !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    // キー未設定は正常系（手入力運用）。エラーにしない
    return NextResponse.json({ skipped: 'GOOGLE_MAPS_API_KEY not set' }, { status: 200 })
  }

  const todayIso = todayJstIso()
  const jstHour = (new Date().getUTCHours() + 9) % 24
  const slot: 'am' | 'pm' = jstHour < 12 ? 'am' : 'pm'
  const dow = new Date(todayIso + 'T00:00:00Z').getUTCDay()
  if (dow === 0) return NextResponse.json({ skipped: '日曜は測定しない' })

  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: 'main not found' }, { status: 404 })
  const sites = (snap.data().sites || []) as Array<{ id: string; name: string; archived?: boolean; commute?: SiteCommuteData }>

  const results: Record<string, number | null> = {}
  let changed = false
  const updated = sites.map(s => {
    if (s.archived) return s
    const c = s.commute
    if (!c?.address || c.judgedMin !== undefined) return s
    return s   // 実測は下の for で（map 内で await できないため印だけ）
  })

  for (let i = 0; i < updated.length; i++) {
    const s = updated[i]
    const c = s.commute
    if (s.archived || !c?.address || c.judgedMin !== undefined) continue
    const origin = slot === 'am' ? ORIGIN_ADDRESS : c.address
    const dest = slot === 'am' ? c.address : ORIGIN_ADDRESS
    const min = await measureMinutes(apiKey, origin, dest)
    results[s.id] = min
    if (min === null) continue
    const samples: CommuteSample[] = [...(c.samples || [])]
    const idx = samples.findIndex(x => x.date === todayIso)
    if (idx >= 0) samples[idx] = { ...samples[idx], [slot]: min, source: 'auto' }
    else samples.push({ date: todayIso, [slot]: min, source: 'auto' })
    updated[i] = { ...s, commute: { ...c, samples } }
    changed = true
  }

  if (changed) await updateDoc(ref, { sites: updated })
  return NextResponse.json({ date: todayIso, slot, results })
}
