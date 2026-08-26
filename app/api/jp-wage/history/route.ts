/**
 * ベース年収の履歴（jpWageHistory/{workerId}）。
 *
 * 給料表の推移グラフの元データ。初期分は給料表の実物から転記した
 * `lib/jp-wage-history.ts` を投入し、以後は年次改定の確定時に積み上がる。
 *
 * - GET  … 全員分を返す
 * - POST … 初期データを投入（既にある年度は触らない・何度実行しても同じ結果）
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs } from '@/lib/fsdb'
import { WAGE_HISTORY_SEED, type AnnualPoint } from '@/lib/jp-wage-history'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const snap = await getDocs(collection(db, 'jpWageHistory'))
  const history: Record<string, AnnualPoint[]> = {}
  snap.forEach(d => { history[d.id] = ((d.data() as { points?: AnnualPoint[] }).points) || [] })
  return NextResponse.json({ history })
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const auth = await getApiAuthUser(request)
  const applied: string[] = []

  for (const [id, seed] of Object.entries(WAGE_HISTORY_SEED)) {
    const ref = doc(db, 'jpWageHistory', id)
    const cur = await getDoc(ref)
    const existing: AnnualPoint[] = cur.exists() ? ((cur.data() as { points?: AnnualPoint[] }).points || []) : []

    // 既にある年度は上書きしない。あとから改定で積んだ値を初期データで潰さないため
    const byYear = new Map(existing.map(p => [p.year, p]))
    let added = 0
    for (const p of seed) {
      if (byYear.has(p.year)) continue
      byYear.set(p.year, p); added += 1
    }
    if (added === 0) continue

    const points = [...byYear.values()].sort((a, b) => a.year - b.year)
    await setDoc(ref, {
      workerId: Number(id), points,
      updatedAt: new Date().toISOString(),
      source: '2025年10月改定版の給料表から転記',
      actor: auth.authorized ? String(auth.actor) : 'unknown',
    })
    applied.push(`worker ${id}: ${added}年度分`)
  }

  return NextResponse.json({ applied, count: applied.length })
}
