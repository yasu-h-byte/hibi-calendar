/**
 * 本人確認（2026-09-30）— 詳細は lib/attendance-confirm.ts
 *
 * 確認するのは**前の月**。その月の全部の日に職長承認と最終承認（事業責任者）がそろってから出し、締めたら出さない。
 *
 * GET  ?token=...        スタッフ本人: 確認する月の数字と、確認済みかどうか（承認待ちなら waiting）
 * POST {token, ym, status, note}  スタッフ本人: 「正しい」「まちがいがある」を記録（承認がそろっているときだけ）
 * GET  ?ym=YYYYMM        事務所（monthly.view）: その月の確認状況の一覧
 * POST {action:'resolve', ym, workerId, reply?}  事務所（monthly.close）: 「まちがいがある」の連絡を対応済みにする
 *
 * 記録先: attConfirm/{ym}_{workerId}（1人1か月1件・上書き）。出面そのものは変えない。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs } from '@/lib/fsdb'
import { mapRawWorkers } from '@/lib/workers'
import { getMainData } from '@/lib/compute'
import { getAttendanceDoc } from '@/lib/attendance'
import { type HierarchySite } from '@/lib/site-hierarchy'
import { todayJstIso } from '@/lib/date-utils'
import { requireCap } from '@/lib/auth'
import { isMonthLockedInLocks } from '@/lib/locks'
import { confirmTargetYm, summaryFingerprint, type AttConfirmDoc } from '@/lib/attendance-confirm'
import { confirmMonthContext } from '@/lib/attendance-confirm-server'
import type { AttendanceEntry } from '@/types'

async function loadByToken(token: string) {
  // demmen/main は 30秒キャッシュ経由
  const main = await getMainData()
  const worker = mapRawWorkers(main.workers || []).find(w => w.token === token) || null
  return { main, worker, sites: (main.sites || []) as unknown as HierarchySite[] }
}

const monthRange = (ym: string) => {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  return { start: `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`, end: `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }
}

/** スタッフ本人に確認を出す月か（締めていない・在籍していた）。出さないなら null */
function staffTargetYm(main: { locks?: Record<string, boolean> }, worker: { hireDate?: string; retired?: string; company?: string }, todayIso: string): string | null {
  const ym = confirmTargetYm(todayIso)
  const org = worker.company === 'HFU' ? 'hfu' : 'hibi'
  if (isMonthLockedInLocks(main.locks, ym, org)) return null   // 締めたあとは出さない
  const r = monthRange(ym)
  if (worker.hireDate && worker.hireDate > r.end) return null
  if (worker.retired && worker.retired < r.start) return null
  return ym
}

export async function GET(request: NextRequest) {
  // auth: token があればスタッフ本人（自分の数字だけ）。無ければ下で requireCap('monthly.view')
  const token = request.nextUrl.searchParams.get('token')
  try {
    if (token) {
      const { main, worker, sites } = await loadByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const todayIso = todayJstIso()
      const ym = staffTargetYm(main, worker, todayIso)
      if (!ym) return NextResponse.json({ ym: null })
      const [d, confSnap] = await Promise.all([
        getAttendanceDoc(ym) as Promise<Record<string, AttendanceEntry | null>>,
        getDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`)),
      ])
      const ctx = confirmMonthContext(sites, ym, d)
      const ready = await ctx.readiness(worker)
      if (ready.noEntries) return NextResponse.json({ ym: null })
      // 承認前にした確認（2026-09-30 の初日分など）は数えない＝もう一度確認してもらう
      const raw = confSnap.exists() ? (confSnap.data() as AttConfirmDoc) : null
      const confirmation = raw?.afterApproval ? raw : null
      if (!ready.ready && !confirmation) {
        return NextResponse.json({ ym, waiting: true })
      }
      const summary = await ctx.summarize(worker, todayIso)
      const stale = confirmation ? await ctx.staleOf(confirmation, worker) : false
      return NextResponse.json({ ym, summary, confirmation, stale, ready: ready.ready })
    }

    // 事務所向け一覧（確認したあとで出面が変わった人は stale: true → 月次集計で「要再確認」。承認前の確認は early: true）
    const denied = await requireCap(request, 'monthly.view')
    if (denied) return denied
    const ym = request.nextUrl.searchParams.get('ym') || ''
    if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym required' }, { status: 400 })
    const qs = await getDocs(query(collection(db, 'attConfirm'), where('ym', '==', ym)))
    const confs = qs.docs.map(x => x.data() as AttConfirmDoc)
    if (confs.length === 0) return NextResponse.json({ ym, items: [] })
    const [main, d] = await Promise.all([getMainData(), getAttendanceDoc(ym) as Promise<Record<string, AttendanceEntry | null>>])
    const workers = mapRawWorkers(main.workers || [])
    const ctx = confirmMonthContext((main.sites || []) as unknown as HierarchySite[], ym, d)
    const items = await Promise.all(confs.map(async c => {
      const w = workers.find(x => x.id === c.workerId)
      const stale = w ? await ctx.staleOf(c, w) : false
      return { ...c, stale, early: !c.afterApproval }
    }))
    return NextResponse.json({ ym, items })
  } catch (e) {
    console.error('attendance/confirm GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/**
 * 事務所: 本人からの「まちがいがある」の連絡を対応済みにする（2026-09-30）。
 * 出面を直した場合は本人のスマホに「もう一度確認してください」が出る。直さなかった場合も、
 * 返事（reply）を書けば本人のスマホに出る。対応済みにすると通知ベル・月締めのチェックから外れる。
 */
async function resolveIssue(request: NextRequest, body: Record<string, unknown>) {
  const denied = await requireCap(request, 'monthly.close')
  if (denied) return denied
  const ym = String(body.ym || '')
  const workerId = Number(body.workerId)
  const reply = String(body.reply ?? '').trim().slice(0, 500)
  if (!/^\d{6}$/.test(ym) || !Number.isFinite(workerId)) return NextResponse.json({ error: 'ym と workerId が必要です' }, { status: 400 })
  const ref = doc(db, 'attConfirm', `${ym}_${workerId}`)
  const snap = await getDoc(ref)
  const c = snap.exists() ? (snap.data() as AttConfirmDoc) : null
  if (!c || c.status !== 'issue') return NextResponse.json({ error: '本人からの連絡がありません' }, { status: 404 })
  const { getApiAuthUser } = await import('@/lib/auth')
  const auth = await getApiAuthUser(request)
  const main = await getMainData()
  const by = !auth.authorized ? 'unknown'
    : auth.actor === 'super-admin' ? '代表'
    : (main.workers.find(w => w.id === auth.actor)?.name || `ID${auth.actor}`)
  const resolvedAt = new Date().toISOString()
  await setDoc(ref, { issueOpen: false, resolvedAt, resolvedBy: by, ...(reply ? { reply } : {}) }, { merge: true })
  try {
    const { logActivity } = await import('@/lib/activity')
    await logActivity('admin', 'attendance.confirm.resolve', `${c.workerName} ${ym} 本人の連絡を対応済み（${by}）${reply ? `: ${reply}` : ''}`)
  } catch { /* ログ失敗は本体に影響させない */ }
  return NextResponse.json({ success: true, resolvedAt, resolvedBy: by })
}

export async function POST(request: NextRequest) {
  // auth: スタッフ本人のトークン（loadByToken）。記録するのは本人の確認だけ。
  //   action:'resolve' は事務所（resolveIssue の中で requireCap('monthly.close')）
  try {
    const body = await request.json().catch(() => ({}))
    if ((body as { action?: string }).action === 'resolve') return await resolveIssue(request, body as Record<string, unknown>)
    const { token, ym, status } = body as { token?: string; ym?: string; status?: string }
    const note = String((body as { note?: unknown }).note ?? '').trim().slice(0, 500)
    if (!token || !ym || (status !== 'ok' && status !== 'issue')) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }
    if (status === 'issue' && !note) {
      return NextResponse.json({ error: 'どこがまちがっているか書いてください / Hãy viết chỗ sai' }, { status: 400 })
    }
    const { main, worker, sites } = await loadByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    const todayIso = todayJstIso()
    if (staffTargetYm(main, worker, todayIso) !== ym) {
      return NextResponse.json({ error: 'いまは確認できない月です / Hiện không thể xác nhận tháng này' }, { status: 400 })
    }
    const d = (await getAttendanceDoc(ym)) as Record<string, AttendanceEntry | null>
    const ctx = confirmMonthContext(sites, ym, d)
    const ready = await ctx.readiness(worker)
    if (!ready.ready) {
      return NextResponse.json({
        error: '職長と事業責任者のチェックが終わってから確認してください / Hãy xác nhận sau khi tổ trưởng và người phụ trách kiểm tra xong',
      }, { status: 409 })
    }
    // 数字は画面から受け取らず、サーバでもう一度数えて残す（あとで出面が変わったかを見分ける）
    const [summary, range] = await Promise.all([ctx.summarize(worker, todayIso), ctx.summarize(worker, todayIso, todayIso)])
    const rec: AttConfirmDoc = {
      ym, workerId: worker.id, workerName: worker.name, status,
      ...(status === 'issue' ? { note } : {}),
      summary, fingerprint: summaryFingerprint(summary), at: new Date().toISOString(),
      asOf: todayIso, fpAsOf: summaryFingerprint(range), afterApproval: true,
      ...(status === 'issue' ? { issueOpen: true } : {}),
    }
    await setDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`), rec)
    return NextResponse.json({ success: true, confirmation: rec })
  } catch (e) {
    console.error('attendance/confirm POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
