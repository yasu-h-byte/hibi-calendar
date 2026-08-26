/**
 * 賞与の配分（docs/wage-system.md 第7節）。
 *
 *   単価 = 原資 ÷ 合計点 → 各人 = 点数 × 単価（千円切り上げ）
 *
 * 業績連動は**原資の決定**に集約している。配分側に係数は掛けない。
 *
 * 試算だけだと「誰にいくら払ったか」が残らず、翌年の参考にできないため、
 * 確定した配分を jpBonuses に凍結して保存する。
 *
 * - GET  … 過去の支給記録＋直近改定の評語（初期値に使う）
 * - POST … 配分を確定して保存
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers'
import { allocateBonus, nextRevisionDate, type BonusMember, type Hyogo, type JpGrade } from '@/lib/jp-wage'
import { todayJstIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

interface BonusRecord {
  id: string
  label: string
  paidOn: string
  pool: number
  totalPoints: number
  unit: number
  allocations: Array<{ workerId: number; name: string; grade: string; hyogo: Hyogo; points: number; amount: number }>
  total: number
  actor: string
  savedAt: string
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const snap = await getDocs(collection(db, 'jpBonuses'))
  const records: BonusRecord[] = []
  snap.forEach(d => records.push({ id: d.id, ...(d.data() as Omit<BonusRecord, 'id'>) }))
  records.sort((a, b) => b.paidOn.localeCompare(a.paidOn))

  // 評語は年次改定で決めたものを初期値にする。賞与と昇給で別の評価を付けない
  const effective = nextRevisionDate(todayJstIso())
  const revSnap = await getDoc(doc(db, 'jpWageRevisions', effective))
  const entries = revSnap.exists()
    ? ((revSnap.data() as { entries?: Record<string, { hyogo?: Hyogo }> }).entries || {})
    : {}
  const hyogo: Record<string, Hyogo> = {}
  for (const [id, e] of Object.entries(entries)) if (e.hyogo) hyogo[id] = e.hyogo

  return NextResponse.json({ records, hyogoFrom: effective, hyogo })
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const label = String(body.label || '').trim()
  const paidOn = String(body.paidOn || todayJstIso())
  const pool = Number(body.pool) || 0
  const hyogoMap = (body.hyogo || {}) as Record<string, Hyogo>

  if (!label) return NextResponse.json({ error: '支給名が必要です' }, { status: 400 })
  if (pool <= 0) return NextResponse.json({ error: '原資を入力してください' }, { status: 400 })

  const workers = await getWorkers()
  const targets = workers
    .filter(w => !w.retired)
    .filter(w => !w.visaType || w.visaType === 'none')
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
    .filter(w => w.jpGrade)

  if (targets.length === 0) return NextResponse.json({ error: '対象者がいません' }, { status: 409 })

  const members: BonusMember[] = targets.map(w => ({
    workerId: w.id,
    grade: w.jpGrade as JpGrade,
    hyogo: hyogoMap[String(w.id)] || 'A',
  }))
  const { unit, totalPoints, allocations } = allocateBonus(pool, members)

  const id = `${paidOn}-${Date.now()}`
  const auth = await getApiAuthUser(request)
  const record: Omit<BonusRecord, 'id'> = {
    label, paidOn, pool, totalPoints, unit,
    allocations: allocations.map(a => ({
      workerId: a.workerId,
      name: targets.find(w => w.id === a.workerId)?.name || '',
      grade: a.grade, hyogo: a.hyogo, points: a.points, amount: a.amount,
    })),
    total: allocations.reduce((s, a) => s + a.amount, 0),
    actor: auth.authorized ? String(auth.actor) : 'unknown',
    savedAt: new Date().toISOString(),
  }
  await setDoc(doc(db, 'jpBonuses', id), record)
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-bonus-${id}`), { type: 'jpWage.bonus', ...record })
  } catch (e) {
    console.error('[jp-wage/bonus] auditTrail 書込失敗:', e)
  }

  return NextResponse.json({ ok: true, record: { id, ...record } })
}
