import { AttendanceEntry, AttendanceStatus, AttendanceApproval, Site, withDerivedOvertime } from '@/types'
import { currentYmJst } from '@/lib/date-utils'


// ────────────────────────────────────────
//  日付ヘルパー
// ────────────────────────────────────────

const DOW_HIRAGANA = ['にちようび', 'げつようび', 'かようび', 'すいようび', 'もくようび', 'きんようび', 'どようび']
const DOW_KANJI = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']
const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

export function ymKey(y: number, m: number): string {
  return `${y}${String(m).padStart(2, '0')}`
}

// 漢字 + 短い曜日（スタッフ用）
export function formatDateJP(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_SHORT[date.getDay()]
  return `${m}月${d}日（${dow}）`
}

// 漢字表記（職長・管理者用）
export function formatDateKanji(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_KANJI[date.getDay()]
  return `${m}月${d}日（${dow}）`
}

export function formatDateShort(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_SHORT[date.getDay()]
  return `${m}/${d}（${dow}）`
}

export function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${String(day)}`
}

// ────────────────────────────────────────
//  ベトナム人スタッフの入力規律ヘルパー
// ────────────────────────────────────────

/**
 * エントリが「実際に働いた日」かどうかを判定する共通ヘルパー。
 *
 * 背景 (2026-05-09 ビンさんの残業 5h→3h バグから):
 *   スマホ過去日のステータス変更で過去の出勤入力 (st/et/b1/b2/b3/o) が残骸として
 *   残ったままになるケースがある（c36517b リバートの影響、来週再実装予定）。
 *   集計コードがステータス flag (p/r/h/hk/exam) を見ずに entry.o や entry.w を
 *   裸で足すと、有給日や休み日の残骸が誤って加算され、残業手当の過剰支給に
 *   つながる。
 *
 * このヘルパーを必ず使い、true の日のみ集計対象にすること。
 *
 * 判定ルール:
 *   - 有給(p) / 試験(exam) / 休み(r) / 現場休(h) / 帰国中(hk) のいずれかがあれば false
 *   - w (出勤) > 0 でなければ false
 *   - 上記いずれにも該当しない（純粋な出勤）場合のみ true
 */
export function isWorkingDay(entry: AttendanceEntry | null | undefined): boolean {
  if (!entry) return false
  if ((entry.p ?? 0) > 0) return false
  if ((entry.r ?? 0) > 0) return false
  if ((entry.h ?? 0) > 0) return false
  if ((entry.hk ?? 0) > 0) return false
  const examVal = (entry as { exam?: number }).exam
  if ((examVal ?? 0) > 0) return false
  return (entry.w ?? 0) > 0
}

/**
 * 在留資格コードから「ベトナム人スタッフ（特定技能・技能実習）」かどうか判定。
 *
 * tokutei1 / tokutei2: 特定技能 1号 / 2号
 * jisshu  / jisshu2 / jisshu3: 技能実習 1号 / 2号 / 3号
 * none: 日本人など対象外
 */
export function isVietnameseWorker(visa: string | undefined | null): boolean {
  if (!visa) return false
  return visa.startsWith('tokutei') || visa.startsWith('jisshu')
}

/**
 * admin/foreman が当該日の出面エントリを「新規作成」または「修正」できるかチェック。
 *
 * ルール:
 *   - 日本人スタッフ等: 常に編集可能（従来通り）
 *   - ベトナム人スタッフ:
 *     ・既存エントリあり → 修正・削除いずれも可能
 *     ・既存エントリなし:
 *        - 「事後申請性ステータス」（有給 p, 帰国中 hk）は admin/foreman の後付け入力を許容
 *          （後から有給申請が出てきた、帰国期間を後で追記したい等の業務に対応）
 *        - 出勤 (w>0) や残業 (o>0) の新規入力はスタッフ本人入力待ち
 *
 * 履歴:
 *   - 2026-05-08 導入: 全カテゴリで既存エントリ必須（自己申告原則）
 *   - 2026-05-11 緩和: 4月後付けPL業務で全件 403 弾きが発生 → 事後申請ステータスのみ例外許容
 *   - 2026-06-XX 緩和: 補償日 (w=0.6, 現場都合休み) を例外に追加
 *     理由: 現場都合休みはスタッフが自己申告する性質ではなく、会社/職長/管理者が
 *           「今日は雨で休み」「資材届かず休み」と判断して代理入力するもの。
 *           スタッフの未入力を待つフローは現実的でない（休業手当60%の支給が漏れる）。
 *
 * @param worker        対象ワーカー（visa フィールドを参照）
 * @param existingEntry att_YYYYMM ドキュメントから取得した現在のエントリ
 * @param newEntry      これから書き込もうとしているエントリ（事後申請性判定用）
 * @returns editable=true なら編集可、false なら不可（reason に理由）
 */
export function canAdminEditEntry(
  worker: { visa?: string | null },
  existingEntry: AttendanceEntry | null | undefined,
  newEntry?: AttendanceEntry | null | undefined,
): { editable: boolean; reason?: string } {
  if (!isVietnameseWorker(worker.visa)) {
    return { editable: true }
  }
  // 2026-10-02 点検: 旧は「既存エントリがあれば何でも可」だったため、欠勤や 0.6補 をいったん入れてから
  //   出勤に変える「2回の保存」で、本人の入力が無い出勤を職長・事務でも作れた。
  //   出勤（賃金が増える入力）にするのは、その日に本人の入力（s:'staff'）か出勤の記録が既にあるときだけ。
  //   それ以外は本人のスマホ入力待ち（代表・事業責任者のさかのぼり入力は呼び出し側で attendance.backfill を見る）
  if (existingEntry) {
    if (!newEntry || !createsWork(newEntry)) return { editable: true }   // 削除・休み系への変更は可
    if (existingEntry.s === 'staff' || createsWork(existingEntry)) return { editable: true }
    return { editable: false, reason: 'スタッフ本人の入力が無い日は、出勤に変えられません（休み・有給・0.6補から出勤への変更を含む）' }
  }
  // 既存エントリなし: 事後申請性ステータスは admin/foreman の後付け入力を許容
  //   - 有給 (p): スタッフが事前申請するが、当日体調不良の事後申請もある
  //   - 帰国中 (hk): 長期帰国は管理者一括登録が運用上自然
  //   - 補償日 (w=0.6): 現場都合休みは会社/職長判断 → 代理入力が前提
  //   - 欠勤 (r, w=0): 来なかった日を本人がスマホ入力することはないため、後付け記録が唯一の手段
  //     （2026-07-09 追加。w=0 で賃金が増えないため、本ガードの趣旨＝賃金操作防止は損なわない。
  //      実例: 未入力のまま最終承認まで進んだ日を、後から欠勤として正す運用）
  if (newEntry) {
    const isPaidLeave = (newEntry.p ?? 0) > 0
    const isHomeLeave = (newEntry.hk ?? 0) > 0
    const isCompensation = (newEntry.w ?? 0) === 0.6
    const isAbsence = (newEntry.r ?? 0) > 0 && (newEntry.w ?? 0) === 0
    if (isPaidLeave || isHomeLeave || isCompensation || isAbsence) {
      return { editable: true }
    }
  }
  return { editable: false, reason: 'スタッフ本人のスマホ入力待ち（有給・欠勤・帰国中・現場都合休みは後付け入力可）' }
}

/**
 * 賃金が出る「出勤」扱いの記録か（canAdminEditEntry の判定用・2026-10-02）。
 * 出勤（w>0。ただし 0.6補＝w:0.6 は会社都合の補償なので除く）・試験・夜勤。休み・有給・帰国中は含めない
 */
export function createsWork(e: AttendanceEntry): boolean {
  if ((e.p ?? 0) > 0 || (e.r ?? 0) > 0 || (e.h ?? 0) > 0 || (e.hk ?? 0) > 0) return false
  const ex = e as { exam?: number; ns?: unknown }
  if ((ex.exam ?? 0) > 0 || !!ex.ns) return true
  const w = e.w ?? 0
  return w > 0 && w !== 0.6
}

/**
 * 現場のシフト種別（日勤/夜勤）を判定する。
 *
 * 判定優先順位（最初にマッチしたものを採用）:
 *   1. site.shiftType フィールドが明示されている場合（'day' / 'night'）
 *   2. workSchedule.startTime の時刻が 16:00 以降 → night
 *   3. 現場名に「夜勤」が含まれる → night
 *   4. 現場ID が `_night` で終わる → night
 *   5. それ以外 → day（デフォルト）
 *
 * 物理的に同じ人が「同日に日勤2件」や「同日に夜勤2件」は不可能なので、
 * detectMultiSiteConflict はこの分類で同種シフトの併記のみを conflict とする。
 * 「日勤＋夜勤」は管理職などが両方を確認したケースで正当扱い。
 */
export function getSiteShiftType(site: {
  id?: string
  name?: string
  shiftType?: 'day' | 'night'
  workSchedule?: { startTime?: string }
}): 'day' | 'night' {
  if (site.shiftType === 'day' || site.shiftType === 'night') return site.shiftType
  const startTime = site.workSchedule?.startTime
  if (startTime) {
    const [hStr] = startTime.split(':')
    const hour = parseInt(hStr, 10)
    if (Number.isFinite(hour) && hour >= 16) return 'night'
  }
  if (site.name && site.name.includes('夜勤')) return 'night'
  if (site.id && site.id.endsWith('_night')) return 'night'
  return 'day'
}

/**
 * 出面エントリがその日の「日勤枠」をどれだけ占有するか（0〜1）。
 *
 * - 出勤 w         → 人工そのまま（1 / 0.5）
 * - 0.6補償        → 1（全日の休業補償。他現場との併存はありえない）
 * - 有給/試験/欠勤/帰国 → 1（全日ステータス）
 * - 現場休(h)      → 0（その現場が休んだだけ。本人は別現場に出られる）
 * - 夜勤のみ(nonly) → 0（日勤枠は空いている）
 */
export function dayShiftOccupancy(entry: AttendanceEntry | null | undefined): number {
  if (!entry) return 0
  if (entry.h) return 0
  if (entry.p || entry.exam || entry.r || entry.hk) return 1
  if (entry.nonly) return 0
  if (entry.w === 0.6) return 1
  return entry.w || 0
}

/**
 * 同一スタッフ・同日の「物理的に不可能」な多現場重複を検出するヘルパー。
 *
 * 判定は**合計人工ベース**（2026-08-31 改修・代表決定）:
 *   - 同種シフトの現場間で、既存エントリの占有 ＋ 新規エントリの占有が **1 を超える** → conflict
 *   - **半日×2現場（0.5+0.5）は許容**（旧実装は同種シフトの併記を一律ブロックしていた）
 *   - 日勤＋夜勤の同日併記は従来どおり許容（枠が別）
 *   - 現場休(h)の現場がある日に別現場へ出勤するのも許容（h は本人の枠を使わない）
 *
 * @param attData      att_YYYYMM の d フィールド全体
 * @param targetSiteId 書き込み先の現場ID
 * @param workerId     書き込み対象のスタッフID
 * @param ym           YYYYMM
 * @param day          日（数値または文字列）
 * @param sites        全現場のメタ情報（シフト種別判定用）
 * @param newEntry     これから書き込むエントリ。省略時は全日（占有1）として扱う
 *                     （スタッフ・職長経路は全日入力しかないため省略でも従来と同義）
 * @returns conflict があれば siteId/entry/shift を返す。なければ null
 */
export function detectMultiSiteConflict(
  attData: Record<string, AttendanceEntry>,
  targetSiteId: string,
  workerId: number,
  ym: string,
  day: number | string,
  sites: { id: string; name?: string; shiftType?: 'day' | 'night'; workSchedule?: { startTime?: string } }[],
  newEntry?: AttendanceEntry | null,
): { conflictSiteId: string; existing: AttendanceEntry; shiftType: 'day' | 'night' } | null {
  const dayStr = String(day)
  const targetSite = sites.find(s => s.id === targetSiteId)
  if (!targetSite) return null  // 現場が見つからなければ判定不能
  const targetShift = getSiteShiftType(targetSite)

  // 新規エントリの占有。省略時は全日（=1）として安全側に判定
  const newOcc = newEntry === undefined ? 1 : dayShiftOccupancy(newEntry)
  if (newOcc <= 0) return null  // 現場休や削除など、枠を使わない書き込みは常に許可

  let occupied = 0
  let firstOther: { conflictSiteId: string; existing: AttendanceEntry } | null = null

  for (const [key, entry] of Object.entries(attData)) {
    if (!entry) continue
    const parts = key.split('_')
    if (parts.length < 4) continue
    const keyDay = parts[parts.length - 1]
    const keyYm = parts[parts.length - 2]
    const keyWid = parts[parts.length - 3]
    const keySid = parts.slice(0, parts.length - 3).join('_')
    if (keyYm !== ym) continue
    if (keyDay !== dayStr) continue
    if (parseInt(keyWid, 10) !== workerId) continue
    if (keySid === targetSiteId) continue

    const otherSite = sites.find(s => s.id === keySid)
    if (!otherSite) continue  // 不明な現場はスキップ（残骸データの可能性）
    const otherShift = getSiteShiftType(otherSite)
    if (otherShift !== targetShift) continue  // 日勤+夜勤など枠が別 → 数えない

    const occ = dayShiftOccupancy(entry as AttendanceEntry)
    if (occ <= 0) continue
    occupied += occ
    if (!firstOther) firstOther = { conflictSiteId: keySid, existing: entry as AttendanceEntry }
  }

  // 浮動小数点の誤差を吸収（0.5+0.5 = 1.0 を確実に許可する）
  if (firstOther && occupied + newOcc > 1.0001) {
    return { ...firstOther, shiftType: targetShift }
  }
  return null
}

// ────────────────────────────────────────
//  出面ステータス判定
// ────────────────────────────────────────

/**
 * 出面エントリのステータス判定。
 * 優先順位: P(有給) > E(試験) > R(休み) > H(現場休み) > HK(帰国中) > 残業 > 出勤 > 未入力
 *
 * 注意: lib/compute.ts の月次集計では hk が r/h より先に continue するが、
 * UI 表示用のこの関数では「ユーザーが明示的に選んだステータス（r/h）」を優先表示する。
 * 給与・人工計算には影響しない（compute.ts 側のロジックが正）。
 */
export function getEntryStatus(entry: AttendanceEntry | null | undefined): AttendanceStatus {
  if (!entry) return 'none'
  if (entry.p && entry.p === 1) return 'leave'
  if (entry.exam && entry.exam === 1) return 'exam'
  if (entry.r && entry.r === 1) return 'rest'
  if (entry.h && entry.h === 1) return 'site_off'
  if (entry.hk && entry.hk === 1) return 'home_leave'
  // 0.6補償（現場都合休み）。w=1 だけを出勤とみなす旧判定では 'none' に落ち、
  // スマホ・職長画面で「未入力」と誤表示されていた（2026-08-28 実機確認で発覚）
  if (entry.w === 0.6) return 'comp'
  // 出勤は w>0（1日・半日 0.5）と夜勤のみ（nonly・w は 1）。
  // 2026-10-02 総合点検: 旧は w === 1 だけを出勤とし、半日（0.5。日本人と旧契約のフン・フォン・タンが PC・職長スマホで選べる）が
  //   'none' ＝未入力に落ちていた。職長の一覧・まとめ承認は「未入力」で止まり、本人のスマホには督促が出て、
  //   別現場の入力の索引からも落ちていた（本人確認の kindOf と給与計算は w>0 を出勤に数えるので食い違っていた）
  const w = entry.w ?? 0
  if (w > 0 || entry.nonly) {
    return entry.o && entry.o > 0 ? 'overtime' : 'work'
  }
  return 'none'
}


/**
 * 出面エントリから「削除すべき残骸フィールド」を自動算出する。
 *
 * 設計思想 (2026-05-09):
 *   出面エントリは7つの主要フィールドを持つ:
 *     w (出勤), o (残業時間), p (有給), r (休み), h (現場休), hk (帰国中), exam (試験)
 *   さらに時間ベース入力 (5月以降) では st/et/b1/b2/b3、休みでは rReason/rNote。
 *
 *   ステータス変更時に古いフィールドが残ると、集計コードが残骸データを誤って計上する
 *   リスクがある（2026-05-09 ビンさん事案）。
 *   このヘルパーは「**新エントリで言及されていない既知フィールドを全て削除する**」
 *   というシンプルな原則に基づき、漏れなく残骸を消す。
 *
 * 使い方:
 *   const entry = { w: 0, p: 1, s: 'staff' }   // 有給
 *   const deleteFields = computeAttendanceDeleteFields(entry)
 *   // deleteFields = ['o', 'r', 'h', 'hk', 'exam', 'st', 'et', 'b1', 'b2', 'b3', 'rReason', 'rNote']
 *   await setAttendanceEntry(siteId, workerId, ym, day, entry, { deleteFields })
 */
export function computeAttendanceDeleteFields(entry: AttendanceEntry): string[] {
  const ALL_KNOWN_FIELDS = [
    'w', 'o',                                  // 出勤・残業
    'p', 'r', 'h', 'hk', 'exam',                // ステータス flag
    'st', 'et', 'b1', 'b2', 'b3',               // 時間ベース
    'rReason', 'rNote',                          // 休み理由
    'ns', 'nonly', 'nst', 'net', 'nb', 'nnote',  // 夜勤ブロック
  ]
  // 's' (source) はメタデータなので削除対象外
  // 新エントリで定義されていないフィールドを削除対象に
  const present = new Set(Object.keys(entry))
  return ALL_KNOWN_FIELDS.filter(f => !present.has(f))
}


/**
 * 保存の前後で有給(p)の有無が変わったか（2026-10-02・次期繰越の再計算を本当に要るときだけにする）。
 * 有給が付いた・外れたときだけ true。どちらも有給なし／どちらも有給ありなら false。
 */
export function paidLeaveChanged(
  prev: Pick<AttendanceEntry, 'p'> | null | undefined,
  next: Pick<AttendanceEntry, 'p'> | null | undefined,
): boolean {
  return !!prev?.p !== !!next?.p
}
