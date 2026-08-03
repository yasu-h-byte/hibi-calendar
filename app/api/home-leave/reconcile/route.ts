import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDocs, collection, updateDoc, deleteField } from '@/lib/fsdb'
import { getAttendanceDoc, ymKey } from '@/lib/attendance'
import { ensureDocExists } from '@/lib/firestore-safe'
import { checkMonthLocked } from '@/lib/locks'
import type { AttendanceEntry } from '@/types'

/**
 * 出面の帰国フラグ(hk) と帰国申請(homeLongLeave) の突合・掃除（2026-08-03 追加）
 *
 * ■ 何のためか
 *   hk は承認時に出面へ書き込まれる実体データだが、2026-08-03 以前は期間の変更・
 *   削除・手動登録が出面へ同期されていなかった。そのため「どの申請にも紐づかない
 *   孤立した hk」が過去データに残っている（グエン タイン フウ 2026-07-24〜08-31）。
 *   書き込み側は lib/home-leave-sync.ts で根治したが、既に壊れたデータは
 *   別途ここで洗い出して消す必要がある。
 *
 * ■ なぜ API なのか（scripts/*.mjs ではなく）
 *   Admin SDK 移行（2026-06-29）で Firestore ルールが deny-by-default になり、
 *   ローカルの scripts/*.mjs は Web SDK 経由のため permission-denied で動かない。
 *   サービスアカウントは Vercel の環境変数にしか無いので、サーバ側で実行するしかない。
 *
 * ■ 使い方（2段構え。いきなり消さない）
 *   GET  /api/home-leave/reconcile        … 検出のみ（読み取り専用）
 *   POST /api/home-leave/reconcile {"fix":true} … 検出した孤立フラグを削除
 *
 *   クエリ: ?from=YYYYMM （既定 202512） / ?to=YYYYMM （既定 今月+12ヶ月）
 *
 * ■ 安全弁
 *   - ロック済みの月は検出はするが絶対に書き換えない（給与確定後のデータを動かさない）
 *   - 実績（出勤 w>0 / 有給 p / 休み r / 現場休 h / 試験 exam）がある日は hk だけ落とす
 *   - 承認済み・職長承認済みのどちらかの期間に入っている日は「正しい hk」として残す
 */

interface OrphanDay {
  ym: string
  day: number
  date: string
  siteId: string
  workerId: number
  /** 実績が混ざっているか（true なら hk フィールドのみ削除、false ならエントリごと削除） */
  hasOtherData: boolean
  locked: boolean
}

/** 出面キー `{siteId}_{workerId}_{ym}_{day}` を後ろから分解する（siteId に _ が入っても安全） */
function parseAttKey(key: string): { siteId: string; workerId: number; ym: string; day: number } | null {
  const parts = key.split('_')
  if (parts.length < 4) return null
  const day = Number(parts[parts.length - 1])
  const ym = parts[parts.length - 2]
  const workerId = Number(parts[parts.length - 3])
  const siteId = parts.slice(0, parts.length - 3).join('_')
  if (!Number.isFinite(day) || !Number.isFinite(workerId) || !/^\d{6}$/.test(ym) || !siteId) return null
  return { siteId, workerId, ym, day }
}

function addMonths(ym: string, n: number): string {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)) - 1 + n, 1)
  return ymKey(d.getFullYear(), d.getMonth() + 1)
}

function isPureHomeLeaveStub(entry: AttendanceEntry): boolean {
  const keys = Object.keys(entry)
  return keys.every(k => k === 'hk' || k === 'w' || k === 's') && !(entry.w && entry.w > 0)
}

/** 孤立している hk を洗い出す（読み取り専用） */
async function detectOrphans(fromYm: string, toYm: string): Promise<{
  orphans: OrphanDay[]
  scannedMonths: string[]
  rangeCount: number
}> {
  // 正しい hk の根拠となる期間。承認済みに加えて職長承認済みも「正当」として扱い、
  // 消しすぎないよう安全側に倒す。
  const ranges: { workerId: number; startDate: string; endDate: string }[] = []
  const snap = await getDocs(collection(db, 'homeLongLeave'))
  snap.forEach(d => {
    const v = d.data()
    if (v.status !== 'approved' && v.status !== 'foreman_approved') return
    if (!v.startDate || !v.endDate) return
    ranges.push({ workerId: Number(v.workerId), startDate: v.startDate, endDate: v.endDate })
  })

  const orphans: OrphanDay[] = []
  const scannedMonths: string[] = []
  const lockCache: Record<string, boolean> = {}

  let ym = fromYm
  while (ym <= toYm && scannedMonths.length < 120) {
    scannedMonths.push(ym)
    const att = await getAttendanceDoc(ym)
    const keys = Object.keys(att)
    if (keys.length > 0) {
      if (lockCache[ym] === undefined) lockCache[ym] = !!(await checkMonthLocked(ym))
      for (const key of keys) {
        const entry = att[key]
        if (!entry?.hk) continue
        const parsed = parseAttKey(key)
        if (!parsed || parsed.ym !== ym) continue
        const date = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(parsed.day).padStart(2, '0')}`
        const covered = ranges.some(r =>
          r.workerId === parsed.workerId && date >= r.startDate && date <= r.endDate
        )
        if (covered) continue
        orphans.push({
          ym,
          day: parsed.day,
          date,
          siteId: parsed.siteId,
          workerId: parsed.workerId,
          hasOtherData: !isPureHomeLeaveStub(entry),
          locked: lockCache[ym],
        })
      }
    }
    ym = addMonths(ym, 1)
  }

  orphans.sort((a, b) => a.date.localeCompare(b.date) || a.workerId - b.workerId)
  return { orphans, scannedMonths, rangeCount: ranges.length }
}

function resolveWindow(request: NextRequest): { fromYm: string; toYm: string } {
  const sp = request.nextUrl.searchParams
  const now = new Date()
  const fromYm = sp.get('from') && /^\d{6}$/.test(sp.get('from')!) ? sp.get('from')! : '202512'
  const toYm = sp.get('to') && /^\d{6}$/.test(sp.get('to')!)
    ? sp.get('to')!
    : addMonths(ymKey(now.getFullYear(), now.getMonth() + 1), 12)
  return { fromYm, toYm }
}

export async function GET(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { fromYm, toYm } = resolveWindow(request)
    const { orphans, scannedMonths, rangeCount } = await detectOrphans(fromYm, toYm)
    return NextResponse.json({
      mode: 'detect',
      from: fromYm,
      to: toYm,
      scannedMonths: scannedMonths.length,
      homeLeaveRanges: rangeCount,
      orphanCount: orphans.length,
      lockedOrphanCount: orphans.filter(o => o.locked).length,
      orphans,
    })
  } catch (error) {
    console.error('home-leave reconcile GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await request.json().catch(() => ({}))
    if (body.fix !== true) {
      return NextResponse.json({ error: '削除するには {"fix": true} を明示してください' }, { status: 400 })
    }

    const { fromYm, toYm } = resolveWindow(request)
    const { orphans } = await detectOrphans(fromYm, toYm)

    // ロック済みの月は絶対に触らない
    const target = orphans.filter(o => !o.locked)
    const skippedLocked = orphans.filter(o => o.locked)

    // 月ごとに1回の updateDoc にまとめる（書き込み回数を増やさない）
    const byMonth: Record<string, OrphanDay[]> = {}
    for (const o of target) (byMonth[o.ym] ||= []).push(o)

    const applied: string[] = []
    for (const [ym, list] of Object.entries(byMonth)) {
      const updates: Record<string, unknown> = {}
      for (const o of list) {
        const key = `${o.siteId}_${o.workerId}_${o.ym}_${o.day}`
        if (o.hasOtherData) {
          // 実績が入っている日は hk だけ落とす（人の入力を消さない）
          updates[`d.${key}.hk`] = deleteField()
        } else {
          updates[`d.${key}`] = deleteField()
        }
        applied.push(o.date)
      }
      if (Object.keys(updates).length > 0) {
        const ref = doc(db, 'demmen', `att_${ym}`)
        // 空マージ直書きは既存データ全消失の罠。必ず ensureDocExists を通す。
        await ensureDocExists(ref)
        await updateDoc(ref, updates)
      }
    }

    return NextResponse.json({
      mode: 'fix',
      from: fromYm,
      to: toYm,
      removed: applied.length,
      removedDates: applied.sort(),
      skippedLocked: skippedLocked.length,
      skippedLockedDates: skippedLocked.map(o => o.date).sort(),
    })
  } catch (error) {
    console.error('home-leave reconcile POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
