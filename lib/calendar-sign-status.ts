/**
 * 就業カレンダーの署名状況の集計（2026-09-26）。**「未署名」の決まりはこの関数だけ**。
 *
 * 就業カレンダー画面（署名状況）と通知ベル（未署名 N名）が別々の数え方をしていて、
 * 画面 8名・ベル 1名 と食い違った（ベルは「その現場の配置者」だけを数え、画面は全員×全現場）。
 * 両方ここを使うことで、同じ月なら必ず同じ数字になる。クライアント・サーバーどちらからも使える（純関数）。
 *
 * 決まり（2026-05-27「全員が全現場のカレンダーに署名する」モデル＋ sign-self / my-pending と同じ）:
 *   - 対象は **承認済みのカレンダー** だけ（未承認の現場はまだ署名できない）
 *   - 署名対象スタッフ（lib/workers.ts isCalendarSignTarget）は、承認済みの全現場に署名する
 *   - 承認後にカレンダーが修正された現場は、**その現場の配置者**だけ、修正後にもう一度署名（再確認）が要る
 */

export interface SignStatusWorker {
  id: number
  name: string
  signed: boolean
  /** その現場の配置者か（工種サイトの配置者を含む） */
  assignedHere?: boolean
  /** 承認後の修正より後に署名したか */
  reconfirmedAfterRevision?: boolean
}

export interface SignStatusSite {
  siteId: string
  siteName?: string
  status: string | null
  /** 承認後にカレンダーが修正されたか（無ければ修正なし） */
  wasRevised?: boolean
  workers: SignStatusWorker[]
}

export interface WorkerSignSummary {
  id: number
  name: string
  /** 署名が要る現場の数（承認済みの現場） */
  total: number
  /** 署名済み（再確認が要るものは除く） */
  signed: number
  remaining: number
}

/** その現場で、その人の署名が済んでいるか（再確認が要る場合は済んでいない） */
export function isSignDone(site: SignStatusSite, w: SignStatusWorker): boolean {
  if (!w.signed) return false
  const needsReconfirm = !!site.wasRevised && !!w.assignedHere && !w.reconfirmedAfterRevision
  return !needsReconfirm
}

/** 月の署名状況を人ごとにまとめる。承認済みの現場だけを数える */
export function summarizeSignStatus(sites: SignStatusSite[]): {
  workers: WorkerSignSummary[]
  total: number
  signedCount: number
  unsigned: WorkerSignSummary[]
} {
  const map = new Map<number, WorkerSignSummary>()
  for (const s of sites) {
    if (s.status !== 'approved') continue
    for (const w of s.workers) {
      const cur = map.get(w.id) || { id: w.id, name: w.name, total: 0, signed: 0, remaining: 0 }
      cur.total += 1
      if (isSignDone(s, w)) cur.signed += 1
      cur.remaining = cur.total - cur.signed
      map.set(w.id, cur)
    }
  }
  const workers = [...map.values()]
  const unsigned = workers
    .filter(w => w.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name, 'ja'))
  return { workers, total: workers.length, signedCount: workers.length - unsigned.length, unsigned }
}

/**
 * スタッフへ送る「カレンダーに署名してください」の文面（就業カレンダー画面の送信文コピーと通知ベルで共通）。
 * 署名は各自の出面入力リンク（QR）から行う（旧: /calendar/public で名前を選ぶ方式は 2026-06 に廃止）。
 */
export function buildSignRequestMessage(y: number, m: number, unsignedNames: string[] = []): string {
  const lines = [
    'HIBI CONSTRUCTION',
    `就業カレンダー ${y}年${m}月`,
    `Lịch làm việc tháng ${m}/${y}`,
    '',
    'いつもの出面入力のリンク（QR）を開く → カレンダーを確認 → 署名',
    'Mở link chấm công hằng ngày (QR) → Xem lịch → Ký',
  ]
  if (unsignedNames.length > 0) lines.push('', '未署名 / Chưa ký:', unsignedNames.join(', '))
  return lines.join('\n')
}

