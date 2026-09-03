/**
 * 日本人社員の年1回の賃金改定（docs/wage-system.md 第4節・基準日 毎年10月1日）。
 *
 * 改定は「その場で計算して終わり」ではなく **記録として残す**。誰をどう評価し、
 * どういう根拠で号がいくつ動いたのかは、翌年の改定でも本人説明でも参照する。
 * `jpWageRevisions/{基準日}` に下書きを保存し、適用時に結果を凍結する。
 *
 * - GET    … 名簿＋保存済みの下書き＋計算結果
 * - PUT    … 下書きの保存（評語・理由・特別事由・利益率・対象者の上書き）
 * - POST   … 確定して人員マスタへ反映。結果を凍結し auditTrail に残す
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers'
import { updateWorker } from '@/lib/worker-crud'
import {
  computeRosterRevision, nextRevisionDate, lastRevisionDate, dailyForStep,
  SPECIAL_REASONS, HYOGO_PITCH, FIRST_REVISION_MIN_MONTHS,
  type RosterMember, type Hyogo, type JpGrade,
  TOTAL_PAID_DAYS,
} from '@/lib/jp-wage'
import { MIGRATION_2026 } from '@/lib/jp-wage-migration'
import { todayJstIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

interface Entry {
  hyogo: Hyogo
  reason?: string
  specialKeys?: string[]
  forceInclude?: boolean
  /** 給料表の右下に載せる本人向けのコメント */
  comment?: string
  /** 代表加算（裁量で足し引きする号数） */
  discretionaryPitch?: number
  /** 代表加算の理由。0以外なら必須 */
  discretionaryReason?: string
}
interface RevisionDoc {
  effective: string
  profitRatePercent: number | null
  status: 'draft' | 'applied'
  entries: Record<string, Entry>
  appliedAt?: string
  appliedBy?: string
  /** 適用時に凍結した結果。以後は計算し直さない */
  frozen?: unknown[]
  updatedAt?: string
}

const DEFAULT_ENTRY: Entry = { hyogo: 'A' }

function effectiveOf(request: NextRequest): string {
  return request.nextUrl.searchParams.get('effective') || ''
}

async function loadDoc(effective: string): Promise<RevisionDoc> {
  const snap = await getDoc(doc(db, 'jpWageRevisions', effective))
  if (snap.exists()) return snap.data() as RevisionDoc
  return { effective, profitRatePercent: null, status: 'draft', entries: {} }
}

/** 号俸制の対象者（日本人・在籍中・役員を除く）を名簿として組み立てる */
async function buildRoster(effective: string, entries: Record<string, Entry>) {
  const workers = await getWorkers()
  // 移行表の note（移籍調整給・処遇固定）は個人の属性なのでここで引く
  const seedById = new Map(MIGRATION_2026.map(m => [m.id, m]))

  const members: RosterMember[] = workers
    .filter(w => !w.retired)
    .filter(w => !w.visaType || w.visaType === 'none')   // 外国人は時給制の別制度
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
    .map(w => {
      const seed = seedById.get(w.id)
      const e = entries[String(w.id)] || DEFAULT_ENTRY
      return {
        id: w.id,
        name: w.name,
        grade: (w.jpGrade || seed?.grade || '1G') as JpGrade,
        currentStep: w.jpStep ?? seed?.step ?? null,
        birthDate: w.birthDate || null,
        hireDate: w.hireDate || null,
        hyogo: e.hyogo || 'A',
        reason: e.reason,
        specialKeys: e.specialKeys,
        discretionaryPitch: e.discretionaryPitch,
        discretionaryReason: e.discretionaryReason,
        forceInclude: e.forceInclude,
        fixed: seed?.fixed,
        adjustment: seed?.adjustment,
      } satisfies RosterMember
    })
    .sort((a, b) => (b.currentStep ?? 0) - (a.currentStep ?? 0))

  return { members, workers }
}

export async function GET(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  // 既定の表示対象（2026-08-27 修正・給与総点検）:
  //   旧: 常に「次回の基準日」→ 10/2 以降は確定したばかりの改定が画面から消え、
  //   翌年の空下書き（全員A）に切り替わっていた。誤ってそれを確定すると
  //   翌年分を1年前倒しで全員A確定できてしまう危険もあった。
  //   新: 次回まで60日以内なら次回（下書き作成期間）。それ以外は、直近の基準日の
  //   ドキュメントが存在すればそれ（確定済みの閲覧）、無ければ次回。
  let effective = effectiveOf(request)
  if (!effective) {
    const today = todayJstIso()
    const next = nextRevisionDate(today)
    const last = lastRevisionDate(today)
    const daysToNext = Math.round((Date.parse(next) - Date.parse(today)) / 86400000)
    if (daysToNext <= 60) {
      effective = next
    } else {
      const lastSnap = await getDoc(doc(db, 'jpWageRevisions', last))
      effective = lastSnap.exists() ? last : next
    }
  }
  const docData = await loadDoc(effective)
  const { members: liveMembers } = await buildRoster(effective, docData.entries)
  // 2026-09-03 修正: 確定済みの改定は「凍結した改定前の号」を現在値として再計算する。
  //   旧: 人員マスタの（反映後の）号を現在値にして計算し直していたため、確定直後の画面が
  //   「現在13号→新19号」のように評価分をもう一度乗せて見え、二重昇給と誤認された。
  const frozenById = new Map(((docData.frozen || []) as { workerId: number; oldStep: number | null; grade?: string }[])
    .map(f => [f.workerId, f]))
  const members = docData.status === 'applied' && frozenById.size > 0
    ? liveMembers.map(m => {
        const f = frozenById.get(m.id)
        return f ? { ...m, currentStep: f.oldStep, grade: (f.grade as JpGrade) || m.grade } : m
      })
    : liveMembers
  const revision = computeRosterRevision(members, { asOf: effective })
  // 給料表の推移グラフに使うので、履歴も一緒に返す
  const histSnap = await getDocs(collection(db, 'jpWageHistory'))
  const history: Record<string, { year: number; baseAnnual: number }[]> = {}
  histSnap.forEach(d => { history[d.id] = (d.data() as { points?: { year: number; baseAnnual: number }[] }).points || [] })

  return NextResponse.json({
    effective,
    history,
    status: docData.status,
    profitRatePercent: docData.profitRatePercent,
    appliedAt: docData.appliedAt ?? null,
    entries: docData.entries,
    frozen: docData.frozen ?? null,
    revision,
    meta: {
      specialReasons: SPECIAL_REASONS,
      hyogoPitch: HYOGO_PITCH,
      firstRevisionMinMonths: FIRST_REVISION_MIN_MONTHS,
    },
  })
}

export async function PUT(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  const body = await request.json()
  const effective = body.effective || nextRevisionDate(todayJstIso())
  const current = await loadDoc(effective)
  if (current.status === 'applied') {
    return NextResponse.json({ error: '適用済みの改定は編集できません' }, { status: 409 })
  }
  const next: RevisionDoc = {
    ...current,
    effective,
    profitRatePercent: body.profitRatePercent ?? current.profitRatePercent,
    entries: body.entries ?? current.entries,
    updatedAt: new Date().toISOString(),
  }
  await setDoc(doc(db, 'jpWageRevisions', effective), next)
  return NextResponse.json({ ok: true, effective })
}

export async function POST(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  const body = await request.json()
  const effective = body.effective || nextRevisionDate(todayJstIso())
  const docData = await loadDoc(effective)
  if (docData.status === 'applied') {
    return NextResponse.json({ error: 'この改定は既に適用済みです', appliedAt: docData.appliedAt }, { status: 409 })
  }
  const { members } = await buildRoster(effective, docData.entries)
  const revision = computeRosterRevision(members, { asOf: effective })

  // 入力が足りない人が1人でもいたら適用しない（一部だけ反映されるのが一番困る）
  const blocked = revision.rows.filter(r => r.status === 'blocked')
  if (blocked.length > 0) {
    return NextResponse.json({
      error: '入力が足りない対象者がいます',
      blocked: blocked.map(r => ({ name: r.member.name, reasons: r.blockers })),
    }, { status: 409 })
  }
  if (!revision.balance.ok) {
    return NextResponse.json({ error: '評語のバランスが取れていません', messages: revision.balance.messages }, { status: 409 })
  }

  const auth = await getApiAuthUser(request)
  const actor = auth.authorized ? String(auth.actor) : 'unknown'
  const frozen = revision.rows.map(r => ({
    workerId: r.member.id,
    name: r.member.name,
    status: r.status,
    grade: r.member.grade,
    oldStep: r.member.currentStep,
    newStep: r.result?.newStep ?? r.member.currentStep,
    hyogo: r.member.hyogo,
    reason: r.member.reason ?? null,
    discretionaryReason: r.member.discretionaryReason ?? null,
    comment: docData.entries[String(r.member.id)]?.comment ?? null,
    birthDate: r.member.birthDate,
    hireDate: r.member.hireDate ?? null,
    pitches: r.result
      ? {
          hyogo: r.result.hyogoPitch, age: r.result.agePitch, special: r.result.specialPitch,
          discretionary: r.result.discretionaryPitch, total: r.result.totalPitch,
        }
      : null,
    oldDaily: r.oldTotal,
    newDaily: r.newTotal,
    raisePerDay: r.result?.raisePerDay ?? 0,
    adjustment: r.member.adjustment ?? null,
    tenureMonths: r.tenureMonths,
    blockers: r.blockers,
  }))

  // 人員マスタへ反映。号が動いた人だけ触る。
  // 2026-08-27 追加（給与総点検）: 冪等化。確定処理が途中失敗した後の再実行で、
  //   前回反映済みの人（jpStep と rate が既に新値）にもう一度ピッチが乗る
  //   「二重昇給」を防ぐ。マスタの現在値と付き合わせてから書く
  const { getWorkers } = await import('@/lib/workers')
  const currentWorkers = await getWorkers()
  const applied: string[] = []
  const skippedAlready: string[] = []
  for (const r of revision.rows) {
    if (r.status !== 'ok' || !r.result || r.result.raisePerDay === 0) continue
    const cur = currentWorkers.find(w => w.id === r.member.id)
    if (cur && cur.jpStep === r.result.newStep && cur.rate === r.newTotal) {
      skippedAlready.push(r.member.name)
      continue
    }
    await updateWorker(r.member.id, {
      jpStep: r.result.newStep,
      rate: r.newTotal!,   // 号俸額＋調整給。日額は下げない
      // 2026-09-03 追加: 適用開始日と改定前の値。基準日より前の月の給与計算は prevRate で行う
      //   （旧: 9/3 に確定すると 9 月分の給与まで 10/1 施行の日額になっていた）
      rateFrom: effective,
      prevRate: cur?.rate ?? r.oldTotal ?? null,
      prevJpStep: cur?.jpStep ?? r.member.currentStep ?? null,
    } as Record<string, unknown>)
    applied.push(`${r.member.name}: ${r.member.currentStep}号→${r.result.newStep}号 ¥${r.oldTotal}→¥${r.newTotal}`)
  }

  // 確定した年度のベース年収を履歴へ積む（次回以降の推移グラフの元になる）
  const fiscalYear = Number(effective.slice(0, 4)) + 1
  for (const r of revision.rows) {
    if (r.newTotal == null) continue
    const ref = doc(db, 'jpWageHistory', String(r.member.id))
    const cur = await getDoc(ref)
    const points = (cur.exists() ? ((cur.data() as { points?: { year: number; baseAnnual: number }[] }).points || []) : [])
      .filter(p => p.year !== fiscalYear)
    points.push({ year: fiscalYear, baseAnnual: r.newTotal * TOTAL_PAID_DAYS })
    points.sort((a, b) => a.year - b.year)
    await setDoc(ref, { workerId: r.member.id, points, updatedAt: new Date().toISOString() })
  }

  await setDoc(doc(db, 'jpWageRevisions', effective), {
    ...docData, effective, status: 'applied',
    appliedAt: new Date().toISOString(), appliedBy: actor,
    frozen,
  })
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-revision-${effective}-${Date.now()}`), {
      type: 'jpWage.revision', effective, applied, actor, at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[jp-wage/revision] auditTrail 書込失敗:', e)
  }

  return NextResponse.json({ ok: true, effective, applied, count: applied.length, annualCost: revision.annualCost })
}
