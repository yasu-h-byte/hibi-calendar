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
import { getMainData } from '@/lib/compute'
import { getAttendanceDoc } from '@/lib/attendance'
import { calendarSiteIdOf, type HierarchySite } from '@/lib/site-hierarchy'
import { todayJstIso } from '@/lib/date-utils'
import { requireCap } from '@/lib/auth'
import {
  confirmTargetYm, summarizeWorkerMonth, summaryFingerprint, mainSiteOfMonth, breakShortenMinFor,
  isConfirmStale, jstDateOf, type AttConfirmDoc, type StaffMonthSummary,
} from '@/lib/attendance-confirm'
import type { AttendanceEntry } from '@/types'

async function loadWorkerByToken(token: string) {
  // demmen/main は 30秒キャッシュ経由（点検 2026-09-30: 保存のたびに直接読んでいた）
  const main = await getMainData()
  const worker = mapRawWorkers(main.workers || []).find(w => w.token === token) || null
  return { worker, sites: (main.sites || []) as unknown as HierarchySite[] }
}

type SummaryWorker = { id: number; hireDate?: string; retired?: string; breakShortenMin?: number; breakShortenFrom?: string }

/** 出面ドキュメントは1回だけ読み、カレンダーは現場ごとに1回だけ読む */
function makeSummarizer(sites: HierarchySite[], ym: string, d: Record<string, AttendanceEntry | null>) {
  const calCache = new Map<string, Promise<Record<string, string> | null>>()
  const calOf = (mainSite: string) => {
    const calId = `${calendarSiteIdOf(sites, mainSite)}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`
    if (!calCache.has(calId)) {
      calCache.set(calId, getDoc(doc(db, 'siteCalendar', calId)).then(c => {
        const cal = c.exists() ? c.data() : null
        return cal?.status === 'approved' && cal?.days ? cal.days as Record<string, string> : null
      }).catch(() => null))  // カレンダーが読めなければ日曜以外を仕事の日とみなす
    }
    return calCache.get(calId)!
  }
  return async (worker: SummaryWorker, todayIso: string, beforeIso?: string): Promise<StaffMonthSummary> => {
    const mainSite = mainSiteOfMonth(d, worker.id, ym)
    const calDays = mainSite ? await calOf(mainSite) : null
    return summarizeWorkerMonth({
      d, workerId: worker.id, ym, calDays,
      hireDate: worker.hireDate, retired: worker.retired, todayIso, beforeIso,
      breakShortenMin: breakShortenMinFor(worker, ym) || undefined,
    })
  }
}

/**
 * 確認の記録が古くなったか。確認した日より前の範囲だけで比べる。
 * asOf の無い古い記録（2026-09-30 の初日分）は、確認した時刻から asOf を補って保存し直す（その時点では古くない扱い）
 */
async function staleOf(
  c: AttConfirmDoc, worker: SummaryWorker,
  summarize: (w: SummaryWorker, todayIso: string, beforeIso?: string) => Promise<StaffMonthSummary>,
): Promise<boolean> {
  const asOf = c.asOf || jstDateOf(c.at)
  const range = await summarize(worker, asOf, asOf)
  if (!c.fpAsOf) {
    const fpAsOf = summaryFingerprint(range)
    await setDoc(doc(db, 'attConfirm', `${c.ym}_${c.workerId}`), { asOf, fpAsOf }, { merge: true })
    c.asOf = asOf; c.fpAsOf = fpAsOf
    return false
  }
  return isConfirmStale(c, range)
}

export async function GET(request: NextRequest) {
  // auth: token があればスタッフ本人（自分の数字だけ）。無ければ下で requireCap('monthly.view')
  const token = request.nextUrl.searchParams.get('token')
  try {
    if (token) {
      const todayIso = todayJstIso()
      const ym = confirmTargetYm(todayIso)
      // 確認の期間外は何も読まない（人の照合もしない・読み取りを増やさない）
      if (!ym) return NextResponse.json({ ym: null })
      const { worker, sites } = await loadWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      const [d, confSnap] = await Promise.all([
        getAttendanceDoc(ym) as Promise<Record<string, AttendanceEntry | null>>,
        getDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`)),
      ])
      const summarize = makeSummarizer(sites, ym, d)
      const summary = await summarize(worker, todayIso)
      const confirmation = confSnap.exists() ? (confSnap.data() as AttConfirmDoc) : null
      const stale = confirmation ? await staleOf(confirmation, worker, summarize) : false
      return NextResponse.json({ ym, summary, confirmation, stale })
    }

    // 事務所向け一覧（確認したあとで出面が変わった人は stale: true → 月次集計で「要再確認」）
    const denied = await requireCap(request, 'monthly.view')
    if (denied) return denied
    const ym = request.nextUrl.searchParams.get('ym') || ''
    if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym required' }, { status: 400 })
    const qs = await getDocs(query(collection(db, 'attConfirm'), where('ym', '==', ym)))
    const confs = qs.docs.map(x => x.data() as AttConfirmDoc)
    if (confs.length === 0) return NextResponse.json({ ym, items: [] })
    const [main, d] = await Promise.all([getMainData(), getAttendanceDoc(ym) as Promise<Record<string, AttendanceEntry | null>>])
    const workers = mapRawWorkers(main.workers || [])
    const summarize = makeSummarizer((main.sites || []) as unknown as HierarchySite[], ym, d)
    const items = await Promise.all(confs.map(async c => {
      const w = workers.find(x => x.id === c.workerId)
      const stale = w ? await staleOf(c, w, summarize) : false
      return { ...c, stale }
    }))
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
    const d = (await getAttendanceDoc(ym)) as Record<string, AttendanceEntry | null>
    const summarize = makeSummarizer(sites, ym, d)
    const [summary, range] = await Promise.all([summarize(worker, todayIso), summarize(worker, todayIso, todayIso)])
    const rec: AttConfirmDoc = {
      ym, workerId: worker.id, workerName: worker.name, status,
      ...(status === 'issue' ? { note } : {}),
      summary, fingerprint: summaryFingerprint(summary), at: new Date().toISOString(),
      asOf: todayIso, fpAsOf: summaryFingerprint(range),
    }
    await setDoc(doc(db, 'attConfirm', `${ym}_${worker.id}`), rec)
    return NextResponse.json({ success: true, confirmation: rec })
  } catch (e) {
    console.error('attendance/confirm POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
