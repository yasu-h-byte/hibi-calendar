import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit, deleteDoc, where } from '@/lib/fsdb'
import { applyDueScheduledWorkerChanges } from '@/lib/worker-crud'
import { BACKUP_COLLECTIONS, BACKUP_DOCS, approvalDocYm, type LastBackupInfo } from '@/lib/backup-plan'

/**
 * 出面・人員マスターデータの日次バックアップ
 *
 * 背景 (2026-05-07):
 *   Firebase Spark プラン（無料）では Point-in-Time Recovery が使えないため、
 *   独自に Firestore 内に日次スナップショットを保存して保険にする。
 *
 * 動作:
 *   - demmen/main の現在の状態を `backups/main_<ISO_DATE>` に保存
 *   - att_<前月>, att_<当月>, att_<翌月> を `backups/att_<ym>_<ISO_DATE>` に保存
 *   - 古い backup は 30 日保持。それより古いものを自動削除。
 *
 * 認証:
 *   Vercel Cron からの呼び出しは Authorization: Bearer $CRON_SECRET ヘッダで認証。
 *   手動実行する場合は ?secret=<CRON_SECRET> クエリでも可。
 *
 * 設定:
 *   vercel.json の crons セクションで毎日 17:00 UTC (= JST 02:00) にトリガ。
 */
const RETENTION_DAYS = 30
/** 1回の実行で消す古いバックアップの上限（時間切れを防ぐ） */
const PRUNE_PER_RUN = 300

/**
 * 実行結果を demmen/system.lastBackup に残す（2026-10-02 総合点検）。
 * 旧: 一部が失敗しても応答に書くだけで、誰も気づけなかった。/api/health と代表の通知ベルがこれを見る
 */
async function recordBackupResult(now: Date, summary: { saved: string[]; deleted: string[]; errors: string[] }): Promise<void> {
  try {
    const info: LastBackupInfo = {
      at: now.toISOString(),
      saved: summary.saved.length,
      deleted: summary.deleted.length,
      errors: summary.errors.slice(0, 20).map(e => e.slice(0, 200)),
    }
    await setDoc(doc(db, 'demmen', 'system'), { lastBackup: info }, { merge: true })
  } catch (e) {
    console.error('[backup] 実行結果の記録に失敗:', e)
  }
}

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // CRON_SECRET 未設定時は無条件で許可しない（誤起動防止）
    return false
  }
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${secret}`) return true
  const querySecret = request.nextUrl.searchParams.get('secret')
  if (querySecret === secret) return true
  return false
}

function isoDate(d: Date = new Date()): string {
  // YYYYMMDD-HHmmss（JST）
  // ⚠️ 2026-05-08 修正: 秒精度に変更。同一分内に手動再実行されても docId が衝突せず、
  //    既存のスナップショットが上書きされない。
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  const yyyy = jst.getFullYear()
  const mm = String(jst.getMonth() + 1).padStart(2, '0')
  const dd = String(jst.getDate()).padStart(2, '0')
  const hh = String(jst.getHours()).padStart(2, '0')
  const min = String(jst.getMinutes()).padStart(2, '0')
  const sec = String(jst.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`
}

function ymKey(d: Date): string {
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, '0')}`
}

function relativeYm(d: Date, monthsOffset: number): string {
  // JST の年・月を取り出し、整数計算で月をずらす。
  //   ※ Date.setMonth は月末31日起点だと繰り上がって対象月が抜ける（監査⑦の横展開）。
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  const total = jst.getMonth() + monthsOffset
  const y = jst.getFullYear() + Math.floor(total / 12)
  const m0 = ((total % 12) + 12) % 12
  return `${y}${String(m0 + 1).padStart(2, '0')}`
}

export async function GET(request: NextRequest) {
  // auth: Vercel Cron の CRON_SECRET
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const stamp = isoDate(now)
  const summary: { saved: string[]; deleted: string[]; errors: string[] } = {
    saved: [],
    deleted: [],
    errors: [],
  }

  try {
    // (1) demmen/main・toolBudget・system をスナップショット（対象は lib/backup-plan.ts）
    for (const d of BACKUP_DOCS) {
      try {
        const snap = await getDoc(doc(db, d.path[0], d.path[1]))
        if (snap.exists()) {
          await setDoc(doc(db, 'backups', `${d.prefix}_${stamp}`), {
            sourceId: d.path.join('/'),
            snapshotAt: now.toISOString(),
            data: snap.data(),
          })
          summary.saved.push(`${d.prefix}_${stamp}`)
        } else if (d.path[1] === 'main') {
          summary.errors.push('demmen/main not found')
        }
      } catch (e) {
        summary.errors.push(`${d.path.join('/')}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // (2) 前月・当月・翌月の att_YYYYMM をスナップショット。
    //     2026-08-27 追加（バックアップ実効性検証）: **日曜は全期間の att_ を退避**。
    //     旧: 3ヶ月窓のみで、過去月の doc が事故で消えると復元手段が無かった
    //     （5月の事故は当月だったから救えたが、過去月なら詰みだった）。
    //     30日保持なので日曜分は常に直近4〜5世代残る。
    const isSundayJst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getDay() === 0
    const attYms = new Set<string>([-1, 0, 1].map(o => relativeYm(now, o)))
    if (isSundayJst) {
      // demmen コレクションから att_ ドキュメントを列挙
      const demmenSnap = await getDocs(collection(db, 'demmen'))
      demmenSnap.forEach(d => {
        const m = /^att_(\d{6})$/.exec(d.id)
        if (m) attYms.add(m[1])
      })
    }
    for (const ym of [...attYms].sort()) {
      // 1か月分が失敗しても（1MB 超など）ほかの月・ほかの退避は続ける
      try {
        const attSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
        if (attSnap.exists()) {
          await setDoc(doc(db, 'backups', `att_${ym}_${stamp}`), {
            sourceId: `demmen/att_${ym}`,
            ym,
            snapshotAt: now.toISOString(),
            data: attSnap.data(),
          })
          summary.saved.push(`att_${ym}_${stamp}`)
        }
      } catch (e) {
        summary.errors.push(`att_${ym}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // (2b) 当月周辺の calendarSign（カレンダー承認署名）をスナップショット
    //   ※ 恒久的な法的証跡は calendarSignLog（append-only・revert/reset でも消えない）が正本。
    //      ここでは live の calendarSign を 30 日保険として併せて退避する（多層防御）。
    for (const offset of [-1, 0, 1]) {
      const ym = relativeYm(now, offset)                    // YYYYMM
      const ymDash = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`  // siteCalendar/calendarSign の ym 形式
      try {
        const signSnap = await getDocs(query(collection(db, 'calendarSign'), where('ym', '==', ymDash)))
        if (!signSnap.empty) {
          const docs = signSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          await setDoc(doc(db, 'backups', `csign_${ym}_${stamp}`), {
            sourceId: `calendarSign(${ymDash})`,
            ym,
            snapshotAt: now.toISOString(),
            data: { docs },
          })
          summary.saved.push(`csign_${ym}_${stamp}`)
        }
      } catch (e) {
        summary.errors.push(`calendarSign(${ymDash}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // (2b-2) 出面の職長承認・最終承認（attendanceApprovals）を月ごとに退避（2026-10-02 総合点検）
    //   9月分から、承認がそろわないと月締め・請求書・本人確認が進まない（lib/approval-gap.ts）。
    //   この記録が消えると全現場×全日を承認し直すしかないのに、退避していなかった。
    //   ドキュメントIDは `${siteId}_${ym}_${day}`（ym の項目は無い）なので、全件を読んで ID の月で分ける。
    //   前月〜翌月は毎日、全期間は日曜（att_ と同じ）。1件は小さい（100バイト前後）ので月ごとなら1MBに届かない
    try {
      const apprSnap = await getDocs(collection(db, 'attendanceApprovals'))
      const byYm = new Map<string, ({ id: string } & Record<string, unknown>)[]>()
      apprSnap.forEach(d => {
        const ym = approvalDocYm(d.id)
        if (!ym) return
        if (!byYm.has(ym)) byYm.set(ym, [])
        byYm.get(ym)!.push({ id: d.id, ...d.data() })
      })
      const nearYms = new Set<string>([-1, 0, 1].map(o => relativeYm(now, o)))
      for (const [ym, docs] of [...byYm.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!isSundayJst && !nearYms.has(ym)) continue
        try {
          await setDoc(doc(db, 'backups', `attappr_${ym}_${stamp}`), {
            sourceId: `attendanceApprovals(${ym})`,
            ym,
            count: docs.length,
            snapshotAt: now.toISOString(),
            data: { docs },
          })
          summary.saved.push(`attappr_${ym}_${stamp}(${docs.length})`)
        } catch (e) {
          summary.errors.push(`attendanceApprovals(${ym}): ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      summary.errors.push(`attendanceApprovals: ${e instanceof Error ? e.message : String(e)}`)
    }

    // (2c) 給与・労務の重要コレクションをスナップショット（監査: 復旧不能コレクションの穴を塞ぐ）
    //   コレクション全体を1ドキュメントに退避。小規模（〜数十件）前提。各々を独立の try で囲み、
    //   1つが失敗しても他のバックアップは継続する。
    const snapshotCollection = async (collName: string, backupPrefix: string) => {
      try {
        const snap = await getDocs(query(collection(db, collName), limit(2000)))
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        await setDoc(doc(db, 'backups', `${backupPrefix}_${stamp}`), {
          sourceId: collName,
          count: docs.length,
          truncated: docs.length >= 2000,
          snapshotAt: now.toISOString(),
          data: { docs },
        })
        summary.saved.push(`${backupPrefix}_${stamp}(${docs.length})`)
        // 2000件で打ち切ったら「全部は取れていない」ので失敗として知らせる（月ごとの退避に分ける合図）
        if (docs.length >= 2000) summary.errors.push(`${collName}: 2000件を超えたため一部しか退避できていません`)
      } catch (e) {
        summary.errors.push(`${collName}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 対象の一覧は lib/backup-plan.ts（足し忘れは __tests__/backupCoverage.test.ts が落とす）
    for (const c of BACKUP_COLLECTIONS) await snapshotCollection(c.coll, c.prefix)

    // (2e) 出面の変更履歴を保持期間（90日）で間引く
    try {
      const { purgeOldHistory } = await import('@/lib/attendance-history')
      const n = await purgeOldHistory()
      if (n > 0) summary.deleted.push(`attendanceHistory×${n}`)
    } catch (e) {
      summary.errors.push(`attendanceHistory purge: ${e instanceof Error ? e.message : String(e)}`)
    }

    // (3) 古いバックアップを削除（30日保持）
    //   2026-10-02 総合点検: 旧実装は「新しい順に500件」を取って30日より古いものを消していた。
    //   1日に約20件たまるので30日分で600件を超え、古いものは500件の外に出て永久に消えなかった
    //   （しかも毎晩、出面の退避＝1件200〜300KB を含む500件を中身ごと読んでいた）。
    //   → 「30日より古いもの」を古い順に引いて消す。1晩300件までなので、たまった分は数日で片づく。
    //   復元前の退避（safety_pre_restore_*）は消さない（件数が少なく、事故調査で要る）
    try {
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000)
      const oldSnap = await getDocs(query(
        collection(db, 'backups'),
        where('snapshotAt', '<', cutoff.toISOString()),
        orderBy('snapshotAt', 'asc'),
        limit(PRUNE_PER_RUN),
      ))
      for (const d of oldSnap.docs) {
        if (d.id.startsWith('safety_')) continue
        await deleteDoc(d.ref)
        summary.deleted.push(d.id)
      }
    } catch (e) {
      summary.errors.push(`prune: ${e instanceof Error ? e.message : String(e)}`)
    }

    // (最後) 日付指定の人員マスタ変更を反映（2026-09-14）。バックアップ取得後に行うので、
    //   当日のスナップショットは「反映前」の状態になる（誤りがあれば戻せる）
    let scheduledApplied: Awaited<ReturnType<typeof applyDueScheduledWorkerChanges>> = []
    try {
      scheduledApplied = await applyDueScheduledWorkerChanges(stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8))
    } catch (e) {
      summary.errors.push(`scheduledChanges: ${e instanceof Error ? e.message : String(e)}`)
    }

    await recordBackupResult(now, summary)
    // 一部でも失敗していれば success: false（HTTP は 200 のまま＝ cron の再試行で二重に取らない）
    return NextResponse.json({ success: summary.errors.length === 0, ...summary, scheduledApplied })
  } catch (error) {
    summary.errors.push(`fatal: ${error instanceof Error ? error.message : String(error)}`)
    await recordBackupResult(now, summary)
    return NextResponse.json({
      error: 'Backup failed',
      message: error instanceof Error ? error.message : String(error),
      ...summary,
    }, { status: 500 })
  }
}
