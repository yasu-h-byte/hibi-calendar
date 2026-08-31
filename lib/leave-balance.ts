import { getMainData, getAttData, parseDKey } from './compute'
import { selectActiveGrantRecord, normalizePLRecord } from './leave-compute'
import { ymKey } from './attendance'
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

export interface LeaveBalance {
  /** その日に有効な付与レコードの付与日。付与レコードが無ければ空文字 */
  grantDate: string
  /** 付与枠 = grantDays + carryOver */
  total: number
  /** 消化済み = adjustment + buyout + 出面の p:1 */
  used: number
  /** 残日数（マイナスは0にクリップ） */
  remaining: number
  /** 枠を超過している日数（超過していなければ0） */
  overdraft: number
  /** 付与レコードが存在しない（＝まだ付与されていない） */
  noGrant: boolean
  /**
   * 当期に実際に取得した有給日数（出面の p:1 のみ。調整・買取を含まない）。
   * 年5日取得義務（労基法39条7項）の判定はこの値で行う（2026-08-28 追加）。
   */
  periodUsed?: number
}

/**
 * 指定スタッフの、指定日時点での有給残数を返す。
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
  const records = (main.plData?.[String(workerId)] || []) as unknown as Parameters<typeof normalizePLRecord>[0][]

  const rec = selectActiveGrantRecord(records, asOf)
  if (!rec || !rec.grantDate) {
    return { grantDate: '', total: 0, used: 0, remaining: 0, overdraft: 0, noGrant: true, periodUsed: 0 }
  }

  const norm = normalizePLRecord(rec)
  const total = norm.grantDays + norm.carryOver
  // buyoutDays が未キャッシュの移行データは履歴合算へフォールバック（computeUsedDays と統一 2026-08-27）
  const recB = rec as { buyoutDays?: number; buyoutHistory?: Array<{ days?: number }> }
  const buyoutDays = recB.buyoutDays
    ?? (recB.buyoutHistory || []).reduce((s2, b) => s2 + (b.days || 0), 0)

  // 付与期間 = [grantDate, grantDate + 1年)
  // ★ 期間終端は addMonthsSafe（文字列演算）で作ること。Date+toISOString だと
  //   実行環境のタイムゾーンで日付が1日ズレる（JST機で -9h → 前日になる）。
  //   Vercel(UTC) では顕在化しないが、ローカル検証と本番で結果が変わる罠になる。
  const start = rec.grantDate as string
  const end = addMonthsSafe(start, 12)

  // 期間内の月（YYYYMM）を start の月から end の月まで列挙して p:1 を数える
  //（同日複数現場は1日に丸める）
  const days = new Set<string>()
  const startYm = start.slice(0, 4) + start.slice(5, 7)
  const endYm = end.slice(0, 4) + end.slice(5, 7)
  const yms: string[] = []
  {
    let y = Number(startYm.slice(0, 4))
    let m = Number(startYm.slice(4, 6))
    while (ymKey(y, m) <= endYm && yms.length < 14) {
      yms.push(ymKey(y, m))
      m++
      if (m > 12) { m = 1; y++ }
    }
  }
  for (const ym of yms) {
    const att = await getAttData(ym)
    for (const [key, entry] of Object.entries(att.d)) {
      const e = entry as { p?: number } | null
      if (!e?.p) continue
      const pk = parseDKey(key)
      if (parseInt(pk.wid, 10) !== workerId) continue
      const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
      if (iso < start || iso >= end) continue
      if (excludeDate && iso === excludeDate) continue
      days.add(iso)
    }
  }

  const used = norm.adjustment + buyoutDays + days.size
  return {
    grantDate: start,
    total,
    used,
    remaining: Math.max(0, total - used),
    overdraft: Math.max(0, used - total),
    noGrant: false,
    periodUsed: days.size,
  }
}
