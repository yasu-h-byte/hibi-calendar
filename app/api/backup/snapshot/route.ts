import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit, deleteDoc, where } from '@/lib/fsdb'

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
    // (1) demmen/main をスナップショット
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    if (mainSnap.exists()) {
      await setDoc(doc(db, 'backups', `main_${stamp}`), {
        sourceId: 'demmen/main',
        snapshotAt: now.toISOString(),
        data: mainSnap.data(),
      })
      summary.saved.push(`main_${stamp}`)
    } else {
      summary.errors.push('demmen/main not found')
    }

    // (2) 前月・当月・翌月の att_YYYYMM をスナップショット
    for (const offset of [-1, 0, 1]) {
      const ym = relativeYm(now, offset)
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
    }

    // (2b) 当月周辺の calendarSign（カレンダー承認署名）をスナップショット
    //   ※ 恒久的な法的証跡は calendarSignLog（append-only・revert/reset でも消えない）が正本。
    //      ここでは live の calendarSign を 30 日保険として併せて退避する（多層防御）。
    for (const offset of [-1, 0, 1]) {
      const ym = relativeYm(now, offset)                    // YYYYMM
      const ymDash = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`  // siteCalendar/calendarSign の ym 形式
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
    }

    // (3) 古いバックアップを削除（30日保持）
    const cutoff = new Date(now)
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)
    const cutoffStamp = isoDate(cutoff)
    const backupsCol = collection(db, 'backups')
    // backups コレクションを全件取得（少ないので問題なし）
    const allBackupsSnap = await getDocs(query(backupsCol, orderBy('snapshotAt', 'desc'), limit(500)))
    for (const d of allBackupsSnap.docs) {
      // ドキュメントIDの末尾の YYYYMMDD-HHmmss (or 旧形式 HHmm) が cutoffStamp より古ければ削除
      // 旧形式 (分精度) との後方互換性のため、両方マッチさせる
      const id = d.id
      const m = id.match(/_(\d{8}-\d{4,6})$/)
      if (m && m[1] < cutoffStamp) {
        await deleteDoc(d.ref)
        summary.deleted.push(id)
      }
    }

    return NextResponse.json({ success: true, ...summary })
  } catch (error) {
    return NextResponse.json({
      error: 'Backup failed',
      message: error instanceof Error ? error.message : String(error),
      ...summary,
    }, { status: 500 })
  }
}
