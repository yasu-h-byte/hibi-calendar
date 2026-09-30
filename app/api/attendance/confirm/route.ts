/**
 * 月末の本人確認（2026-09-30）— 詳細は lib/attendance-confirm.ts
 *
 * GET  ?token=...        スタッフ本人: 確認する月の数字と、確認済みかどうか
 * POST {token, ym, status, note}  スタッフ本人: 「正しい」「まちがいがある」を記録
 * GET  ?ym=YYYYMM        事務所（monthly.view）: その月の確認状況の一覧
 *
 * 記録先: attConfirm/{ym}_{workerId}（1人1か月1件・上書き）。出面そのものは変えない。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs } from '@/lib/fsdb'
import { mapRawWorkers } from '@/lib/workers'
import { getAttendanceDoc } from '@/lib/attendance'
import { calendarSiteIdOf, type HierarchySite } from '@/lib/site-hierarchy'
import { todayJstIso } from '@/lib/date-utils'
import { requireCap } from '@/lib/auth'
import {
  confirmTargetYm, summarizeWorkerMonth, summaryFingerprint, mainSiteOfMonth, breakShortenMinFor,
  type AttConfirmDoc, type StaffMonthSummary,
} from '@/lib/attendance-confirm'
import type { AttendanceEntry } from '@/types'

async function loadWorkerByToken(token: string) {
  const snap = await getDoc(doc(db, 'demmen', 'main'))
  const main = (snap.exists() ? snap.data() : {}) as { workers?: unknown[]; sites?: HierarchySite[] }
  const worker = mapRawWorkers(main.workers || []).find(w => w.token === token) || null
  return { worker, sites: (main.sites || []) as HierarchySite[] }
}

async function buildSummary(
  worker: { id: number; hireDate?: string; retired?: string; breakShortenMin?: number; breakShortenFrom?: string },
  sites: HierarchySite[], ym: string, todayIso: string,
): Promise<StaffMonthSummary> {
  const d = (await getAttendanceDoc(ym)) as Record<string, AttendanceEntry | null>
  const mainSite = mainSiteOfMonth(d, worker.id, ym)
  let calDays: Record<string, string> | null = null
  if (mainSite) {
    const calId = `${calendarSiteIdOf(sites, mainSite)}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`
    try {
      const c = await getDoc(doc(db, 'siteCalendar', calId))
      const cal = c.exists() ? c.data() : null
      if (cal?.status === 'approved' && cal?.days) calDays = cal.days as Record<string, string>
    } catch { /* カレンダーが読めなければ日曜以外を仕事の日とみなす */ }
  }
  return summarizeWorkerMonth({
    d, workerId: worker.id, ym, calDays,
    hireDate: worker.hireDate, retired: worker.retired, todayIso,
    breakShortenMin: breakShortenMinFor(worker, ym) || undefined,
  })
}

export async function GET(request: NextRequest) {
  // auth: token があればスタッフ本人（自分の数字だけ）。無ければ下で requireCap('monthly.view')
  const token = request.nextUrl.searchParams.get('token')
  try {
    if (token) {
      const { worker, sites } = await loadWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const todayIso = todayJstIso()
      const ym = confirmTargetYm(todayIso)
      if (!ym) return NextResponse.json({ ym: null })
      const [summary, confSnap] = await Promise.all([
        buildSummary(worker, sites, ym, todayIso),
        getDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`)),
      ])
      const confirmation = confSnap.exists() ? (confSnap.data() as AttConfirmDoc) : null
      const stale = !!confirmation && confirmation.fingerprint !== summaryFingerprint(summary)
      return NextResponse.json({ ym, summary, confirmation, stale })
    }

    // 事務所向け一覧
    const denied = await requireCap(request, 'monthly.view')
    if (denied) return denied
    const ym = request.nextUrl.searchParams.get('ym') || ''
    if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym required' }, { status: 400 })
    const qs = await getDocs(query(collection(db, 'attConfirm'), where('ym', '==', ym)))
    const items = qs.docs.map(x => x.data() as AttConfirmDoc)
    return NextResponse.json({ ym, items })
  } catch (e) {
    console.error('attendance/confirm GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // auth: スタッフ本人のトークン（loadWorkerByToken）。記録するのは本人の確認だけ
  try {
    const body = await request.json().catch(() => ({}))
    const { token, ym, status } = body as { token?: string; ym?: string; status?: string }
    const note = String((body as { note?: unknown }).note ?? '').trim().slice(0, 500)
    if (!token || !ym || (status !== 'ok' && status !== 'issue')) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }
    if (status === 'issue' && !note) {
      return NextResponse.json({ error: 'どこがまちがっているか書いてください / Hãy viết chỗ sai' }, { status: 400 })
    }
    const { worker, sites } = await loadWorkerByToken(token)
    if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    const todayIso = todayJstIso()
    if (confirmTargetYm(todayIso) !== ym) {
      return NextResponse.json({ error: 'いまは確認できない月です / Hiện không thể xác nhận tháng này' }, { status: 400 })
    }
    // 数字は画面から受け取らず、サーバでもう一度数えて残す（あとで出面が変わったかを見分ける）
    const summary = await buildSummary(worker, sites, ym, todayIso)
    const rec: AttConfirmDoc = {
      ym, workerId: worker.id, workerName: worker.name, status,
      ...(status === 'issue' ? { note } : {}),
      summary, fingerprint: summaryFingerprint(summary), at: new Date().toISOString(),
    }
    await setDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`), rec)
    return NextResponse.json({ success: true, confirmation: rec })
  } catch (e) {
    console.error('attendance/confirm POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
