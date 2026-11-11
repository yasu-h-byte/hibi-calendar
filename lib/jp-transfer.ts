/**
 * 新卒（月給）→ 日給月給への移行（docs/wage-system.md 第13節・2026-11-11 代表決定）。
 *
 * 決まり:
 *   - 中卒・高卒の新卒は月給で入り、**入社した翌年の10月1日**に日給月給（号俸制）へ移る
 *     （4月入社なら1年半後。年次改定の基準日とそろえる）
 *   - ただし **18歳になっていること**。その10月1日に18歳未満なら、**18歳の誕生日の翌月1日**に移る（それまで月給のまま）
 *     （18歳未満は残業・休日出勤ができず週40時間まで＝ほかの社員と同じ働き方ができない。労基法60条）
 *   - 号は **1G で「月給を日額に直した額を上回る最初の号」**。月給は完全週休2日（年間所定251日）の金額なので
 *     日額 = 月給 × 12 ÷ 251
 *   - 移ってから6ヶ月未満の年次改定（10月1日）は対象外（号を決めたばかり。中途採用の初回改定と同じ考え方）
 *
 * ここは制度の計算だけ（個人の金額は持たない）。画面からも import してよい。
 */
import { ageOn, dailyForStep, dailyFromMonthly, stepForDaily, type JpGrade } from './jp-wage'

/** 移行できる年齢（この年齢になっていること） */
export const JP_TRANSFER_MIN_AGE = 18
/** 月給（完全週休2日）を日額へ直すときの年間所定日数（年間休日114日） */
export const NEW_GRAD_ANNUAL_WORK_DAYS = 251
/** 移行先の等級（新卒は初級職から） */
export const JP_TRANSFER_GRADE: JpGrade = '1G'
/** 移行日の何日前から知らせるか */
export const JP_TRANSFER_NOTICE_DAYS = 60

const ISO = /^\d{4}-\d{2}-\d{2}$/

interface TraineeLike {
  visa?: string | null
  visaType?: string | null
  job?: string | null
  jobType?: string | null
  salary?: number | null
  jpGrade?: string | null
}

/**
 * 月給で働いている新卒（＝まだ号俸制に入っていない日本人）か。
 * 人員マスタに印を足さず「日本人・役員と事務以外・月給あり・等級なし」で決める（印の付け忘れが起きない）。
 */
export function isJpMonthlyTrainee(w: TraineeLike | null | undefined): boolean {
  if (!w) return false
  const visa = w.visa ?? w.visaType
  const job = w.job ?? w.jobType
  if (visa && visa !== 'none') return false
  if (job === 'yakuin' || job === 'jimu') return false
  return (w.salary ?? 0) > 0 && !w.jpGrade
}

export interface TransferSchedule {
  /** 移行日（入社翌年の10月1日か、18歳の誕生日の翌月1日）。入社日か生年月日が無くて決まらないときは null */
  date: string | null
  /** 入社した翌年の10月1日（年齢を見ない場合の日） */
  baseDate: string | null
  /** 18歳を待つために baseDate より後ろへずれたか */
  waitsForAge: boolean
  /** 決まらない理由（画面に出す言葉） */
  blockers: string[]
}

/** 移行日 = 入社した翌年の10月1日。その日に18歳未満なら、18歳の誕生日の翌月1日 */
export function jpTransferSchedule(hireDate?: string | null, birthDate?: string | null): TransferSchedule {
  const blockers: string[] = []
  if (!hireDate || !ISO.test(hireDate)) blockers.push('入社日が未登録')
  if (!birthDate || !ISO.test(birthDate)) blockers.push('生年月日が未登録（18歳になる日が分からない）')
  const baseYear = hireDate && ISO.test(hireDate) ? Number(hireDate.slice(0, 4)) + 1 : null
  const baseDate = baseYear ? `${baseYear}-10-01` : null
  if (blockers.length > 0 || !baseYear) return { date: null, baseDate, waitsForAge: false, blockers }
  if (ageOn(birthDate!, baseDate!) >= JP_TRANSFER_MIN_AGE) return { date: baseDate, baseDate, waitsForAge: false, blockers }
  // 18歳の誕生日の翌月1日（誕生日が1日でも翌月。12月生まれは翌年1月）
  const by = Number(birthDate!.slice(0, 4)); const bm = Number(birthDate!.slice(5, 7))
  const y = by + JP_TRANSFER_MIN_AGE + (bm === 12 ? 1 : 0)
  const m = bm === 12 ? 1 : bm + 1
  return { date: `${y}-${String(m).padStart(2, '0')}-01`, baseDate, waitsForAge: true, blockers }
}

export interface TransferPlacement {
  /** 月給を日額に直した額（月給 × 12 ÷ 251・円未満四捨五入） */
  dailyFromMonthly: number
  grade: JpGrade
  /** その額を上回る最初の号 */
  step: number
  /** その号の日額 */
  daily: number
}

/** 月給 → 1G の「上回る最初の号」 */
export function transferPlacement(monthly: number): TransferPlacement {
  const d = dailyFromMonthly(monthly, NEW_GRAD_ANNUAL_WORK_DAYS)
  const step = stepForDaily(JP_TRANSFER_GRADE, d)
  return { dailyFromMonthly: d, grade: JP_TRANSFER_GRADE, step, daily: dailyForStep(JP_TRANSFER_GRADE, step) }
}

/** 今日から移行日までの日数（過ぎていればマイナス） */
export function daysUntil(dateIso: string, todayIso: string): number {
  return Math.round((Date.parse(dateIso) - Date.parse(todayIso)) / 86400000)
}

export type TransferStatus = 'needInput' | 'waiting' | 'soon' | 'due'

/** 画面・通知で使う状態: 入力待ち／まだ先／もうすぐ（60日以内）／移行日を過ぎた */
export function transferStatus(schedule: TransferSchedule, todayIso: string): TransferStatus {
  if (!schedule.date) return 'needInput'
  const d = daysUntil(schedule.date, todayIso)
  if (d <= 0) return 'due'
  return d <= JP_TRANSFER_NOTICE_DAYS ? 'soon' : 'waiting'
}

/**
 * その月の給与が「移行日を過ぎたのに月給のまま」か（月次集計の注意点）。
 * ym は 'YYYYMM' か 'YYYY-MM'。
 */
export function isTransferOverdueForYm(
  w: TraineeLike & { hireDate?: string | null; birthDate?: string | null },
  ym: string,
): string | null {
  if (!isJpMonthlyTrainee(w)) return null
  const s = jpTransferSchedule(w.hireDate, w.birthDate)
  if (!s.date) return null
  const key = ym.replace('-', '')
  return key >= s.date.slice(0, 4) + s.date.slice(5, 7) ? s.date : null
}
