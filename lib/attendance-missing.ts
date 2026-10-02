/**
 * 「未入力」の数え方（2026-10-02 総合点検・純関数）
 *
 * ## なぜ必要か
 * 「その日に入力があるはずの人」「仕事の日か」「入力済みか」を、職長の一覧（lib/foreman-todo.ts）・職長スマホ（ログイン版）・
 * 本人のスマホの督促（app/api/attendance/staff）・本人確認の数え方（lib/attendance-confirm.ts）がそれぞれ自前に書いていた。
 *   例: 配置に残ったまま別の現場へ移った人を、マイページは数えない（別現場の入力あり）のに、職長スマホは毎日「未入力1名」と
 *       出していた。在籍の判定も画面で手書きだった。
 * ここに「仕事の日か」と「1日ぶんの集計」を置き、各画面はこれを呼ぶ。
 *   - 入力済みかどうか（getEntryStatus）・別現場に入力があるか（entryPlace）は呼ぶ側から渡す（Firestore や
 *     lib/attendance.ts を読み込まない純関数のまま、本人確認のクライアント側コードからも使えるように）
 *   - 給与計算（lib/compute.ts）はこのファイルを使わない（結果を変えない）
 */

/**
 * その日は仕事の日か。承認済みの就業カレンダー（day → 'work' | 'off' | 'holiday'）があればその 'work'、
 * 無ければ日曜以外。本人確認・職長の一覧・スタッフの督促で同じ決まり。
 */
export function isWorkDayOf(calDays: Record<string, string> | null | undefined, y: number, m: number, day: number): boolean {
  if (calDays) return calDays[String(day)] === 'work'
  return new Date(y, m - 1, day).getDay() !== 0
}

/** 'YYYYMM' と日から 'YYYY-MM-DD' */
export function isoOfDay(ym: string, day: number): string {
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
}

/** その人のその日はどこに入力があるか */
export type DayPlace = 'here' | 'elsewhere' | 'none'

export interface DayInputs<W> {
  /** この現場に入力がある人数 */
  entered: number
  /** 対象の人数（仕事の日: 対象の全員 − 別現場 − 対象外／休みの日: 入力した人だけ） */
  total: number
  /** 仕事の日に、どこにも入力が無い人 */
  missing: W[]
  /** 別の現場に入力がある人（未入力に数えない・2026-10-01 代表決定） */
  elsewhere: W[]
  /** その日の対象でない人（入社前・退職後・帰国中）の人数 */
  notExpected: number
}

/**
 * 現場×1日の入力のそろい具合。
 *   - 別の現場で入力している人（移動・掛け持ち）は未入力に数えず、この日の対象からも外す
 *   - 休みの日（日曜・カレンダーの休み）は、入力した人だけが対象。入力が無い人は休みとして正常
 *   - 対象でない人（入社前・退職後・帰国中など。`expectedOn`）は数えない
 * @param placeOf   その人のその日の入力の場所（'here' | 'elsewhere' | 'none'）
 * @param expectedOn その日に入力があるはずの人か（在籍・帰国中でない）。省略時は全員が対象
 */
export function evaluateDayInputs<W>(args: {
  workers: W[]
  isWorkDay: boolean
  placeOf: (w: W) => DayPlace
  expectedOn?: (w: W) => boolean
}): DayInputs<W> {
  const { workers, isWorkDay, placeOf, expectedOn } = args
  const missing: W[] = []
  const elsewhere: W[] = []
  let entered = 0
  let notExpected = 0
  for (const w of workers) {
    const place = placeOf(w)
    if (place === 'here') { entered++; continue }
    if (expectedOn && !expectedOn(w)) { notExpected++; continue }
    if (place === 'elsewhere') { elsewhere.push(w); continue }
    if (isWorkDay) missing.push(w)
  }
  return {
    entered,
    total: isWorkDay ? workers.length - elsewhere.length - notExpected : entered,
    missing,
    elsewhere,
    notExpected,
  }
}
