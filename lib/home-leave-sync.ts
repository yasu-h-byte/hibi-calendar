import { db } from './firebase'
import { doc, updateDoc, deleteField } from '@/lib/fsdb'
import { ensureDocExists } from './firestore-safe'
import { getAttendanceDoc, attKey, getStaffSites, ymKey } from './attendance'
import { checkMonthLocked } from './locks'
import type { AttendanceEntry } from '@/types'

/**
 * 帰国期間 ⇄ 出面の帰国フラグ(hk) 同期（2026-08-03 追加）
 *
 * ■ なぜ必要か（グエン タイン フウ事案）
 *   hk は「承認時に出面ドキュメントへ実際に書き込む」実体データで、homeLongLeave の
 *   期間から都度計算しているわけではない。ところが期間を変更・削除できる経路は5つ
 *   （承認 / 手動登録 / 期間変更 / 削除 / 取消）あるのに、出面へ書いていたのは
 *   「承認」の1箇所だけだった。
 *
 *   結果、7/24〜12/1 で承認 → hk を書き込み → 開始日を 9/1 に変更、という操作で
 *   7/24〜8/31 の hk が消えずに残り、出面入力画面が「7/30から帰国」と表示していた。
 *   期間を編集すれば誰にでも再現する構造的な欠陥だった。
 *
 * ■ 方針: 差分を追いかけず「その月のあるべき状態」に合わせる（冪等な reconcile）
 *   旧期間と新期間が触れる月を洗い出し、月ごとに全日を見て
 *     - あるべき日に hk が無ければ立てる
 *     - あるべきでない日に hk があれば消す
 *   これにより、過去にどの経路で壊れたデータでも、その月を通せば必ず正しくなる。
 *   同じ引数で何度呼んでも結果が変わらないので、リトライしても安全。
 *
 * ■ 触らないもの
 *   - 実際の出勤(w>0) / 有給(p) / 休み(r) / 現場休(h) / 試験(exam) が入っている日。
 *     人が入力した実績を機械が消してはいけない。skipped として返す。
 *   - ロック済みの月（給与確定後にデータが動くと支払額と食い違う）。lockedMonths で返す。
 */

export interface HomeLeaveRange {
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
}

export interface HomeLeaveSyncResult {
  /** hk を新たに立てた日（YYYY-MM-DD） */
  written: string[]
  /** hk を消した日（YYYY-MM-DD） */
  cleared: string[]
  /** 実績が入っていて触らなかった日（YYYY-MM-DD） */
  skipped: string[]
  /** ロック済みで処理しなかった月（YYYYMM） */
  lockedMonths: string[]
}

/**
 * 帰国フラグを書き込む先の上限（今月から何ヶ月先まで）。
 *
 * 「復帰未定」の終了日は番兵値 9999-12-31 のため、素直に期間を1日ずつ辿ると
 * 事実上無限ループになり、Firestore に膨大な書き込みが走る。実際の運用で
 * 1年より先の出面を先に埋める意味は無いので、ここで頭を打つ。
 * 画面表示は homeLongLeave の期間から直接判定しているため、hk が無い先の月でも
 * 帰国中として正しく表示される（AttendanceGrid の homeLeaves 判定）。
 */
export const HK_STAMP_HORIZON_MONTHS = 12

/** 'YYYY-MM-DD' → 'YYYYMM' */
function ymOf(iso: string): string {
  return iso.slice(0, 4) + iso.slice(5, 7)
}

function addMonths(ym: string, n: number): string {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)) - 1 + n, 1)
  return ymKey(d.getFullYear(), d.getMonth() + 1)
}

function monthsInclusive(fromYm: string, toYm: string): string[] {
  const out: string[] = []
  let cur = fromYm
  // 上限は保険（暴走防止）。実際は HK_STAMP_HORIZON_MONTHS で先に頭打ちになる。
  while (cur <= toYm && out.length < 120) {
    out.push(cur)
    cur = addMonths(cur, 1)
  }
  return out
}

/**
 * 「帰国フラグだけで出来ている空エントリ」か。
 * 承認時に書かれる実体は { w: 0, hk: 1 } なので、これは丸ごと消してよい。
 * 実績が混ざっているエントリは hk フィールドだけ落とす。
 */
function isPureHomeLeaveStub(entry: AttendanceEntry): boolean {
  const keys = Object.keys(entry)
  return keys.every(k => k === 'hk' || k === 'w' || k === 's') && !(entry.w && entry.w > 0)
}

/** 人が入力した実績が入っているか（機械が消してはいけない日） */
function hasExplicitStatus(entry: AttendanceEntry | undefined): boolean {
  if (!entry) return false
  return (
    (entry.p ?? 0) > 0 ||
    (entry.r ?? 0) > 0 ||
    (entry.w ?? 0) > 0 ||
    !!entry.h ||
    !!entry.exam
  )
}

/** その日に対して何をするか */
export type HomeLeaveDayAction =
  | 'write'        // hk を立てる
  | 'clear-entry'  // 帰国フラグだけの空エントリなので丸ごと消す
  | 'clear-field'  // 実績が混ざっているので hk フィールドだけ落とす
  | 'skip'         // 帰国期間内だが実績が入っているので触らない
  | 'noop'         // 既に正しい

/**
 * 1日分の判定（副作用なし）。同期処理の心臓部をここに切り出してテスト可能にしている。
 *
 * @param entry         現在の出面エントリ（無ければ undefined）
 * @param shouldHaveHk  その日が帰国期間内か（日曜は呼び出し側で false にする）
 */
export function planHomeLeaveDay(
  entry: AttendanceEntry | undefined,
  shouldHaveHk: boolean,
): HomeLeaveDayAction {
  if (shouldHaveHk) {
    if (hasExplicitStatus(entry)) return 'skip'
    return entry?.hk ? 'noop' : 'write'
  }
  if (!entry?.hk) return 'noop'
  return isPureHomeLeaveStub(entry) ? 'clear-entry' : 'clear-field'
}

/**
 * 帰国期間の変更を出面へ反映する。
 *
 * @param workerId  対象スタッフ
 * @param oldRange  変更前の期間（新規登録なら null）
 * @param newRange  変更後の期間（削除・取消なら null）
 * @param options.siteId 明示したい場合。省略時はスタッフの配置現場の先頭を使う
 */
export async function syncHomeLeaveAttendance(
  workerId: number,
  oldRange: HomeLeaveRange | null,
  newRange: HomeLeaveRange | null,
  options: { siteId?: string } = {},
): Promise<HomeLeaveSyncResult> {
  const result: HomeLeaveSyncResult = { written: [], cleared: [], skipped: [], lockedMonths: [] }

  let siteId = options.siteId
  if (!siteId) {
    const sites = await getStaffSites(workerId)
    siteId = sites.length > 0 ? sites[0].id : ''
  }
  // 現場が特定できないと出面のキーが作れない。何もしないが、これは異常系。
  if (!siteId) return result

  // 対象月 = 旧期間 ∪ 新期間 が触れる月。旧期間を含めるのは残骸を消すため。
  const starts: string[] = []
  const ends: string[] = []
  for (const r of [oldRange, newRange]) {
    if (!r?.startDate || !r?.endDate) continue
    starts.push(ymOf(r.startDate))
    ends.push(ymOf(r.endDate))
  }
  if (starts.length === 0) return result

  const now = new Date()
  const horizonYm = addMonths(ymKey(now.getFullYear(), now.getMonth() + 1), HK_STAMP_HORIZON_MONTHS)
  const fromYm = starts.slice().sort()[0]
  let toYm = ends.slice().sort().reverse()[0]
  if (toYm > horizonYm) toYm = horizonYm
  if (fromYm > toYm) return result

  for (const ym of monthsInclusive(fromYm, toYm)) {
    if (await checkMonthLocked(ym)) {
      result.lockedMonths.push(ym)
      continue
    }

    const att = await getAttendanceDoc(ym)
    const y = Number(ym.slice(0, 4))
    const m = Number(ym.slice(4, 6))
    const daysInMonth = new Date(y, m, 0).getDate()
    const updates: Record<string, unknown> = {}

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
      const key = attKey(siteId, workerId, ym, day)
      const entry = att[key]
      // 日曜は元々出面対象外なので帰国フラグも立てない（承認時の既存仕様を踏襲）
      const isSunday = new Date(y, m - 1, day).getDay() === 0
      const shouldHaveHk =
        !!newRange && !isSunday && iso >= newRange.startDate && iso <= newRange.endDate

      switch (planHomeLeaveDay(entry, shouldHaveHk)) {
        case 'write':
          updates[`d.${key}.w`] = 0
          updates[`d.${key}.hk`] = 1
          result.written.push(iso)
          break
        case 'clear-entry':
          // 帰国フラグだけの空エントリ → 丸ごと削除（w:0 の残骸を残さない）
          updates[`d.${key}`] = deleteField()
          result.cleared.push(iso)
          break
        case 'clear-field':
          updates[`d.${key}.hk`] = deleteField()
          result.cleared.push(iso)
          break
        case 'skip':
          result.skipped.push(iso)
          break
        case 'noop':
          break
      }
    }

    if (Object.keys(updates).length > 0) {
      const ref = doc(db, 'demmen', `att_${ym}`)
      // updateDoc はドキュメント未存在だと失敗する。空マージの直書きは既存データを
      // 消し飛ばす罠があるため必ず ensureDocExists を通すこと（lib/firestore-safe.ts）。
      await ensureDocExists(ref)
      await updateDoc(ref, updates)
    }
  }

  return result
}
