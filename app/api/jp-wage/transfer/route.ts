/**
 * 新卒（月給）→ 日給月給への移行（docs/wage-system.md 第13節・2026-11-11 代表決定）。
 *
 * 移行日 = 入社した翌年の10月1日以降で、18歳になっている最初の10月1日（lib/jp-transfer.ts）。
 * 号 = 1G で「月給 × 12 ÷ 251 を上回る最初の号」。
 *
 * 人員マスタを手で直すと、月給を消した瞬間に過去の月まで日額の計算に変わってしまう。
 * ここで確定すると、月給・日額とも「適用開始日」と「それより前の値」を一緒に書くので、
 * 移行日より前の月は月給のまま計算される。いつ・誰が・どの号に決めたかも jpTransfers に残す。
 *
 * - GET    … 移行を待っている人（予定日・予定の号）と、移行の記録
 * - POST   … 移行を確定（移行日以降だけ。その月が締め済みなら止める）
 * - DELETE … 確定の取り消し（その後に号や日額が動いていないときだけ）
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, setDoc, getDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers.server'
import { isAlreadyRetired } from '@/lib/workers'
import { updateWorker } from '@/lib/worker-crud'
import { checkMonthLockedForWorkers } from '@/lib/locks.server'
import { dailyForStep, MAX_STEP } from '@/lib/jp-wage'
import {
  isJpMonthlyTrainee, jpTransferSchedule, transferPlacement, transferStatus, JP_TRANSFER_GRADE,
} from '@/lib/jp-transfer'
import { todayJstIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

interface TransferRecord {
  id: string
  workerId: number
  name: string
  /** 移行日（日給月給の適用開始日） */
  at: string
  fromMonthly: number
  dailyFromMonthly: number
  toGrade: string
  /** 決まりどおりの号（上回る最初の号） */
  ruleStep: number
  toStep: number
  toDaily: number
  reason: string
  actor: string
  decidedAt: string
  cancelledAt?: string
  cancelledBy?: string
}

export async function GET(request: NextRequest) {
  { const denied = await requireCap(request, 'wage.decide'); if (denied) return denied }  // 賃金は代表・事業責任者のみ
  const today = todayJstIso()
  const workers = await getWorkers()
  const candidates = workers
    .filter(w => !isAlreadyRetired(w.retired, today))
    .filter(w => isJpMonthlyTrainee(w))
    .map(w => {
      const schedule = jpTransferSchedule(w.hireDate, w.birthDate)
      return {
        id: w.id, name: w.name, hireDate: w.hireDate || '',
        monthly: w.salary || 0,
        schedule, status: transferStatus(schedule, today),
        placement: transferPlacement(w.salary || 0),
      }
    })
  const snap = await getDocs(collection(db, 'jpTransfers'))
  const records: TransferRecord[] = []
  snap.forEach(d => records.push({ id: d.id, ...(d.data() as Omit<TransferRecord, 'id'>) }))
  records.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
  return NextResponse.json({ today, candidates, records })
}

export async function POST(request: NextRequest) {
  { const denied = await requireCap(request, 'wage.decide'); if (denied) return denied }
  const body = await request.json()
  const workerId = Number(body.workerId)
  const reason = String(body.reason || '').trim()
  if (!Number.isFinite(workerId)) return NextResponse.json({ error: 'workerId が不正です' }, { status: 400 })

  const today = todayJstIso()
  const w = (await getWorkers()).find(x => x.id === workerId)
  if (!w) return NextResponse.json({ error: '対象者が見つかりません' }, { status: 404 })
  if (isAlreadyRetired(w.retired, today)) return NextResponse.json({ error: '退職した人は移行できません' }, { status: 409 })
  if (!isJpMonthlyTrainee(w)) {
    return NextResponse.json({ error: 'この人は月給の新卒ではありません（すでに等級があるか、月給が入っていません）' }, { status: 409 })
  }
  const schedule = jpTransferSchedule(w.hireDate, w.birthDate)
  if (!schedule.date) {
    return NextResponse.json({ error: `移行日が決まりません: ${schedule.blockers.join('・')}。人員マスタに入れてください` }, { status: 409 })
  }
  // 移行日より前には確定しない。先に書くと、月給か日額かを生の値で見ている画面（有給精算の対象・人員マスタの表示など）が
  //   移行日の前から「日給月給の人」として扱ってしまう
  if (today < schedule.date) {
    return NextResponse.json({ error: `移行日（${schedule.date}）になってから確定してください。それまでは予定の号を見るだけです` }, { status: 409 })
  }
  const monthly = w.salary || 0
  const place = transferPlacement(monthly)
  const step = body.step == null || body.step === '' ? place.step : Math.trunc(Number(body.step))
  if (!Number.isFinite(step) || step < place.step || step > MAX_STEP) {
    return NextResponse.json({ error: `号は ${place.step}〜${MAX_STEP} の間で指定してください（月給を日額に直した額を下回る号にはできません）` }, { status: 400 })
  }
  // 決まりどおりでない号にするなら、なぜそうしたかを残す（翌年の改定・本人への説明で要る）
  if (step !== place.step && !reason) {
    return NextResponse.json({ error: '決まりの号から変えるときは理由が必要です' }, { status: 400 })
  }
  // 移行日の月が締め済みなら止める（締めたあとに支給額の計算方法が変わってしまう）
  const ym = schedule.date.slice(0, 4) + schedule.date.slice(5, 7)
  const locked = await checkMonthLockedForWorkers(ym, [workerId])
  if (locked) return NextResponse.json({ error: locked }, { status: 409 })

  const toDaily = dailyForStep(JP_TRANSFER_GRADE, step)
  await updateWorker(workerId, {
    jpGrade: JP_TRANSFER_GRADE,
    jpStep: step,
    rate: toDaily,
    rateFrom: schedule.date,
    prevRate: w.rate || 0,
    // 月給は移行日から 0（＝日額の計算へ）。それより前の月は prevSalary で月給のまま計算される
    salary: 0,
    salaryFrom: schedule.date,
    prevSalary: monthly,
  } as Record<string, unknown>, ['prevJpStep'])

  const auth = await getApiAuthUser(request)
  const actor = auth.authorized ? String(auth.actor) : 'unknown'
  const decidedAt = new Date().toISOString()
  const id = `${schedule.date}-${workerId}-${Date.now()}`
  const record: Omit<TransferRecord, 'id'> = {
    workerId, name: w.name, at: schedule.date,
    fromMonthly: monthly, dailyFromMonthly: place.dailyFromMonthly,
    toGrade: JP_TRANSFER_GRADE, ruleStep: place.step, toStep: step, toDaily,
    reason, actor, decidedAt,
  }
  await setDoc(doc(db, 'jpTransfers', id), record)
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-transfer-${id}`), {
      type: 'jpWage.transfer', ...record, at: decidedAt, effectiveDate: schedule.date,
    })
  } catch (e) {
    console.error('[jp-wage/transfer] auditTrail 書込失敗:', e)
  }
  return NextResponse.json({ ok: true, record: { id, ...record } })
}

export async function DELETE(request: NextRequest) {
  { const denied = await requireCap(request, 'wage.decide'); if (denied) return denied }
  const id = String(new URL(request.url).searchParams.get('id') || '')
  if (!id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  const ref = doc(db, 'jpTransfers', id)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: '記録が見つかりません' }, { status: 404 })
  const rec = snap.data() as Omit<TransferRecord, 'id'>
  if (rec.cancelledAt) return NextResponse.json({ error: 'すでに取り消されています' }, { status: 409 })

  const w = (await getWorkers()).find(x => x.id === rec.workerId)
  if (!w) return NextResponse.json({ error: '対象者が見つかりません' }, { status: 404 })
  // 確定のあとに年次改定・昇格・手直しで号や日額が動いていたら戻さない（その変更まで消してしまう）
  const untouched = w.jpGrade === rec.toGrade && w.jpStep === rec.toStep && w.rate === rec.toDaily
    && w.rateFrom === rec.at && w.salaryFrom === rec.at && !(w.salary && w.salary > 0)
  if (!untouched) {
    return NextResponse.json({ error: '確定のあとに号・日額が変わっているため取り消せません。人員マスタを確かめてください' }, { status: 409 })
  }
  const ym = rec.at.slice(0, 4) + rec.at.slice(5, 7)
  const locked = await checkMonthLockedForWorkers(ym, [rec.workerId])
  if (locked) return NextResponse.json({ error: locked }, { status: 409 })

  await updateWorker(rec.workerId, { salary: rec.fromMonthly, rate: w.prevRate ?? 0 } as Record<string, unknown>,
    ['jpGrade', 'jpStep', 'rateFrom', 'prevRate', 'salaryFrom', 'prevSalary'])

  const auth = await getApiAuthUser(request)
  const actor = auth.authorized ? String(auth.actor) : 'unknown'
  const cancelledAt = new Date().toISOString()
  // 記録は消さず「取り消し」を書き足す（あったことを残す）
  await setDoc(ref, { cancelledAt, cancelledBy: actor }, { merge: true })
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-transfer-cancel-${id}`), {
      type: 'jpWage.transferCancel', transferId: id, workerId: rec.workerId, name: rec.name,
      effectiveDate: rec.at, actor, at: cancelledAt,
    })
  } catch (e) {
    console.error('[jp-wage/transfer] auditTrail 書込失敗:', e)
  }
  return NextResponse.json({ ok: true })
}
