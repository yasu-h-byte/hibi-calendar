/**
 * 有給休暇 集計の共通ロジック（2026-06-XX 新設）
 *
 * 背景: Workflow CR-1 で「年5日義務監視ロジックが多重破綻」を検出。
 *   - /leave 画面、Excel ledger、dashboard、notifications で5日義務判定の式が三者三様
 *   - periodUsed に未来日付の p:1 申請が混入 → 義務未達を見落とし
 *   - multi-site 重複排除が一部のみ実装
 *
 * 対策: 本ファイルに集約し、全箇所から `computePeriodUsed` を呼ぶ。
 *   - actualPeriodUsed: 実消化（d <= today、申請でなく実際に消化済）
 *   - requestedPeriodUsed: 申請ベース（未来日付の p:1 も含む）
 *   - 5日義務判定は actualPeriodUsed を使用（労基法39条7項準拠）
 *   - 残日数表示は requestedPeriodUsed を使用（申請承認済みは予約として控除）
 */

import { addMonthsSafe, todayJstIso } from './date-utils'

/**
 * 法定付与日数（労基法39条1項・2項）
 *
 * MI-1: lib/leave-auto.ts と app/api/leave/route.ts に重複実装されていた calcLegalPL を統合。
 *
 * @param hireDate    入社日 YYYY-MM-DD
 * @param grantDate   付与日 YYYY-MM-DD（その時点の勤続年数で日数を決定）
 * @returns 法定付与日数（最低10日、最大20日）
 *
 * ⚠️ 比例付与（週4日以下/週30h未満）は未対応。フルタイム前提（MI-16）。
 */
export function calcLegalPL(hireDate: string, grantDate: string): number {
  if (!hireDate || !grantDate) return 0
  const hire = new Date(hireDate)
  const grant = new Date(grantDate)
  if (isNaN(hire.getTime()) || isNaN(grant.getTime())) return 0
  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grant.getFullYear() - hire.getFullYear()) * 12
    + (grant.getMonth() - hire.getMonth())
    + (grant.getDate() >= hire.getDate() ? 0 : -1)
  if (diffMonths < 6) return 0     // 0.5年未満
  if (diffMonths < 18) return 10   // 0.5年〜1.5年未満
  if (diffMonths < 30) return 11   // 1.5年〜2.5年未満
  if (diffMonths < 42) return 12   // 2.5年〜3.5年未満
  if (diffMonths < 54) return 14   // 3.5年〜4.5年未満
  if (diffMonths < 66) return 16   // 4.5年〜5.5年未満
  if (diffMonths < 78) return 18   // 5.5年〜6.5年未満
  return 20                         // 6.5年以上
}

/**
 * PLRecord の正規化（新/旧フィールドの差を吸収）
 *
 * MI-3: 旧フィールド (grant/carry/adj) と新フィールド (grantDays/carryOver/adjustment)
 * の優先順位が画面別にバラバラだったため、ここに一元化。
 */
export function normalizePLRecord(
  r: { grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; [key: string]: unknown }
): { grantDays: number; carryOver: number; adjustment: number } {
  return {
    grantDays: r.grantDays ?? r.grant ?? 0,
    carryOver: r.carryOver ?? r.carry ?? 0,
    adjustment: r.adjustment ?? r.adj ?? 0,
  }
}

/**
 * 有給レコードの「消化済み日数 (used)」を計算する共通ヘルパー (2026-06-XX 追加)
 *
 * 背景: 監査 finding #5/#6 — 「画面表示の残数」と「時効処理の残数」で
 *   used 定義が食い違うバグがあった。
 *     - 画面表示 (旧): used = adjustment + periodUsed                 （買取無視）
 *     - 時効処理 (旧): used = adjustment + buyoutDays + periodUsed   （正しい）
 *   結果: 買取済み日数が画面では残数に含まれたままで、社労士監査で必ず指摘される
 *
 * 修正: 両箇所からこの関数を呼ぶことで定義を一元化。
 *
 * @param rec        PLRecord (grantDays, carryOver, adjustment, buyoutHistory 等)
 * @param periodUsed 当該付与期間の申請ベース消化日数 (computePeriodUsed の結果)
 * @returns used: 消化済み合計 (残数計算用、調整 + 買取 + 申請消化)
 */
export function computeUsedDays(
  rec: {
    adjustment?: number
    adj?: number
    buyoutDays?: number
    buyoutHistory?: Array<{ days?: number }>
  },
  periodUsed: number,
): number {
  const norm = normalizePLRecord(rec as Parameters<typeof normalizePLRecord>[0])
  // 買取済み日数: cached `buyoutDays` を優先（買取APIで履歴追加時に更新される）。
  // 後方互換: buyoutDays が未設定なら buyoutHistory から再計算
  const buyoutDays = rec.buyoutDays ?? (rec.buyoutHistory || []).reduce(
    (s, h) => s + (h.days || 0),
    0,
  )
  return norm.adjustment + buyoutDays + periodUsed
}

/**
 * 残日数 = total − used を計算する共通ヘルパー
 *
 * @param total      grantDays + carryOver (付与総枠)
 * @param rec        PLRecord
 * @param periodUsed 当該付与期間の申請ベース消化
 * @returns remaining (マイナスは0でクリップ)
 */
export function computeRemainingDays(
  total: number,
  rec: Parameters<typeof computeUsedDays>[0],
  periodUsed: number,
): number {
  return Math.max(0, total - computeUsedDays(rec, periodUsed))
}

/**
 * 労基法115条（有給の2年時効）準拠の「次期への繰越日数」を計算する共通ヘルパー。
 *
 * 前提となる有給の消滅ルール:
 *   - ある付与分は付与から2年で時効消滅する。
 *   - 各期の枠 = 当期付与(grant) + 前期繰越(carry)。前期繰越(=前々期付与分)は当期末で時効を迎える。
 *   → よって「次期へ繰り越せるのは、前期付与分(prevGrant)の未消化分まで」。
 *     前期末の残(remaining)が prevGrant を超える分は、時効消滅する前々期付与分なので繰り越さない。
 *
 * remaining = prevGrant + prevCarry − prevAdj − prevBuyout − periodUsed を、上限 prevGrant でクランプする。
 * これは「古い付与から先に消化する(先入先出)」計算と数学的に等価:
 *   min(prevGrant, prevGrant + prevCarry − used) = prevGrant − max(0, used − prevCarry)
 *
 * 旧実装は上限を 20（法定最大付与）にしていたため、消化の少ないスタッフで
 * 前々期の時効消滅分がそのまま次期へ再繰越され、残日数・退職清算・買取額が過大になっていた。
 */
export function calcLegalCarryOver(args: {
  prevGrant: number
  prevCarry: number
  prevAdj?: number
  prevBuyout?: number
  periodUsed: number
}): number {
  const { prevGrant, prevCarry, prevAdj = 0, prevBuyout = 0, periodUsed } = args
  const remaining = prevGrant + prevCarry - prevAdj - prevBuyout - periodUsed
  return Math.max(0, Math.min(prevGrant, remaining))
}

/**
 * その付与レコードの繰越(carryOver)が「人が手動で調整した値」かどうかを判定する。
 *
 * 「繰越自動計算」は全ワーカーの最新記録を一括再計算するが、管理者が個別に手動調整した
 * 繰越を上書きしてはいけない（実例: super-admin が 11→0 に調整した値を自動計算が 11 に戻す事故）。
 * 手動編集は edit action が adjustmentHistory に `field:'carryOver'` を記録するため、それを検出する。
 */
export function hasManualCarryOverOverride(rec: unknown): boolean {
  const hist = (rec as { adjustmentHistory?: Array<{ field?: string }> } | null)?.adjustmentHistory
  if (!Array.isArray(hist)) return false
  return hist.some(h => h?.field === 'carryOver')
}

/**
 * 1スタッフの付与期間内有給消化を集計
 *
 * @param workerId       スタッフID
 * @param grantDate      付与日 (YYYY-MM-DD)
 * @param allAtt         全期間の出面データ（key = `siteId_wid_ym_dd`）
 * @param todayIso       今日の日付 (省略時は JST 今日)
 * @returns
 *   actualPeriodUsed: 今日まで実消化した日数（multi-site dedup 済）
 *   requestedPeriodUsed: 付与期間内の全 p:1 日数（未来日付含む、multi-site dedup 済）
 *   actualDates:      実消化日（YYYY-MM-DD の Set）
 *   requestedDates:   全 p:1 日（YYYY-MM-DD の Set）
 */
export function computePeriodUsed(
  workerId: number,
  grantDate: string,
  allAtt: Record<string, unknown>,
  todayIso?: string,
): {
  actualPeriodUsed: number
  requestedPeriodUsed: number
  actualDates: Set<string>
  requestedDates: Set<string>
} {
  const today = todayIso || todayJstIso()
  // 付与期間 = [grantDate, grantDate + 1年)
  const periodStart = grantDate
  const periodEnd = addMonthsSafe(grantDate, 12)

  const actualDates = new Set<string>()
  const requestedDates = new Set<string>()

  for (const [key, entry] of Object.entries(allAtt)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { p?: number | boolean }
    if (!e.p) continue

    // key 形式: `siteId_workerId_yyyymm_dd`
    // ★ siteId 自体がアンダースコアを含み得る（例: yaesu_night）ため、
    //   右端3要素（wid / ym / dd）を末尾から取り出す（parseDKey と同じ方式）。
    //   split して長さ4を期待する旧実装は、アンダースコア入り現場IDの有給を
    //   丸ごと取りこぼしていた（消化日数の過少 → 残日数の過大表示）。
    const parts = key.split('_')
    if (parts.length < 4) continue
    const dd = parts[parts.length - 1]
    const ym = parts[parts.length - 2]
    const wid = parseInt(parts[parts.length - 3], 10)
    if (wid !== workerId) continue
    if (!/^\d{6}$/.test(ym) || !/^\d{1,2}$/.test(dd)) continue
    const isoDate = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${dd.padStart(2, '0')}`

    // 付与期間内のみ
    if (isoDate < periodStart || isoDate >= periodEnd) continue

    // multi-site dedup: 同日複数現場の有給は1日とカウント
    requestedDates.add(isoDate)
    if (isoDate <= today) {
      actualDates.add(isoDate)
    }
  }

  return {
    actualPeriodUsed: actualDates.size,
    requestedPeriodUsed: requestedDates.size,
    actualDates,
    requestedDates,
  }
}

/**
 * 5日義務（労基法39条7項）の警告判定
 *
 * 【対象】年10日以上付与された全スタッフ（国籍・在留資格不問。2026-06-XX 修正）
 *
 * 【判定基準】(2026-06-XX 明文化、社労士確認済み・docs/paid-leave.md 参照)
 *   「申請ベース (requestedPeriodUsed)」で判定する
 *     - 申請されて承認済みの日数を「取得」とカウント
 *     - 申請キャンセル分・却下分は含まない
 *     - 当日キャンセル等の事情で実取得が5日未満になっても、
 *       申請ベースで5日達成していれば会社の時季指定義務は果たしたと解釈
 *
 *   ※ パラメータ名 `requestedPeriodUsed` がこの基準を反映している
 *
 * 【判定ルール】以下のいずれかに該当すれば警告:
 *   1. 期限まで残3ヶ月以内かつ申請ベース消化 < 5日 → 'urgent'
 *   2. 経過9ヶ月以上かつ申請ベース消化 < 5日 → 'late' (行政指導タイミング)
 *   3. 退職予定日 < 期限 かつ 退職前に申請ベース未達 → 'retiring'
 *
 * @param grantDate              付与日
 * @param grantDays              その年の付与日数
 * @param requestedPeriodUsed    申請ベース消化日数（computePeriodUsed の結果）
 *                               ※ 旧パラメータ名 actualPeriodUsed から変更（2026-06-XX）
 *                                  実装はずっと requestedPeriodUsed を受け取っていたが
 *                                  名前と JSDoc が "実消化" となっていた誤記を修正
 * @param retiredIso             退職予定日（あれば）
 * @param todayIso               今日（省略時は JST 今日）
 * @returns
 *   shortfall: 不足日数（5 - requestedPeriodUsed、0 以上）
 *   warning: 警告すべきか
 *   reason: 警告理由（'late' / 'urgent' / 'retiring' / null）
 */
export function judgeFiveDayObligation(
  grantDate: string,
  grantDays: number,
  requestedPeriodUsed: number,
  retiredIso?: string,
  todayIso?: string,
): {
  shortfall: number
  warning: boolean
  reason: 'late' | 'urgent' | 'retiring' | null
} {
  const today = todayIso || todayJstIso()
  const periodEnd = addMonthsSafe(grantDate, 12)
  const periodEnd9m = addMonthsSafe(grantDate, 9)
  const shortfall = Math.max(0, 5 - requestedPeriodUsed)

  if (grantDays < 10) {
    return { shortfall: 0, warning: false, reason: null }
  }
  if (shortfall === 0) {
    return { shortfall: 0, warning: false, reason: null }
  }
  // 既に期限切れ
  if (today >= periodEnd) {
    return { shortfall, warning: true, reason: 'late' }
  }
  // 退職予定が期限より前
  if (retiredIso && retiredIso < periodEnd && retiredIso >= today) {
    return { shortfall, warning: true, reason: 'retiring' }
  }
  // 期限まで残3ヶ月以内
  const threeMonthsBeforeEnd = addMonthsSafe(periodEnd, -3)
  if (today >= threeMonthsBeforeEnd) {
    return { shortfall, warning: true, reason: 'urgent' }
  }
  // 経過9ヶ月以上
  if (today >= periodEnd9m) {
    return { shortfall, warning: true, reason: 'late' }
  }
  return { shortfall, warning: false, reason: null }
}

/**
 * 同一付与期間（同じ FY）のレコードを判定
 *
 * 半自動付与の二重付与検知用（旧: ±7日近傍のみだったため別日付の連打で重複していた）
 *
 * @param r       既存PLレコード
 * @param target  これから付与しようとしている日
 * @returns       同一FYとみなされるか（true なら付与しない）
 */
export function isSameFiscalYear(
  r: { grantDate?: string; fy?: string | number },
  target: string,
): boolean {
  if (!r.grantDate) return false
  // grantDate の年月（YYYY-MM）が同じならば同一 FY とみなす
  // ※ HIBIの運用では FY は付与日基準で1年単位
  const rYm = r.grantDate.slice(0, 7)  // YYYY-MM
  const tYm = target.slice(0, 7)
  if (rYm === tYm) return true
  // 1年以内の近接付与も同一FYとみなす（半自動付与の誤操作対策）
  const oneYearLater = addMonthsSafe(r.grantDate, 12)
  return target >= r.grantDate && target < oneYearLater
}
