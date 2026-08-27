/**
 * 昇格（docs/wage-system.md 第9節）。
 *
 * 等級が上がったときの号の読み替えと、その記録。
 *   ① 新等級で「現在の日額を上回る最初の号」に読み替える
 *   ② その号に当期の合計ピッチを加算する（年次改定と同時に昇格する場合）
 *
 * 人員マスタを書き換えるだけだと「いつ・なぜ昇格したか」が残らない。
 * 翌年の改定でも本人説明でも参照するため、jpPromotions に履歴として積む。
 *
 * - GET  … 昇格の履歴（新しい順）
 * - POST … 昇格を実行し、人員マスタと履歴を更新
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, setDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers'
import { updateWorker } from '@/lib/worker-crud'
import { promote, dailyForStep, capDaily, GRADE_LABELS, type JpGrade } from '@/lib/jp-wage'
import { todayJstIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

interface PromotionRecord {
  id: string
  workerId: number
  name: string
  at: string
  fromGrade: string
  fromStep: number | null
  fromDaily: number
  toGrade: string
  toStep: number
  toDaily: number
  addPitch: number
  reason: string
  actor: string
}

export async function GET(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  const snap = await getDocs(collection(db, 'jpPromotions'))
  const records: PromotionRecord[] = []
  snap.forEach(d => records.push({ id: d.id, ...(d.data() as Omit<PromotionRecord, 'id'>) }))
  records.sort((a, b) => b.at.localeCompare(a.at))
  return NextResponse.json({ records })
}

export async function POST(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  const body = await request.json()
  const workerId = Number(body.workerId)
  const toGrade = String(body.toGrade || '') as JpGrade
  const addPitch = Math.max(0, Math.trunc(Number(body.addPitch) || 0))
  const reason = String(body.reason || '').trim()
  const at = String(body.at || todayJstIso())

  if (!Number.isFinite(workerId)) return NextResponse.json({ error: 'workerId が不正です' }, { status: 400 })
  if (!(toGrade in GRADE_LABELS)) return NextResponse.json({ error: '等級が不正です' }, { status: 400 })
  // 役割が変わったという判断そのものなので、理由が無いと後から追えない
  if (!reason) return NextResponse.json({ error: '昇格の理由が必要です' }, { status: 400 })

  const workers = await getWorkers()
  const w = workers.find(x => x.id === workerId)
  if (!w) return NextResponse.json({ error: '対象者が見つかりません' }, { status: 404 })
  if (w.jpGrade === toGrade) return NextResponse.json({ error: '同じ等級です' }, { status: 409 })

  const fromDaily = w.rate ?? 0
  if (fromDaily <= 0) return NextResponse.json({ error: '現在の日額が未設定です' }, { status: 409 })
  if (fromDaily > capDaily(toGrade)) {
    return NextResponse.json({
      error: `現在の日額 ¥${fromDaily.toLocaleString()} が ${toGrade} の上限 ¥${capDaily(toGrade).toLocaleString()} を超えています`,
    }, { status: 409 })
  }

  const p = promote(toGrade, fromDaily, addPitch)

  await updateWorker(workerId, {
    jpGrade: toGrade,
    jpStep: p.newStep,
    rate: p.newDaily,   // 読み替えで日額は下がらない。調整給があれば上位等級で吸収される
  } as Record<string, unknown>)

  const auth = await getApiAuthUser(request)
  const actor = auth.authorized ? String(auth.actor) : 'unknown'
  const id = `${at}-${workerId}-${Date.now()}`
  const record: Omit<PromotionRecord, 'id'> = {
    workerId, name: w.name, at,
    fromGrade: w.jpGrade || '', fromStep: w.jpStep ?? null, fromDaily,
    toGrade, toStep: p.newStep, toDaily: p.newDaily,
    addPitch, reason, actor,
  }
  await setDoc(doc(db, 'jpPromotions', id), record)
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-promotion-${id}`), {
      type: 'jpWage.promotion', ...record, at: new Date().toISOString(), effectiveDate: at,
    })
  } catch (e) {
    console.error('[jp-wage/promotion] auditTrail 書込失敗:', e)
  }

  return NextResponse.json({ ok: true, record: { id, ...record }, readStep: p.readStep })
}
