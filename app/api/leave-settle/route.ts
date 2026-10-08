import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where, updateDoc } from '@/lib/fsdb'
import { getWorkerByToken, isAlreadyRetired } from '@/lib/workers'
import { getMainData, getAttData, invalidateMainCache } from '@/lib/compute'
import { getLeaveBalance } from '@/lib/leave-balance'
import { selectActiveGrantRecord } from '@/lib/leave-compute'
import { checkMonthLockedForWorkers } from '@/lib/locks'
import { logActivity } from '@/lib/activity'
import { addMonthsSafe, todayJstIso, currentYmJst } from '@/lib/date-utils'
import { managerByToken } from '@/lib/foreman-todo'
import {
  LEAVE_SETTLE_FROM_YM, LEAVE_SETTLE_REASON, isLeaveSettleEligible, settleLimit, countPaidDaysInMonth,
  settledDaysForYm, lastDayOfYm, prevYm, ymLabel, type LeaveSettleRequest, type SettleLimit,
} from '@/lib/leave-settle'

/**
 * 有給精算（日本人の日給月給の人だけ・2026-10-08 代表決定）。決まりは lib/leave-settle.ts。
 *
 * GET  ?token=                  本人: 申請できる月と上限・自分の申請
 * GET  ?token=&scope=approvals  政仁さん・代表（マイページ）: 承認待ちの一覧
 * GET  （管理画面のパスワード）     休暇管理: 全員の申請（leave.view）
 * POST {action:'request', token, ym, days, reason?}   本人
 * POST {action:'cancel', token, id}                   本人（承認待ちだけ）
 * POST {action:'approve'|'reject'|'revoke', id, reason?, token?}
 *      管理画面（leave.finalApprove）か、政仁さん・代表のマイページ（token）。
 *      revoke は承認済みを取り消して残数を戻す（締めた月は不可）。
 *
 * 金額は返さない（日数だけ）。休暇管理を見られる人に個人の日額が見えないように。
 */

const SETTLE_COL = 'leaveSettleRequests'
type BuyoutEntry = { at: string; by: number | string; days: number; amount?: number; reason?: string; ym?: string; settleId?: string }
type PlRec = Record<string, unknown> & { grantDate?: string; buyoutHistory?: BuyoutEntry[]; buyoutDays?: number }

/** 申請できる月: 今月と前月（2026年10月分から・締めていない月だけ） */
function candidateYms(): string[] {
  const cur = currentYmJst()
  return [prevYm(cur), cur].filter(ym => ym >= LEAVE_SETTLE_FROM_YM)
}

async function listWorkerRequests(workerId: number): Promise<LeaveSettleRequest[]> {
  const snap = await getDocs(query(collection(db, SETTLE_COL), where('workerId', '==', workerId)))
  const out: LeaveSettleRequest[] = []
  snap.forEach(s => out.push({ ...(s.data() as LeaveSettleRequest), id: s.id }))
  return out.sort((a, b) => b.ym.localeCompare(a.ym))
}

/**
 * その人・その月の精算の上限。申請・承認とも同じこの関数で決める。
 * excludeId: 判定中の申請自身（承認待ちの合計から外す）
 */
async function limitFor(workerId: number, ym: string, excludeId?: string): Promise<SettleLimit & { grantDate: string }> {
  const today = todayJstIso()
  const asOf = ym === currentYmJst() ? today : lastDayOfYm(ym)
  const [main, balance, att, reqs] = await Promise.all([
    getMainData(),
    getLeaveBalance(workerId, asOf),
    getAttData(ym),
    listWorkerRequests(workerId),
  ])
  const records = (main.plData?.[String(workerId)] || []) as unknown as PlRec[]
  const pendingOtherDays = reqs
    .filter(r => r.status === 'pending' && r.id !== excludeId)
    .reduce((s, r) => s + (r.days || 0), 0)
  const settledInMonth = settledDaysForYm(records, ym) - (excludeId ? settledByIdIn(records, excludeId) : 0)
  const grantDate = balance.grantDate || ''
  const lim = settleLimit({
    hasGrant: !balance.noGrant && !!grantDate,
    grantDate,
    grantDays: balance.grantDays,
    remaining: balance.remaining,
    periodTaken: balance.periodUsed ?? 0,
    pendingOtherDays,
    paidDaysInMonth: countPaidDaysInMonth(att.d as Record<string, unknown>, workerId, ym),
    settledInMonth,
    todayIso: today,
    fiveDayDeadlineIso: grantDate ? addMonthsSafe(grantDate, 6) : '9999-12-31',
  })
  return { ...lim, grantDate }
}

function settledByIdIn(records: PlRec[], id: string): number {
  let n = 0
  for (const r of records) for (const h of r.buyoutHistory || []) if (h.settleId === id) n += h.days || 0
  return n
}

/** 承認の権限: 管理画面（leave.finalApprove）か、政仁さん・代表のマイページ */
async function approverOf(request: NextRequest, token?: string): Promise<{ actor: string } | Response> {
  if (token) {
    const mgr = await managerByToken(token)
    if (!mgr) return NextResponse.json({ error: 'この操作の権限がありません' }, { status: 403 })
    return { actor: `${mgr.name}（マイページ）` }
  }
  const denied = await requireCap(request, 'leave.finalApprove')
  if (denied) return denied
  const auth = await getApiAuthUser(request)
  return { actor: auth.authorized ? String(auth.actor) : 'unknown' }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')
    const scope = request.nextUrl.searchParams.get('scope')

    if (token && scope === 'approvals') {
      const mgr = await managerByToken(token)
      if (!mgr) return NextResponse.json({ requests: [] })
      const snap = await getDocs(query(collection(db, SETTLE_COL), where('status', '==', 'pending')))
      const main = await getMainData()
      const out: LeaveSettleRequest[] = []
      snap.forEach(s => {
        const r = { ...(s.data() as LeaveSettleRequest), id: s.id }
        r.workerName = main.workers.find(w => w.id === r.workerId)?.name || r.workerName
        out.push(r)
      })
      return NextResponse.json({ requests: out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)) })
    }

    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const main = await getMainData()
      const raw = main.workers.find(w => w.id === worker.id)
      if (!isLeaveSettleEligible(raw) || isAlreadyRetired(raw?.retired)) return NextResponse.json({ eligible: false })
      const cur = currentYmJst()
      const requests = await listWorkerRequests(worker.id)
      const months = await Promise.all(candidateYms().map(async ym => {
        const locked = await checkMonthLockedForWorkers(ym, [worker.id])
        if (locked) return { ym, label: ymLabel(ym, cur), maxDays: 0, blockReason: 'この月は締めが済んでいます', breakdown: null }
        const mine = requests.find(r => r.ym === ym && (r.status === 'pending' || r.status === 'approved'))
        if (mine) {
          return {
            ym, label: ymLabel(ym, cur), maxDays: 0, breakdown: null,
            blockReason: mine.status === 'pending'
              ? `${mine.days}日 を申請中です（日数を変えるときは、下の履歴から取り消して申請し直してください）`
              : `${mine.days}日 が承認済みです`,
          }
        }
        const lim = await limitFor(worker.id, ym, `${worker.id}_${ym}`)
        return { ym, label: ymLabel(ym, cur), maxDays: lim.maxDays, blockReason: lim.blockReason, breakdown: lim.breakdown }
      }))
      return NextResponse.json({ eligible: true, months, requests })
    }

    // 休暇管理（管理画面）
    const denied = await requireCap(request, 'leave.view')
    if (denied) return denied
    const snap = await getDocs(collection(db, SETTLE_COL))
    const main = await getMainData()
    const out: LeaveSettleRequest[] = []
    snap.forEach(s => {
      const r = { ...(s.data() as LeaveSettleRequest), id: s.id }
      r.workerName = main.workers.find(w => w.id === r.workerId)?.name || r.workerName
      out.push(r)
    })
    return NextResponse.json({ requests: out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) })
  } catch (e) {
    console.error('leave-settle GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = String(body.action || '')
    const nowIso = new Date().toISOString()

    // ── 本人の申請 ──
    if (action === 'request') {
      const worker = await getWorkerByToken(String(body.token || ''))
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const ym = String(body.ym || '')
      const days = Number(body.days)
      if (!candidateYms().includes(ym)) {
        return NextResponse.json({ error: '申請できるのは今月と前月だけです' }, { status: 400 })
      }
      if (!Number.isInteger(days) || days < 1) {
        return NextResponse.json({ error: '日数は1日単位で入れてください' }, { status: 400 })
      }
      const main = await getMainData()
      const raw = main.workers.find(w => w.id === worker.id)
      if (!isLeaveSettleEligible(raw) || isAlreadyRetired(raw?.retired)) {
        return NextResponse.json({ error: '有給精算は日給月給の人だけが使えます' }, { status: 403 })
      }
      const locked = await checkMonthLockedForWorkers(ym, [worker.id])
      if (locked) return NextResponse.json({ error: locked }, { status: 409 })

      const id = `${worker.id}_${ym}`
      const ref = doc(db, SETTLE_COL, id)
      const existing = await getDoc(ref)
      if (existing.exists()) {
        const st = (existing.data() as LeaveSettleRequest).status
        if (st === 'pending' || st === 'approved') {
          return NextResponse.json({
            error: st === 'pending'
              ? 'この月はすでに申請しています。日数を変えるときは、取り消してから申請し直してください'
              : 'この月はすでに承認されています。変えるときは事務に連絡してください',
          }, { status: 409 })
        }
      }
      const lim = await limitFor(worker.id, ym, id)
      if (days > lim.maxDays) {
        return NextResponse.json({
          error: lim.maxDays > 0 ? `この月に精算できるのは ${lim.maxDays}日 までです` : (lim.blockReason || '精算できません'),
        }, { status: 400 })
      }
      const rec: Omit<LeaveSettleRequest, 'id'> = {
        workerId: worker.id, workerName: worker.name, ym, days, status: 'pending', requestedAt: nowIso,
        ...(body.reason ? { reason: String(body.reason).slice(0, 200) } : {}),
      }
      await setDoc(ref, rec)
      await logActivity('staff', 'leaveSettle.request', `${worker.name} ${ymLabel(ym)}分 有給精算 ${days}日 を申請`)
      return NextResponse.json({ success: true })
    }

    // ── 本人の取り消し（承認待ちだけ） ──
    if (action === 'cancel') {
      const worker = await getWorkerByToken(String(body.token || ''))
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const ref = doc(db, SETTLE_COL, String(body.id || ''))
      const snap = await getDoc(ref)
      if (!snap.exists()) return NextResponse.json({ error: '申請が見つかりません' }, { status: 404 })
      const r = snap.data() as LeaveSettleRequest
      if (r.workerId !== worker.id) return NextResponse.json({ error: '本人の申請ではありません' }, { status: 403 })
      if (r.status !== 'pending') return NextResponse.json({ error: '承認待ちの申請だけ取り消せます' }, { status: 409 })
      await updateDoc(ref, { status: 'cancelled', decidedAt: nowIso, decidedBy: worker.name })
      await logActivity('staff', 'leaveSettle.cancel', `${worker.name} ${ymLabel(r.ym)}分 有給精算 ${r.days}日 を取り消し`)
      return NextResponse.json({ success: true })
    }

    // ── 承認・却下・承認の取り消し ──
    if (action === 'approve' || action === 'reject' || action === 'revoke') {
      const who = await approverOf(request, body.token ? String(body.token) : undefined)
      if (who instanceof Response) return who
      const id = String(body.id || '')
      const ref = doc(db, SETTLE_COL, id)
      const snap = await getDoc(ref)
      if (!snap.exists()) return NextResponse.json({ error: '申請が見つかりません' }, { status: 404 })
      const r = snap.data() as LeaveSettleRequest
      const label = `${r.workerName || r.workerId} ${ymLabel(r.ym)}分 有給精算 ${r.days}日`

      if (action === 'reject') {
        if (r.status !== 'pending') return NextResponse.json({ error: '承認待ちの申請だけ却下できます' }, { status: 409 })
        const reason = String(body.reason || '').trim()
        if (!reason) return NextResponse.json({ error: '却下の理由を入れてください' }, { status: 400 })
        await updateDoc(ref, { status: 'rejected', decidedAt: nowIso, decidedBy: who.actor, rejectedReason: reason.slice(0, 200) })
        await logActivity('admin', 'leaveSettle.reject', `${label} を却下（${reason}・${who.actor}）`)
        return NextResponse.json({ success: true })
      }

      const locked = await checkMonthLockedForWorkers(r.ym, [r.workerId])
      if (locked) return NextResponse.json({ error: locked }, { status: 409 })

      const mainRef = doc(db, 'demmen', 'main')
      const mainSnap = await getDoc(mainRef)
      if (!mainSnap.exists()) return NextResponse.json({ error: 'データが見つかりません' }, { status: 500 })
      const plData = (mainSnap.data().plData || {}) as Record<string, PlRec[]>
      const wRecords = plData[String(r.workerId)] || []

      if (action === 'approve') {
        if (r.status !== 'pending') return NextResponse.json({ error: '承認待ちの申請だけ承認できます' }, { status: 409 })
        const raw = (await getMainData()).workers.find(w => w.id === r.workerId)
        if (!isLeaveSettleEligible(raw)) {
          return NextResponse.json({ error: 'この人は日給月給ではないため精算できません（月給・役員・外国人は対象外）' }, { status: 400 })
        }
        // 申請のあとに有給を取った・出勤が増えた、などで上限が変わっていることがあるので、承認の時にもう一度判定する
        const lim = await limitFor(r.workerId, r.ym, id)
        if (r.days > lim.maxDays) {
          return NextResponse.json({
            error: `いまの上限は ${lim.maxDays}日 です（${lim.blockReason || '残数・年5日の枠・月24日のどれかを超えます'}）。却下して申請し直してもらってください`,
          }, { status: 400 })
        }
        const asOf = r.ym === currentYmJst() ? todayJstIso() : lastDayOfYm(r.ym)
        const target = selectActiveGrantRecord(wRecords, asOf)
        if (!target || target.grantDate !== lim.grantDate) {
          return NextResponse.json({ error: '有給の付与レコードが見つかりません' }, { status: 400 })
        }
        const history = target.buyoutHistory ?? []
        history.push({ at: nowIso, by: who.actor, days: r.days, reason: LEAVE_SETTLE_REASON, ym: r.ym, settleId: id })
        target.buyoutHistory = history
        target.buyoutDays = history.reduce((s, h) => s + (h.days || 0), 0)
        target.lastEditedAt = nowIso
        target.lastEditedBy = who.actor
        // 1人分だけ書き換える（/api/leave の買取記録と同じ dot-notation）
        await updateDoc(mainRef, { [`plData.${String(r.workerId)}`]: wRecords })
        invalidateMainCache()
        await updateDoc(ref, { status: 'approved', decidedAt: nowIso, decidedBy: who.actor, grantDate: target.grantDate })
        await logActivity('admin', 'leaveSettle.approve', `${label} を承認（${who.actor}）`)
        return NextResponse.json({ success: true })
      }

      // revoke: 承認済みを取り消して残数を戻す
      if (r.status !== 'approved') return NextResponse.json({ error: '承認済みの申請だけ取り消せます' }, { status: 409 })
      let removed = 0
      for (const rec of wRecords) {
        const history = rec.buyoutHistory ?? []
        const keep = history.filter(h => h.settleId !== id)
        if (keep.length === history.length) continue
        removed += history.length - keep.length
        rec.buyoutHistory = keep
        rec.buyoutDays = keep.reduce((s, h) => s + (h.days || 0), 0)
        rec.lastEditedAt = nowIso
        rec.lastEditedBy = who.actor
      }
      if (removed > 0) {
        await updateDoc(mainRef, { [`plData.${String(r.workerId)}`]: wRecords })
        invalidateMainCache()
      }
      await updateDoc(ref, { status: 'revoked', decidedAt: nowIso, decidedBy: who.actor })
      await logActivity('admin', 'leaveSettle.revoke', `${label} の承認を取り消し（${who.actor}）`)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    console.error('leave-settle POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
