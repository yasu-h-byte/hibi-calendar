/**
 * 通勤時間の自動測定（Vercel Cron: 朝5:30 JST / 夕17:30 JST）。
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

  // 2026-08-27 修正（給与総点検）:
  //   ① 朝夕そろったサンプルが規程の10営業日分たまったら自動測定を停止する
  //      （旧: 凍結ボタンが押されるまで無期限に測定・課金が続き、規程の
  //      「最初の10営業日」と判定材料が乖離していく）
  //   ② 手入力(manual)サンプルを cron が上書きしない
  //   ③ 書き戻しは「測定完了後に最新を読み直して該当現場だけ差し替え」方式にし、
  //      Routes API 呼び出し中（数秒〜十数秒）の管理者編集を潰す競合窓を最小化する
  const { COMMUTE_SAMPLE_TARGET } = await import('@/lib/allowance')
  const measurable = sites.filter(s => {
    if (s.archived) return false
    const c = s.commute
    if (!c?.address || c.judgedMin !== undefined) return false
    const complete = (c.samples || []).filter(x => (x.am ?? 0) > 0 && (x.pm ?? 0) > 0).length
    return complete < COMMUTE_SAMPLE_TARGET
  })

  const results: Record<string, number | null> = {}
  const measured = new Map<string, number>()
  for (const s of measurable) {
    const c = s.commute!
    const addr = c.address || ''
    const origin = slot === 'am' ? ORIGIN_ADDRESS : addr
    const dest = slot === 'am' ? addr : ORIGIN_ADDRESS
    const min = await measureMinutes(apiKey, origin, dest)
    results[s.id] = min
    if (min !== null) measured.set(s.id, min)
  }

  if (measured.size > 0) {
    // 最新の sites を読み直してから該当現場のサンプルだけ差し替える
    const snap2 = await getDoc(ref)
    const fresh = (snap2.exists() ? snap2.data().sites || [] : []) as Array<{ id: string; archived?: boolean; commute?: SiteCommuteData }>
    let changed = false
    const updated = fresh.map(s => {
      const min = measured.get(s.id)
      const c = s.commute
      if (min === undefined || s.archived || !c?.address || c.judgedMin !== undefined) return s
      const samples: CommuteSample[] = [...(c.samples || [])]
      const idx = samples.findIndex(x => x.date === todayIso)
      if (idx >= 0) {
        // 手入力済みの枠は尊重（管理者の判断を自動測定で潰さない）
        if (samples[idx].source === 'manual' && samples[idx][slot] !== undefined) return s
        samples[idx] = { ...samples[idx], [slot]: min }
      } else {
        samples.push({ date: todayIso, [slot]: min, source: 'auto' })
      }
      changed = true
      return { ...s, commute: { ...c, samples } }
    })
    if (changed) await updateDoc(ref, { sites: updated })
  }
  return NextResponse.json({ date: todayIso, slot, results })
}
