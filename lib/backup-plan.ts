/**
 * 日次バックアップの対象の一覧（2026-10-02 総合点検）。**バックアップするコレクションの決まりはこのファイルだけ**。
 *
 * 根本原因: 対象を app/api/backup/snapshot/route.ts に1行ずつ手で足していたので、新しいコレクションを
 *   作ったときに足し忘れる（attendanceApprovals・attConfirm・staffDocs・auditTrail が退避されていなかった。
 *   承認の記録が消えると、9月分からの月締め・請求書・本人確認が全部止まる）。
 * 対処: 対象と「意図して外すもの」をここに並べ、__tests__/backupCoverage.test.ts が
 *   コードで使っているコレクション名と突き合わせる。新しいコレクションを足して、ここに書かなければテストが落ちる。
 *
 * クライアントからは import しない（サーバーとテストだけ）。
 */

/** コレクション全体を1つのバックアップにまとめて退避するもの（1件1MB・2000件まで。小さいコレクション向け） */
export const BACKUP_COLLECTIONS: readonly { coll: string; prefix: string; note: string }[] = [
  { coll: 'leaveRequests', prefix: 'leavereq', note: '有給申請＋承認履歴' },
  { coll: 'homeLongLeave', prefix: 'homeleave', note: '帰国情報の単一ソース' },
  { coll: 'evaluations', prefix: 'evals', note: '人事評価' },
  { coll: 'siteCalendar', prefix: 'sitecal', note: '承認済みカレンダー本体' },
  { coll: 'activityLog', prefix: 'actlog', note: '操作ログ（500件ローテーションの退避）' },
  { coll: 'payrollSnapshots', prefix: 'paysnap', note: '締めスナップショット（給与確定の証跡）' },
  { coll: 'jpWageRevisions', prefix: 'jprev', note: '号俸制の年次改定（評語・凍結給料表）' },
  { coll: 'jpWageHistory', prefix: 'jphist', note: 'ベース年収履歴' },
  { coll: 'jpBonuses', prefix: 'jpbonus', note: '賞与支給記録' },
  { coll: 'jpPromotions', prefix: 'jpprom', note: '昇格履歴' },
  { coll: 'calendarSignLog', prefix: 'csignlog', note: '署名の恒久台帳（append-only の正本）' },
  { coll: 'peerInvoices', prefix: 'peerinv', note: '応援・HFU の請求書（発行・申請・取り消しの記録）' },
  { coll: 'paperInvoices', prefix: 'paperinv', note: '紙（手作り）で出した請求書の記録（ファイル本体は Storage）' },
  { coll: 'subconInvoices', prefix: 'subinv', note: '受け取った外注の請求書の記録（ファイル本体は Storage・2026-10-05）' },
  // 2026-10-02 総合点検で追加
  { coll: 'attConfirm', prefix: 'attconfirm', note: '月末の本人確認（月締めの前提）' },
  { coll: 'staffDocs', prefix: 'staffdocs', note: '書類庫の情報（消えると Storage のファイルにたどり着けない）' },
  { coll: 'auditTrail', prefix: 'audittrail', note: '給与欄の変更の永続記録（労基法115条の証跡・削除処理を持たない正本）' },
  { coll: 'calendarQuestions', prefix: 'calq', note: '就業カレンダーへの質問・異議' },
  // 2026-10-05 追加
  { coll: 'payNoteAcks', prefix: 'paynoteack', note: '給与チェックの注意点を「確認した」記録（誰が・いつ・メモ）' },
]

/**
 * 月ごとに分けて退避するもの（件数が増え続けるので1つにまとめると1MBを超える）。
 * - attendanceApprovals: ドキュメントID `${siteId}_${ym}_${day}`（ym の項目は無い）→ ID から月を取り出して分ける
 * - calendarSign: `ym` 項目（'YYYY-MM'）で引く
 */
export const BACKUP_MONTHLY_COLLECTIONS: readonly { coll: string; prefix: string; note: string }[] = [
  { coll: 'attendanceApprovals', prefix: 'attappr', note: '出面の職長承認・最終承認（月締め・請求書・本人確認の前提）' },
  { coll: 'calendarSign', prefix: 'csign', note: 'カレンダー承認署名（恒久の正本は calendarSignLog）' },
]

/** ドキュメント単位で退避するもの（demmen/att_YYYYMM は別に月ごと） */
export const BACKUP_DOCS: readonly { path: [string, string]; prefix: string; note: string }[] = [
  { path: ['demmen', 'main'], prefix: 'main', note: '人員・現場・配置・単価・有給' },
  { path: ['demmen', 'toolBudget'], prefix: 'toolbudget', note: '道具代の購入記録' },
  { path: ['demmen', 'system'], prefix: 'system', note: '時効処理・バックアップの実行記録' },
]

/** 意図して退避しないもの（理由つき）。ここにも BACKUP_* にも無いコレクションをコードで使うとテストが落ちる */
export const BACKUP_EXCLUDED: readonly { coll: string; reason: string }[] = [
  { coll: 'backups', reason: 'バックアップ自身' },
  { coll: 'demmen', reason: 'main・toolBudget・system・att_YYYYMM をドキュメント単位で退避（BACKUP_DOCS と att の月ごと）' },
  { coll: 'attendanceHistory', reason: '出面の変更履歴（90日の保険・1件ずつが大きい）。正本は att_YYYYMM' },
  { coll: 'accessLog', reason: 'スタッフのアクセス履歴（消えても業務に影響なし）' },
  { coll: 'workerPhotos', reason: '顔写真（撮り直せる・大きい）' },
]

/** attendanceApprovals のドキュメントID（`${siteId}_${ym}_${day}`）から月（YYYYMM）を取り出す。形が違えば null */
export function approvalDocYm(docId: string): string | null {
  const m = /_(\d{6})_\d{1,2}$/.exec(docId)
  return m ? m[1] : null
}

/** バックアップが止まっていると見なす時間（日次＝24時間＋余裕） */
export const BACKUP_STALE_HOURS = 26

export interface LastBackupInfo {
  /** 実行した時刻（ISO） */
  at: string
  saved: number
  deleted: number
  /** 失敗した項目（空なら全部成功） */
  errors: string[]
}

/** 最後のバックアップの状態（health・通知ベルが使う）。null = 一度も記録が無い */
export function backupHealth(last: LastBackupInfo | null | undefined, nowMs: number): { ok: boolean; reason: string | null; hoursAgo: number | null } {
  if (!last?.at) return { ok: false, reason: 'バックアップの記録がありません', hoursAgo: null }
  const t = Date.parse(last.at)
  if (!Number.isFinite(t)) return { ok: false, reason: 'バックアップの記録が読めません', hoursAgo: null }
  const hoursAgo = Math.floor((nowMs - t) / 3600000)
  if (hoursAgo >= BACKUP_STALE_HOURS) return { ok: false, reason: `最後のバックアップから${hoursAgo}時間たっています`, hoursAgo }
  if (last.errors?.length) return { ok: false, reason: `バックアップの一部が失敗しています（${last.errors.length}件）`, hoursAgo }
  return { ok: true, reason: null, hoursAgo }
}
