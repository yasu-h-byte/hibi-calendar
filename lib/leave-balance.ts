import { getMainData, getAttData } from './compute'
import {
  selectActiveGrantRecord, selectEndedPeriodRecord, normalizePLRecord, computeLeaveBalanceFromAtt,
  computeRecordBalance, grantPeriodEndExclusive, monthsCoveringPeriod, type LeaveBalance, type RecordBalance,
} from './leave-compute'
import { todayJstIso, addMonthsSafe } from './date-utils'

/**
 * 有給残日数の算出（サーバ共通・2026-08-04 追加）
 *
 * ■ なぜ共通化するか（グエン ミン トゥアン事案）
 *   残数チェックが有給申請の経路にしか無く、しかも独自実装だった。
 *   結果、①出面へ直接入力する経路には残数チェックが皆無、
 *   ②申請経路のチェックは未来の付与レコードを見る不具合、の二重の穴があり、
 *   当期17日枠に対して21日が消化された（うち11日は出面への直接入力）。
 *
 *   残数の定義を1箇所に集約し、全ての書き込み経路がここを通るようにする。
 *
 * ■ 残数の定義（画面表示と同じ式）
 *   total     = grantDays + carryOver
 *   used      = adjustment + buyoutDays + periodUsed（出面の p:1 を数える）
 *   remaining = max(0, total - used)
 *
 *   ※ used が出面の p:1 由来である点が重要。申請を経由せず出面に直接入力した
 *     有給もここに含まれる。「申請件数」で数えないこと。
 */

export type { LeaveBalance } from './leave-compute'

type RecLike = Parameters<typeof normalizePLRecord>[0] & {
  fy?: string | number; grantDate?: string; _archived?: boolean
  buyoutDays?: number; buyoutHistory?: Array<{ days?: number; reason?: string }>
}

/** その人が日本人か（繰越なし・期末買取）。main.workers の visa から */
function isJpWorker(main: Awaited<ReturnType<typeof getMainData>>, workerId: number): boolean {
  const wRec = main.workers.find(w => w.id === workerId)
  return !wRec?.visa || wRec.visa === 'none'
}

/**
 * 期間の月（YYYYMM）の出面を並列に読んで1つにまとめる。
 * ★ 期間終端は addMonthsSafe（文字列演算）で作ること。Date+toISOString だと
 *   実行環境のタイムゾーンで日付が1日ズレる（JST機で -9h → 前日になる）。
 * 2026-09-02 高速化: 最大13ヶ月の att 読みを並列に（逐次だと preferRest の
 *   レイテンシ×13 でこの関数だけで数秒かかり、スマホ画面のタイムアウトの一因だった）
 */
async function loadAttForPeriod(startIso: string, endExclusiveIso: string): Promise<Record<string, unknown>> {
  const yms = monthsCoveringPeriod(startIso, endExclusiveIso)
  const attList = await Promise.all(yms.map(ym => getAttData(ym)))
  const merged: Record<string, unknown> = {}
  for (const att of attList) Object.assign(merged, att.d)
  return merged
}

/**
 * 指定スタッフの、指定日時点での有給残数を返す。
 * 計算本体は lib/leave-compute.ts computeLeaveBalanceFromAtt（純関数・テスト可能）。
 *
 * @param workerId 対象スタッフ
 * @param asOfIso  基準日（省略時は JST 今日）。この日に有効な付与レコードを使う
 * @param excludeDate この日の p:1 は消化に数えない（同じ日を編集し直すときの二重計上防止）
 */
export async function getLeaveBalance(
  workerId: number,
  asOfIso?: string,
  excludeDate?: string,
): Promise<LeaveBalance> {
  const asOf = asOfIso || todayJstIso()
  const main = await getMainData()
  const records = (main.plData?.[String(workerId)] || []) as unknown as RecLike[]

  const rec = selectActiveGrantRecord(records, asOf)
  if (!rec || !rec.grantDate) {
    return { grantDate: '', grantDays: 0, total: 0, used: 0, remaining: 0, overdraft: 0, noGrant: true, periodUsed: 0 }
  }
  // 日本人は期末買取制のため繰越なし（/api/leave GET と同じ扱いに統一・2026-09-02）。
  //   移行データに carryOver が残っていても残数に足さない
  const isJp = isJpWorker(main, workerId)
  // 付与期間 = [grantDate, grantDate + 1年)
  const start = rec.grantDate as string
  const allAtt = await loadAttForPeriod(start, addMonthsSafe(start, 12))
  return computeLeaveBalanceFromAtt(workerId, records, allAtt, asOf, { isJp, excludeDate })
}

/**
 * 1件の付与レコード（fy か付与日で指定）の残数（2026-10-02 総合点検・買取記録の検証用）。
 * 旧: 買取記録（recordBuyout）は「今日有効なレコード」の残で検証していたため、10月に前の期（9/30 に終わった期）の
 *     買取を記録すると、今の期（付与直後でほぼ満額）の残と比べていた。
 */
export async function getRecordBalance(
  workerId: number,
  which: { fy?: string | number; grantDate?: string },
): Promise<RecordBalance | null> {
  const main = await getMainData()
  const records = (main.plData?.[String(workerId)] || []) as unknown as RecLike[]
  const rec = records.find(r =>
    (which.grantDate && r.grantDate === which.grantDate) || (which.fy !== undefined && String(r.fy) === String(which.fy)))
  if (!rec || !rec.grantDate) return null
  const endExclusive = grantPeriodEndExclusive(records, rec)
  const allAtt = await loadAttForPeriod(rec.grantDate, endExclusive)
  return computeRecordBalance(workerId, records, rec, allAtt, { isJp: isJpWorker(main, workerId) })
}

/**
 * 基準日の時点で「終わっている直近の期」の残数（期末買取の対象・2026-10-02 総合点検）。
 * 賞与の精勤賞与（買取）・休暇管理の「前の期の残り」・手動の期末買取が同じこの関数を使う。
 * まだ終わっていない期（入社6ヶ月後・以後1年ごとの日本人の期の途中など）は対象にしない。
 */
export async function getEndedPeriodBalance(
  workerId: number,
  asOfIso: string,
): Promise<RecordBalance | null> {
  const main = await getMainData()
  const records = (main.plData?.[String(workerId)] || []) as unknown as RecLike[]
  const rec = selectEndedPeriodRecord(records, asOfIso)
  if (!rec || !rec.grantDate) return null
  const endExclusive = grantPeriodEndExclusive(records, rec)
  const allAtt = await loadAttForPeriod(rec.grantDate, endExclusive)
  return computeRecordBalance(workerId, records, rec, allAtt, { isJp: isJpWorker(main, workerId) })
}
