/**
 * 号俸制への移行データ（等級・号数）を人員マスタへ投入する。
 *
 * 値は `lib/jp-wage-migration.ts` の MIGRATION_2026 が唯一の出所。手入力させないのは、
 * docs/wage-system.md 第12節の表と1円でもズレると改定額が狂うため。
 *
 * - GET  … 何が書き込まれるかを返すだけ（書き込まない）
 * - POST … 実際に投入する。既に同じ値なら触らない（何度実行しても同じ結果）
 *
 * 書き込みは `updateWorker` を通す。トランザクションで配列を安全に差し替えるのと、
 * 呼び出し側で auditTrail に残せるようにするため。
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, setDoc } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers'
import { updateWorker } from '@/lib/worker-crud'
import { MIGRATION_2026, MIGRATION_EXCLUDED } from '@/lib/jp-wage-migration'
import { dailyForStep } from '@/lib/jp-wage'

export const dynamic = 'force-dynamic'

type Action = 'set' | 'already' | 'hold'

interface PlanRow {
  id: number
  name: string
  action: Action
  grade: string
  step: number | null
  /** 号俸表の日額。調整給がある人は別途上乗せ */
  stepDaily: number | null
  adjustment: number | null
  /** 号俸額＋調整給。人員マスタの rate と一致するはず */
  total: number | null
  masterRate: number
  /** rate と total がズレていたら警告（移行表かマスタのどちらかが古い） */
  rateMismatch: boolean
  birthDate: string | null
  current: { jpGrade?: string; jpStep?: number }
  note?: string
}

function buildPlan(workers: Awaited<ReturnType<typeof getWorkers>>): {
  rows: PlanRow[]
  missingBirthDate: string[]
  mismatches: string[]
  notFound: number[]
} {
  const rows: PlanRow[] = []
  const notFound: number[] = []

  for (const m of MIGRATION_2026) {
    const w = workers.find(x => x.id === m.id)
    if (!w) { notFound.push(m.id); continue }

    const stepDaily = m.step === null ? null : dailyForStep(m.grade, m.step)
    const total = stepDaily === null ? null : stepDaily + (m.adjustment ?? 0)
    const already = w.jpGrade === m.grade && (w.jpStep ?? null) === m.step

    rows.push({
      id: m.id,
      name: w.name,
      action: m.step === null ? 'hold' : already ? 'already' : 'set',
      grade: m.grade,
      step: m.step,
      stepDaily,
      adjustment: m.adjustment ?? null,
      total,
      masterRate: w.rate ?? 0,
      // 移行は「日額を下げない読み替え」なので、号俸額＋調整給がマスタの日額を下回ってはいけない
      rateMismatch: total !== null && total < (w.rate ?? 0),
      birthDate: w.birthDate || null,
      current: { jpGrade: w.jpGrade, jpStep: w.jpStep },
      note: m.note,
    })
  }

  // 年齢調整に使うので、号俸制の対象者は生年月日が要る
  const missingBirthDate = workers
    .filter(w => !w.retired && !w.visaType.startsWith('jisshu') && !w.visaType.startsWith('tokutei'))
    .filter(w => !w.birthDate)
    .map(w => `${w.name}(ID ${w.id})`)

  const mismatches = rows.filter(r => r.rateMismatch)
    .map(r => `${r.name}: 号俸額+調整給 ${r.total} < マスタ日額 ${r.masterRate}`)

  return { rows, missingBirthDate, mismatches, notFound }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const workers = await getWorkers()
  const plan = buildPlan(workers)
  return NextResponse.json({
    dryRun: true,
    excluded: MIGRATION_EXCLUDED,
    ...plan,
    summary: {
      set: plan.rows.filter(r => r.action === 'set').length,
      already: plan.rows.filter(r => r.action === 'already').length,
      hold: plan.rows.filter(r => r.action === 'hold').length,
    },
  })
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const workers = await getWorkers()
  const plan = buildPlan(workers)

  if (plan.notFound.length > 0) {
    return NextResponse.json(
      { error: '移行表の workerId が人員マスタに存在しません', notFound: plan.notFound },
      { status: 409 },
    )
  }
  if (plan.mismatches.length > 0) {
    return NextResponse.json(
      { error: '号俸額がマスタの日額を下回ります。移行表かマスタのどちらかが古いままです', mismatches: plan.mismatches },
      { status: 409 },
    )
  }

  const applied: string[] = []
  for (const r of plan.rows) {
    if (r.action !== 'set' || r.step === null) continue
    await updateWorker(r.id, { jpGrade: r.grade, jpStep: r.step } as Record<string, unknown>)
    applied.push(`${r.name}: ${r.grade} ${r.step}号`)
  }

  // 等級は賃金に直結するので、削除されない証跡へ残す（労基法115条の3年）
  if (applied.length > 0) {
    const auth = await getApiAuthUser(request)
    try {
      await setDoc(doc(db, 'auditTrail', `jpwage-seed-${Date.now()}`), {
        type: 'jpWage.seed',
        applied,
        actor: auth.authorized ? String(auth.actor) : 'unknown',
        at: new Date().toISOString(),
      })
    } catch (e) {
      console.error('[jp-wage/seed] auditTrail 書込失敗:', e)
    }
  }

  return NextResponse.json({ applied, count: applied.length, held: plan.rows.filter(r => r.action === 'hold').map(r => r.name) })
}
