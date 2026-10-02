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

import { addMonthsSafe, addDaysIso, todayJstIso } from './date-utils'
import {
  FIVE_DAY_WARNING_AFTER_MONTHS,
  FIVE_DAY_WARNING_AFTER_MONTHS_JP,
  FIVE_DAY_WARNING_JP_FROM_GRANT_DATE,
} from './constants'

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
  const months = serviceMonthsAt(hireDate, grantDate)
  if (months === null) return 0
  return legalDaysForServiceMonths(months)
}

/**
 * 勤続月数（入社日から付与日まで、満で何か月か）。日付が不正なら null（2026-10-02 総合点検）。
 *
 * 「addMonthsSafe(入社日, n) <= 付与日 を満たす最大の n」で数える。
 * 旧: (年差×12 + 月差) に「付与日の日 ≥ 入社日の日 なら 0、そうでなければ −1」を足していた。
 *     付与日は addMonthsSafe で「応当日が無い月は末日」に丸めるのに、月数の側は日どうしの比較だったため、
 *     月末（29〜31日）入社の人は初回付与日（例: 入社 2025-08-31 → 2026-02-28）が「5か月」になり
 *     法定0日で付与を拒否され、以後の年も毎年1段階少ない日数（10→11日のところ 10日）になっていた。
 *     うるう年の 2/29 入社も同じ。付与日の決め方（addMonthsSafe）と同じ物差しで数えることで一致させる。
 * lib/leave-utils.ts（画面側の calcLegalPL）もこの関数を使う（同じ式の二重実装をやめた）。
 */
export function serviceMonthsAt(hireDate: string, grantDate: string): number | null {
  const h = /^(\d{4})-(\d{2})-(\d{2})/.exec(hireDate || '')
  const g = /^(\d{4})-(\d{2})-(\d{2})/.exec(grantDate || '')
  if (!h || !g) return null
  const hire = hireDate.slice(0, 10)
  const grant = grantDate.slice(0, 10)
  if (!addMonthsSafe(hire, 0) || !addMonthsSafe(grant, 0)) return null
  let months = (Number(g[1]) - Number(h[1])) * 12 + (Number(g[2]) - Number(h[2]))
  if (addMonthsSafe(hire, months) > grant) months -= 1
  return months
}

/** 勤続月数 → 法定付与日数（労基法39条の表・フルタイム） */
export function legalDaysForServiceMonths(months: number): number {
  if (months < 6) return 0     // 0.5年未満
  if (months < 18) return 10   // 0.5年〜1.5年未満
  if (months < 30) return 11   // 1.5年〜2.5年未満
  if (months < 42) return 12   // 2.5年〜3.5年未満
  if (months < 54) return 14   // 3.5年〜4.5年未満
  if (months < 66) return 16   // 4.5年〜5.5年未満
  if (months < 78) return 18   // 5.5年〜6.5年未満
  return 20                     // 6.5年以上
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
 * 「その日に有効な付与レコード」を選ぶ共通ヘルパー（2026-08-04 追加）
 *
 * ■ なぜ必要か（グエン ミン トゥアン事案）
 *   残数チェックが `records[records.length - 1]`（配列の最後）を基準にしていた。
 *   plData には次期の付与レコードが先に作られることがあり、その場合
 *   「まだ来ていない未来の付与枠」で残数を判定してしまう。
 *   実際、当期（2025-11-01付与・枠17日）を21日消化済みなのに、未来の
 *   2026-11-01付与（枠17＋繰越15＝32日・消化0日）を見て「残32日」と判定し、
 *   申請が何件でも通っていた。
 *
 * ■ 選び方
 *   grantDate <= asOf を満たすもののうち最も新しいもの。
 *   すべて未来なら null（＝まだ付与されていない）を返す。呼び出し側は残0として扱うこと。
 *   「配列の最後」「fy の数値比較」で代用しないこと。どちらも未来レコードを掴む。
 */
export function selectActiveGrantRecord<T extends {
  grantDate?: string
  grantDays?: number
  grant?: number
  _archived?: boolean
}>(records: T[], asOfIso: string): T | null {
  const candidates = records
    .filter(r => !r._archived)
    .filter(r => !!r.grantDate)
    .filter(r => ((r.grantDays ?? r.grant ?? 0) > 0))
    .filter(r => (r.grantDate as string) <= asOfIso)
    .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))

  return candidates.length > 0 ? candidates[candidates.length - 1] : null
}

/**
 * 基準日を「付与期間 [付与日, 付与日+1年) の中に含む」いちばん新しい付与レコード（2026-10-02 追加）。
 *
 * ■ なぜ必要か（日本人の付与日が前に動いた人）
 *   休暇管理の一覧は「grantDate..+1年 に基準日を含むレコード」を配列の先頭から find() で探していた。
 *   付与日を前に寄せた日本人（例: 2025-12-01 付与 → 次を 2026-10-01 に付与）は 10/1〜11/30 に
 *   両方の期間に入り、古い方（2025-12-01）が勝って、新しい期の残数が 11/30 まで出なかった。
 *   次の付与があった時点で前の期は終わり、という考え方（selectActiveGrantRecord と同じ）にそろえる。
 *
 * ■ 選び方
 *   selectActiveGrantRecord（付与日 ≤ 基準日のうち最新）を取り、その期間（+1年）がまだ続いているときだけ返す。
 *   1年を過ぎていれば null（＝今の期の付与なし）。
 */
export function selectCurrentPeriodRecord<T extends {
  grantDate?: string
  grantDays?: number
  grant?: number
  _archived?: boolean
}>(records: T[], asOfIso: string): T | null {
  const rec = selectActiveGrantRecord(records, asOfIso)
  if (!rec || !rec.grantDate || !/^\d{4}-\d{2}-\d{2}$/.test(rec.grantDate)) return null
  return asOfIso < addMonthsSafe(rec.grantDate, 12) ? rec : null
}

/**
 * 付与レコードが1件も無い日本人の「付与予定日」（2026-10-02 追加）。
 *
 * ■ なぜ必要か
 *   付与待ち一覧（/api/leave getPendingGrants・ダッシュボード）は、付与レコードが無い日本人に
 *   入社6ヶ月後の日をそのまま出していた。入社が古い人（例: 2015-04-01 入社）だと
 *   「初回付与 2015-10-01」と、何年も前の日付が出ていた（システム移行前の付与が記録に無いだけ）。
 *
 * ■ 決め方
 *   入社6ヶ月後が今日から1年以上前なら、入社6ヶ月後 + 12ヶ月×k のうち今日以前で最も新しい日
 *   （＝今まさに続いている期の付与日）を目安にする（catchUp: true）。
 *   それ以外は入社6ヶ月後（未来でも、1年以内の過去でもそのまま）。
 *   日付は入社日から addMonthsSafe(入社日, 6+12k) で出す（月末入社でも応当日がずれない）。
 */
export function jpExpectedGrantWithoutRecords(
  hireDate: string,
  todayIso: string,
): { grantDate: string; catchUp: boolean } | null {
  if (!hireDate || !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return null
  const first = addMonthsSafe(hireDate, 6)
  if (addMonthsSafe(first, 12) > todayIso) return { grantDate: first, catchUp: false }
  let latest = first
  for (let k = 1; k < 80; k++) {
    const d = addMonthsSafe(hireDate, 6 + 12 * k)
    if (d > todayIso) break
    latest = d
  }
  return { grantDate: latest, catchUp: latest !== first }
}

/**
 * 付与・編集の入力値バリデーション（2026-08-04 追加）
 *
 * ■ なぜ必要か（有給システム総点検）
 *   手動付与(action:'grant')と編集(default action)は grantDays / carryOver / adjustment を
 *   無制限に受け付けていた。法定を超える付与も、繰越の法定上限（前期付与分まで＝労基法115条の
 *   FIFO消化）を超える値も素通りし、トゥアン事案の「繰越15日」誤入力を止められなかった。
 *   代表の方針は「意図して法定より多く付与することはない」なので、超過はエラーとして弾く。
 *
 * ■ ルール
 *   - grantDays: 0〜20（フルタイムの法定最大は20日）
 *   - hireDate と grantDate が揃っていれば calcLegalPL を上限とする
 *     （法定未満は移行データ等で存在し得るため許容。超過のみ拒否）
 *   - 入社6ヶ月未満（legal=0）への付与は拒否（前倒し付与の誤操作防止。
 *     意図的な前倒しをしたくなったらこのガードごと見直すこと）
 *   - carryOver: 0〜20。前期レコードがあればその付与日数(prevGrant)が上限（法115条FIFO）。
 *     前期レコードが無い（初回付与）のに繰越>0 は拒否
 *   - 日本人（期末買取制）の繰越>0 は拒否
 */
export function validateGrantInput(args: {
  grantDays: number
  /** 手動指定された繰越。自動計算値を渡さないこと（検証不要のため undefined でよい） */
  carryOver?: number
  hireDate?: string
  grantDate?: string
  /** 前期レコードの付与日数。前期が存在しなければ null */
  prevGrant?: number | null
  isJapanese?: boolean
}): { ok: true } | { ok: false; error: string } {
  const { grantDays, carryOver, hireDate, grantDate, prevGrant, isJapanese } = args

  if (!Number.isFinite(grantDays) || grantDays < 0) {
    return { ok: false, error: `付与日数が不正です（${grantDays}）` }
  }
  if (grantDays > 20) {
    return { ok: false, error: `付与日数 ${grantDays}日 は法定最大（20日）を超えています` }
  }
  if (hireDate && grantDate) {
    // 日本人は 10/1 への前倒し付与なので、1年以内に来る本来の付与日の勤続で上限を見る（梶原さん 14日）
    const legal = calcLegalPL(hireDate, isJapanese ? jpDeemedDate(hireDate, grantDate) : grantDate)
    if (legal === 0 && grantDays > 0) {
      return { ok: false, error: `入社（${hireDate}）から6ヶ月未満の ${grantDate} には付与できません。入社日が正しいか確認してください` }
    }
    if (legal > 0 && grantDays > legal) {
      return { ok: false, error: `付与日数 ${grantDays}日 は法定（${legal}日）を超えています。勤続年数に対して多すぎます` }
    }
  }

  if (carryOver !== undefined) {
    if (!Number.isFinite(carryOver) || carryOver < 0) {
      return { ok: false, error: `繰越日数が不正です（${carryOver}）` }
    }
    if (isJapanese && carryOver > 0) {
      return { ok: false, error: '日本人社員は期末買取制のため繰越はできません（0日にしてください）' }
    }
    if (carryOver > 20) {
      return { ok: false, error: `繰越日数 ${carryOver}日 は法定最大（20日）を超えています` }
    }
    if (prevGrant === null && carryOver > 0) {
      return { ok: false, error: `初回付与（前期レコードなし）に繰越 ${carryOver}日 は設定できません` }
    }
    if (typeof prevGrant === 'number' && carryOver > prevGrant) {
      return {
        ok: false,
        error: `繰越 ${carryOver}日 は前期付与分（${prevGrant}日）を超えています。`
          + `前々期以前の分は2年時効（労基法115条）で消滅するため、繰越の上限は前期付与日数です`,
      }
    }
  }

  return { ok: true }
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
  opts?: {
    /**
     * 期間の終わり（この日を含まない）を早める（2026-10-02 追加）。
     * 次の付与が1年より前に来た人（付与日を前に寄せた日本人）の前の期は、次の付与日の前日で終わる。
     * 省略時・1年後より遅い日を渡したときは従来どおり [付与日, 付与日+1年)。
     */
    periodEndExclusive?: string
    /** この日の P は数えない（同じ日を書き直すときの二重計上防止。getLeaveBalance の excludeDate と同じ） */
    excludeDate?: string
  },
): {
  actualPeriodUsed: number
  requestedPeriodUsed: number
  actualDates: Set<string>
  requestedDates: Set<string>
} {
  const today = todayIso || todayJstIso()
  // 付与期間 = [grantDate, grantDate + 1年)
  const periodStart = grantDate
  const fullYearEnd = addMonthsSafe(grantDate, 12)
  const periodEnd = opts?.periodEndExclusive && opts.periodEndExclusive < fullYearEnd
    ? opts.periodEndExclusive
    : fullYearEnd

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
    if (opts?.excludeDate && isoDate === opts.excludeDate) continue

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
  opts?: {
    /** 日本人スタッフか（2026-08-31 追加: 日本人だけ判定タイミングが違う） */
    isJp?: boolean
  },
): {
  shortfall: number
  warning: boolean
  reason: 'late' | 'urgent' | 'retiring' | null
} {
  const today = todayIso || todayJstIso()
  const periodEnd = addMonthsSafe(grantDate, 12)
  // 日本人は半年経過で警告（外国人は従来どおり9ヶ月）
  const elapsedThreshold = addMonthsSafe(
    grantDate,
    opts?.isJp ? FIVE_DAY_WARNING_AFTER_MONTHS_JP : FIVE_DAY_WARNING_AFTER_MONTHS,
  )
  const shortfall = Math.max(0, 5 - requestedPeriodUsed)

  // 日本人の 2026-10-01 より前の付与期は監視対象外（代表判断・lib/constants.ts 参照）。
  // 買取優先の運用が先行しており、今期は代表が個別に対応する。
  if (opts?.isJp && grantDate < FIVE_DAY_WARNING_JP_FROM_GRANT_DATE) {
    return { shortfall: 0, warning: false, reason: null }
  }

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
  // 経過が規定月数（日本人6ヶ月 / 外国人9ヶ月）を超えた
  if (today >= elapsedThreshold) {
    return { shortfall, warning: true, reason: 'late' }
  }
  return { shortfall, warning: false, reason: null }
}

/**
 * 同一付与期間（同じ FY）のレコードを判定
 *
 * 半自動付与の二重付与検知用（旧: ±7日近傍のみだったため別日付の連打で重複していた）
 *
 * ⚠️ この判定は「target が既存期間の中にあるか」の一方向のみ。
 *   逆向き（既存の付与日が target の期間内にある = 遡り付与で期間が重なる）は検知できない。
 *   二重付与ガードには grantPeriodsOverlap を使うこと（2026-08-04 総点検）。
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

/**
 * 2つの付与期間（各 grantDate から1年間）が重なるかを判定（2026-08-04 追加）
 *
 * ■ なぜ必要か（新規付与まわりの点検）
 *   二重付与ガードが isSameFiscalYear（一方向）だったため、「既存の付与日より
 *   前の日付で遡って付与する」パターンを検知できなかった。
 *   実例: 年途中入社の日本人（濱上さん、入社2026-06-01）に初回 2026-12-01 を
 *   付与した直後、付与判定は 10/1 統一起点の「FY2026 (2026-10-01) が未実施」を
 *   検知し、実行側のガードも素通りして 10/1 と 12/1 の重複期間ができてしまう。
 *
 * ■ 判定
 *   期間 [a, a+1年) と [b, b+1年) が1日でも重なれば true。
 *   ちょうど1年離れている場合（通常の年次サイクル）は重ならない（半開区間）。
 */
/**
 * 日本人の「次回付与日」を前回付与日から導出する。
 *
 * 2026-10-02 代表決定: 有給をこのシステムで管理できるようになったので、10/1 にそろえるのをやめる。
 *   **入社6ヶ月後に初回、その後は前回の付与日から1年ごと**（外国人スタッフと同じ・労基法39条どおり）。
 *   すでに 10/1 で付与している人は、前回が 10/1 なので次回も 10/1（その人の周期のまま）。
 *   旧（2026-08-27〜10-01）: 前回が年途中なら、その後の最初の 10/1 へ前倒し合流していた。
 * - `deemedDate` は法定日数の勤続計算に使う日。過去に 10/1 へ前倒しした人は、本来の付与日（入社+6ヶ月+1年×k）が
 *   付与日から1年以内に来るので、その日の勤続で数える（斉一的取扱い・jpDeemedDate。梶原さん 14日の件）
 */
export function jpNextGrantAfter(latestGrantIso: string, hireDate?: string): { grantDate: string; deemedDate: string } {
  const grantDate = addMonthsSafe(latestGrantIso, 12)
  return { grantDate, deemedDate: hireDate ? jpDeemedDate(hireDate, grantDate) : grantDate }
}

/**
 * 統一基準日（10/1）に前倒しで付与するときの「みなし勤続」基準日（2026-10-01 追加）。
 *
 * ■ なぜ必要か（梶原さん 12日→14日）
 *   入社 2023-05-15 の人の法定の付与日は 入社+6ヶ月の応当日（毎年 11/15）。
 *   2026-10-01 に前倒しで付与するなら、本来 2026-11-15 にもらえる日数（勤続3年6ヶ月＝14日）を
 *   10/1 に付ける必要がある（斉一的取扱い：短縮した期間は全期間出勤したものとみなす）。
 *   旧実装は前回付与が 10/1 のとき 10/1 時点の勤続（3年4ヶ月＝12日）で数えており、2日不足していた。
 *
 * ■ 判定
 *   付与日から1年のあいだに来る法定の付与日（入社+6ヶ月+12ヶ月×k）があれば、その日の勤続で数える。
 *   `floor`（既存のみなし日）より前にはしない。
 */
export function jpDeemedDate(hireDate: string, grantDate: string, floor?: string): string {
  const base = floor && floor > grantDate ? floor : grantDate
  if (!hireDate) return base
  const windowEnd = addMonthsSafe(grantDate, 12)
  for (let k = 0; k < 80; k++) {
    const d = addMonthsSafe(hireDate, 6 + 12 * k)
    if (d < grantDate) continue
    if (d < windowEnd && d > base) return d
    break
  }
  return base
}

export function grantPeriodsOverlap(aGrantDate: string, bGrantDate: string): boolean {
  if (!aGrantDate || !bGrantDate) return false
  const aEnd = addMonthsSafe(aGrantDate, 12)
  const bEnd = addMonthsSafe(bGrantDate, 12)
  return aGrantDate < bEnd && bGrantDate < aEnd
}

// ────────────────────────────────────────
//  付与の期・残数の共通計算（2026-10-02 総合点検で一本化）
//
//  残数は「申請・承認の検証（getLeaveBalance）」「休暇管理の一覧（/api/leave）」「管理簿 Excel」
//  「賞与の精勤賞与（買取）」「通知ベル」が別々に数えていて、日本人の繰越・買取のフォールバック・
//  付与日を前に寄せた人の重なる期間・来年の承認済み有給の扱いが画面ごとに違っていた。
//  ここの関数だけで数え、各画面は出面の読み方（何か月分を読むか）だけを持つ。
// ────────────────────────────────────────

type GrantRecLike = {
  fy?: string | number
  grantDate?: string
  grantDays?: number
  grant?: number
  carryOver?: number
  carry?: number
  adjustment?: number
  adj?: number
  buyoutDays?: number
  buyoutHistory?: Array<{ days?: number; reason?: string }>
  _archived?: boolean
}

/** 付与のあるレコード（付与日あり・付与日数>0・時効処理前） */
function grantedRecords<T extends GrantRecLike>(records: T[]): T[] {
  return records
    .filter(r => !r._archived && !!r.grantDate && /^\d{4}-\d{2}-\d{2}$/.test(r.grantDate as string))
    .filter(r => ((r.grantDays ?? r.grant ?? 0) > 0))
    .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))
}

/**
 * 付与レコードの期の終わり（この日を含まない）。
 * 付与日+1年と「次の付与日」の早い方。付与日を前に寄せた人（2025-12-01 → 2026-10-01）の前の期は
 * 2026-10-01 で終わる（丸1年で数えると 10〜11月の有給を両方の期で数える）。
 */
export function grantPeriodEndExclusive<T extends GrantRecLike>(records: T[], rec: T): string {
  const start = rec.grantDate as string
  const fullYearEnd = addMonthsSafe(start, 12)
  const next = grantedRecords(records).find(r => (r.grantDate as string) > start)
  return next && (next.grantDate as string) < fullYearEnd ? (next.grantDate as string) : fullYearEnd
}

/**
 * 基準日の時点で「終わっている直近の期」の付与レコード（期末買取の対象期・/leave の「前の期」）。
 * 終わっている＝期の終わり（grantPeriodEndExclusive）が基準日以前。まだ続いている期は返さない。
 * 旧: 賞与は「9/30 時点で有効なレコード」で固定していたため、入社6ヶ月後・以後1年ごとの日本人
 *     （期が 11/30 等に終わる）は期の途中で買い取られ、前に寄せた人は買取日数が画面と食い違っていた。
 */
export function selectEndedPeriodRecord<T extends GrantRecLike>(records: T[], asOfIso: string): T | null {
  const ended = grantedRecords(records).filter(r => grantPeriodEndExclusive(records, r) <= asOfIso)
  return ended.length > 0 ? ended[ended.length - 1] : null
}

export interface RecordBalance {
  fy: string
  grantDate: string
  /** 期の終わり（この日を含まない） */
  periodEndExclusive: string
  /** 期の最後の日 */
  periodLastDay: string
  grantDays: number
  /** 残数に足す繰越（日本人は常に0） */
  carryOver: number
  total: number
  adjustment: number
  buyoutDays: number
  /** 期の中の出面の P（申請ベース・承認済みの未来分を含む・同日多現場は1日） */
  periodUsed: number
  /** 今日までに実際に取った日数 */
  actualPeriodUsed: number
  used: number
  remaining: number
  overdraft: number
  /** この期の期末買取（reason: 'year-end'）が記録済みか */
  yearEndBuyoutRecorded: boolean
}

/**
 * 1件の付与レコードの残数。残 = 付与 + 繰越（日本人は0） − (調整 + 買取 + 期の中の P)。
 * 買取は buyoutDays、無ければ buyoutHistory の合計（移行データ）。
 */
export function computeRecordBalance<T extends GrantRecLike>(
  workerId: number,
  records: T[],
  rec: T,
  allAtt: Record<string, unknown>,
  opts: { isJp: boolean; todayIso?: string; excludeDate?: string },
): RecordBalance {
  const norm = normalizePLRecord(rec as Parameters<typeof normalizePLRecord>[0])
  const grantDate = rec.grantDate as string
  const periodEndExclusive = grantPeriodEndExclusive(records, rec)
  const used = computePeriodUsed(workerId, grantDate, allAtt, opts.todayIso, { periodEndExclusive, excludeDate: opts.excludeDate })
  const carryOver = opts.isJp ? 0 : norm.carryOver
  const total = norm.grantDays + carryOver
  const buyoutDays = rec.buyoutDays ?? (rec.buyoutHistory || []).reduce((s, h) => s + (h.days || 0), 0)
  const usedTotal = norm.adjustment + buyoutDays + used.requestedPeriodUsed
  return {
    fy: String(rec.fy ?? grantDate.slice(0, 4)),
    grantDate,
    periodEndExclusive,
    periodLastDay: addDaysIso(periodEndExclusive, -1),
    grantDays: norm.grantDays,
    carryOver,
    total,
    adjustment: norm.adjustment,
    buyoutDays,
    periodUsed: used.requestedPeriodUsed,
    actualPeriodUsed: used.actualPeriodUsed,
    used: usedTotal,
    remaining: Math.max(0, total - usedTotal),
    overdraft: Math.max(0, usedTotal - total),
    yearEndBuyoutRecorded: (rec.buyoutHistory || []).some(h => h.reason === 'year-end'),
  }
}

export interface LeaveBalance {
  /** その日に有効な付与レコードの付与日。付与レコードが無ければ空文字 */
  grantDate: string
  /** 当期の付与日数（繰越を含まない。年5日義務の「10日以上付与」判定に使う） */
  grantDays: number
  /** 付与枠 = grantDays + carryOver（日本人は繰越0） */
  total: number
  /** 消化済み = adjustment + buyout + 出面の p:1 */
  used: number
  /** 残日数（マイナスは0にクリップ。期が終わって次の付与がまだなら 0） */
  remaining: number
  /** 枠を超過している日数（超過していなければ0） */
  overdraft: number
  /** 付与レコードが存在しない（＝まだ付与されていない） */
  noGrant: boolean
  /** 当期に実際に取得した有給日数（出面の p:1 のみ。調整・買取を含まない） */
  periodUsed?: number
  /** 当期の終わり（この日を含まない）＝付与日+1年 */
  periodEnd?: string
  /**
   * 基準日が当期の終わりを過ぎているのに次の付与がまだ無い（付与の処理待ち・2026-10-02 総合点検）。
   * この間は remaining を 0 にする。旧: 期を過ぎたレコードの残が「使える日」として残り、
   * 期の外の P を数えないため申請が何日でも通る／残0の人は法定の付与日を過ぎても申請できなかった
   */
  periodOver?: boolean
  /** periodOver のとき、期の終わりの時点の残（次の付与の繰越の目安） */
  remainingAtPeriodEnd?: number
}

/**
 * 基準日時点の残数（getLeaveBalance の計算本体・純関数）。
 * 「その日に有効な付与レコード」は selectActiveGrantRecord（付与日 ≤ 基準日のうち最新）。
 */
export function computeLeaveBalanceFromAtt<T extends GrantRecLike>(
  workerId: number,
  records: T[],
  allAtt: Record<string, unknown>,
  asOfIso: string,
  opts: { isJp: boolean; excludeDate?: string; todayIso?: string },
): LeaveBalance {
  const rec = selectActiveGrantRecord(records as Parameters<typeof selectActiveGrantRecord>[0], asOfIso) as T | null
  if (!rec || !rec.grantDate) {
    return { grantDate: '', grantDays: 0, total: 0, used: 0, remaining: 0, overdraft: 0, noGrant: true, periodUsed: 0 }
  }
  // 当期は [付与日, 付与日+1年)。次の付与が先にあれば基準日の時点で次が有効になっているので、ここでは丸1年でよい
  const periodEnd = addMonthsSafe(rec.grantDate as string, 12)
  const b = computeRecordBalance(workerId, records, rec, allAtt, { isJp: opts.isJp, todayIso: opts.todayIso, excludeDate: opts.excludeDate })
  const periodOver = asOfIso >= periodEnd
  return {
    grantDate: b.grantDate,
    grantDays: b.grantDays,
    total: b.total,
    used: b.used,
    remaining: periodOver ? 0 : b.remaining,
    overdraft: b.overdraft,
    noGrant: false,
    periodUsed: b.periodUsed,
    periodEnd,
    periodOver,
    remainingAtPeriodEnd: b.remaining,
  }
}

/** 付与期間の月（YYYYMM）を start の月から end（この日を含まない）の月まで（最大14か月） */
export function monthsCoveringPeriod(startIso: string, endExclusiveIso: string): string[] {
  const out: string[] = []
  let y = Number(startIso.slice(0, 4))
  let m = Number(startIso.slice(5, 7))
  const endYm = endExclusiveIso.slice(0, 4) + endExclusiveIso.slice(5, 7)
  while (`${y}${String(m).padStart(2, '0')}` <= endYm && out.length < 14) {
    out.push(`${y}${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}
