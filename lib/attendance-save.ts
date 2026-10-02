/**
 * 出面を1件保存する共通の入口（2026-10-02 総合点検）
 *
 * ## なぜ必要か
 * 出面（demmen/att_YYYYMM の d）を書く経路は、PC の出面入力・職長スマホ（ログイン版）・職長のトークン画面・
 * スタッフのスマホ・変更履歴からの復元・工種の移動、と増えてきたが、保存の前の確かめを経路ごとに書いていた。
 * その結果:
 *   - 職長のトークン画面の修正（edit）は、変更履歴にも操作ログにも残らず、名簿に無い人・実在しない日
 *     （9月31日）にも書けた。対象者が人員マスタに見つからないときは確かめを全部飛ばして書いていた
 *   - 事業責任者が最終承認した日を、職長・事務が黙って変えられた（承認は残る・画面の承認行だけが変更不可だった）
 *   - 現場の移動（fix_site・工種の移動）は「書く」「消す」を2回に分けていて、2回目が失敗すると二重に残った
 *   - 「在籍日」「実在する日」の検査は 10/2 に PC だけ入り、スマホ・職長画面は横展開もれだった
 *
 * ## 決まり
 * 出面を書く API は、ここの関数を通す（`__tests__/attendanceWriteEntry.test.ts` が、直接 setAttendanceEntry や
 * `d.<key>` を書くファイルを落とす）。
 *   1. attendanceDateError       … 実在する日か
 *   2. finalApprovedEditError    … 最終承認済みの日は、さかのぼり・最終承認の権限がある人だけ
 *   3. writeAttendanceEntry      … 変更履歴 → 保存（残骸の掃除つき）／削除
 *   4. moveAttendanceEntry       … 現場の移動（書きと消しを1回の updateDoc で）
 * ロックは lib/locks.ts の checkMonthLockedForWorkers、在籍は lib/workers.ts の isEmployedOn、
 * 多現場は lib/attendance.ts の detectMultiSiteConflict（それぞれ1つだけの決まり）。
 *
 * サーバ専用（Firestore を読む・書く）。
 */
import { db } from './firebase'
import { doc, updateDoc, deleteField } from '@/lib/fsdb'
import { withDerivedOvertime, type AttendanceEntry, type Site } from '@/types'
import { calendarSiteIdOf, type HierarchySite } from './site-hierarchy'
import { approvalGap } from './approval-gap'
import { attKey, computeAttendanceDeleteFields, setAttendanceEntry } from './attendance'
import { recordAttendanceChange } from './attendance-history'
import { ensureDocExists } from './firestore-safe'

/** 'YYYYMM' と日から 'YYYY-MM-DD' */
export function isoOfYmDay(ym: string, day: number | string): string {
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(Number(day)).padStart(2, '0')}`
}

/**
 * 出面を書ける日か（実在する日か）。だめならエラーメッセージ。純関数。
 * - 月は 'YYYYMM'（01〜12）、日はその月の 1〜末日の整数（" 5"・"+5"・"05"・31日が無い月の31 は不可）
 * 2026-10-02: PC の出面入力だけにあった検査（存在しない日のキー `..._202609_31` を作らない）を全経路の共通に
 */
export function attendanceDateError(ym: unknown, day: unknown): string | null {
  const y = String(ym ?? '')
  if (!/^\d{6}$/.test(y)) return '月の指定が正しくありません'
  const m = Number(y.slice(4, 6))
  if (m < 1 || m > 12) return '月の指定が正しくありません'
  const d = Number(day)
  const lastDay = new Date(Number(y.slice(0, 4)), m, 0).getDate()
  if (!Number.isInteger(d) || d < 1 || d > lastDay || String(d) !== String(day)) {
    return '日付が正しくありません'
  }
  return null
}

export interface DayApproval {
  /** 職長承認あり（工種サイトは親にまとめる。子の画面で付けた古い承認も数える） */
  foreman: boolean
  /** 最終承認（事業責任者）あり */
  final: boolean
}

/**
 * 現場（親＋工種）×日の承認の状態。判定は月締め・本人確認と同じ lib/approval-gap.ts（キャッシュを使わず読み直す）。
 * 読めなかったときは「承認なし」（承認の判定のために保存を止めない。締めは別に読み直して確かめる）
 */
export async function dayApprovalOf(
  sites: { id: string; parentId?: string }[], siteId: string, ym: string, day: number | string,
): Promise<DayApproval> {
  const familyId = calendarSiteIdOf(sites as HierarchySite[], siteId)
  const gap = await approvalGap(sites, ym, [{ familyId, day: Number(day) }], { fresh: true })
  return { foreman: gap.foremanMissing.length === 0, final: gap.finalMissing.length === 0 }
}

/**
 * 0.6補（会社都合の休み）はカレンダーの仕事の日だけ（2026-09-30 のスタッフのスマホの決まりを全経路へ・2026-10-02 総合点検）。
 * 旧: 職長のトークン画面・PC の出面入力・一括入力は休みの日にも 0.6補を入れられ、休業手当（60%）の過払いになりえた
 */
export const COMP_NON_WORKING_DAY_MESSAGE =
  'この日はカレンダーで休みの日です。「会社の都合の休み（0.6補）」は仕事の日だけ入れられます / Ngày này là ngày nghỉ theo lịch. Chỉ chọn "nghỉ do công ty" cho ngày làm việc'

export const FINAL_APPROVED_EDIT_MESSAGE =
  'この日は最終承認済みのため変更できません。事業責任者（政仁さん）に連絡してください（最終承認を外すか、事業責任者が直します）'

/**
 * 最終承認済みの日を変えられるか。だめならエラーメッセージ。純関数。
 * 変えられるのは、さかのぼり（attendance.backfill）か最終承認（attendance.finalApprove）の権限がある人＝事業責任者・代表だけ。
 * 2026-10-02 総合点検: 画面の承認行は「最終承認済みなら職長承認を外せない」のに、出面そのものは職長・事務が
 *   変えられ、承認は残ったままだった（事業責任者が見ていない内容で締めに進む）。
 */
export function finalApprovedEditError(approval: DayApproval, canEditFinalApproved: boolean): string | null {
  return approval.final && !canEditFinalApproved ? FINAL_APPROVED_EDIT_MESSAGE : null
}

/**
 * 出面を1件 保存／削除 する（変更履歴つき）。確かめ（日付・ロック・在籍・承認・多現場）は呼ぶ側で済ませておく。
 * @param entry     保存する中身。null なら削除
 * @param prevEntry 保存前の中身（呼ぶ側が読んだもの）。null = 無かった／undefined = 読めていない
 * @param actor     操作者（'admin' / 'foreman:12' / 'staff:104' / '303(復元)' など。変更履歴に残す）
 */
export async function writeAttendanceEntry(args: {
  siteId: string
  workerId: number
  ym: string
  day: number
  entry: AttendanceEntry | null
  prevEntry: AttendanceEntry | null | undefined
  actor: string
  /** 残骸の掃除から外す項目（帰国 hk を残したい時季指定など）。ふつうは渡さない */
  keepFields?: string[]
}): Promise<void> {
  const { siteId, workerId, ym, day, entry, prevEntry, actor } = args
  // 既存の中身を壊すとき（上書き・削除）だけ履歴に残る（新規は残さない・lib/attendance-history.ts）
  await recordAttendanceChange({ siteId, workerId, ym, day, before: prevEntry, after: entry, actor })
  if (entry) {
    const deleteFields = computeAttendanceDeleteFields(entry).filter(f => !args.keepFields?.includes(f))
    await setAttendanceEntry(siteId, workerId, ym, day, entry, { deleteFields, prevEntry })
    return
  }
  const ref = doc(db, 'demmen', `att_${ym}`)
  await ensureDocExists(ref)
  await updateDoc(ref, { [`d.${attKey(siteId, workerId, ym, day)}`]: deleteField() })
  try { (await import('./compute')).invalidateAttDataCache(ym) } catch { /* ignore */ }
  // 有給を消したら次期の繰越を計算し直す（保存側は setAttendanceEntry が行う）
  if (prevEntry === undefined || prevEntry?.p) {
    try {
      const { recomputeNextCarryOver } = await import('./leave-carry')
      await recomputeNextCarryOver(workerId, isoOfYmDay(ym, day))
    } catch (e) {
      console.warn('[writeAttendanceEntry] 繰越再計算に失敗（出面の削除は完了）:', e)
    }
  }
}

/**
 * 出面1件を別の現場（工種サイトを含む）へ移す。**書きと消しを1回の updateDoc で行う**。
 * 2026-10-02 総合点検: 旧実装（職長の「現場違い修正」・工種の移動）は移動先へ書いてから移動元を消す2回の書き込みで、
 *   2回目が失敗すると同じ日が2現場に残った（二重払いの形）。
 * 移動先に既に入力が無いこと・多現場・承認・ロックは呼ぶ側で確かめる。
 * @returns 移動先に書いた中身（残業 o は移動先の現場の休憩設定で付け直す）
 */
export async function moveAttendanceEntry(args: {
  fromSiteId: string
  toSiteId: string
  workerId: number
  ym: string
  day: number
  /** 移動元の中身（呼ぶ側が読んだもの） */
  entry: AttendanceEntry
  /** 入力元の印（s）を付け替えるとき */
  source?: string
  actor: string
}): Promise<AttendanceEntry> {
  const { fromSiteId, toSiteId, workerId, ym, day, actor } = args
  let moved: AttendanceEntry = { ...args.entry, ...(args.source ? { s: args.source } : {}) } as AttendanceEntry
  if (Object.keys(moved).length === 0) throw new Error('空の出面は移動できません')
  if (moved.st && moved.et) {
    let ws: Site['workSchedule']
    try {
      const { getMainData } = await import('./compute')
      ws = (await getMainData()).sites.find(s => s.id === toSiteId)?.workSchedule as Site['workSchedule']
    } catch { /* 読めなければ標準の休憩で数える */ }
    moved = withDerivedOvertime(moved, ws)
  }
  // 移動元から消える中身を履歴に残す（移動先は新しい入力なので残さない）
  await recordAttendanceChange({ siteId: fromSiteId, workerId, ym, day, before: args.entry, after: null, actor })
  const ref = doc(db, 'demmen', `att_${ym}`)
  await ensureDocExists(ref)
  await updateDoc(ref, {
    [`d.${attKey(toSiteId, workerId, ym, day)}`]: moved,          // 非空のマップ（上で確かめた）
    [`d.${attKey(fromSiteId, workerId, ym, day)}`]: deleteField(),
  })
  try { (await import('./compute')).invalidateAttDataCache(ym) } catch { /* ignore */ }
  return moved
}
