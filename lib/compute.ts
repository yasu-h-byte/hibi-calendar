import { isSuspectCompanyRest } from './attendance-confirm'
import { detectRestMismatches } from './rest-mismatch'
import {
  AttendanceEntry, calcActualHours, calcDayShiftHours, calcNightShiftHours,
  getNightRange, timeToMinutes, calcManDays, NIGHT_SHIFT_MANDAYS, calcOvertimeHours, type SiteWorkSchedule,
} from '@/types'
import { ymKey, isWorkingDay } from './attendance'
import { isStillActiveForMonth, isHiredByMonth, effectiveRateForYm, effectiveHourlyRateForYm, effectiveSalaryForYm } from './workers'
import { isTobiGroup, isDokoGroup } from './jobs'
import { withWorkTypeSiteCalendars } from './site-hierarchy'
import type { HomeLeaveEntry } from './homeLeave'
import {
  DRIVE_ALLOWANCE_FROM_YM, SITE_ALLOWANCE_FROM_YM, calcMonthlyAllowances, dailyAllowanceYen, isAllowanceEligibleDay,
  type SiteCommute, type WorkerAllowanceMonthly,
} from './allowance'

// ────────────────────────────────────────
//  円未満の端数処理（2026-06: 労基の過少支払い指摘を踏まえ「支給は切上・控除は切捨」で統一）
//    浮動小数点ノイズ対策として、まず銭(0.01円)単位に四捨五入してから円に丸める。
//    例: ceilYen(220000.0000001)=220000 / ceilYen(2984.375)=2985 / floorYen(50000.4)=50000
// ────────────────────────────────────────
/** 支給額: 1円未満を切り上げ（従業員有利・過少支払い防止） */
export const ceilYen = (v: number): number => Math.ceil(Math.round(v * 100) / 100)
/** 控除額: 1円未満を切り捨て（控除を増やさない＝過少支払い防止） */
export const floorYen = (v: number): number => Math.floor(Math.round(v * 100) / 100)

// 日本人・月給制の割増賃金算定基礎「月平均所定労働時間」(145h)。
// 給与計算エンジンと人員マスタ画面の参考表示で同じ値を使うため lib/constants.ts に集約。
export { JP_SALARY_AVG_MONTHLY_HOURS } from './constants'
import { JP_SALARY_AVG_MONTHLY_HOURS, JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM, JP_AVG_MONTHLY_WORK_DAYS } from './constants'
import { currentYmJst, todayJstDate, todayJstIso } from '@/lib/date-utils'
import { LEAVE_SETTLE_FROM_YM, LEAVE_SETTLE_MONTH_CAP_DAYS, LEAVE_SETTLE_LABEL, isLeaveSettleEligible, settledDaysForYm } from './leave-settle'

/**
 * 現場都合休（0.6補償）を「最低20日保証」の枠の中では100%支給にする適用開始月（2026-09-15 代表決定）。
 * それより前の月は、補償日を一旦欠勤控除して休業手当60%を足す従来方式（2026-06 社労士確認）。
 */
export const COMP_FULL_WITHIN_GUARANTEE_FROM_YM = '202608'

/**
 * 最低20日保証から本人の欠勤を引く（2026-09-30 代表決定「案A」・2026年9月分から）。
 *   保証日数 = 20日（閑散月はカレンダー所定）− 本人の欠勤日数（出面の「欠」の日数）
 *   稼働日の入力漏れ（空欄）はここに入れない: 複数現場の人は主現場のカレンダーで数えるため誤検出があり得る。
 *   空欄はこれまでどおり「保証に届かない分」として控除され、月次集計に ⚠ 稼働日未入力 が出る
 *   例: 欠勤1日 → 19日保証、欠勤2日 → 18日保証
 * 保証日数を超えた現場都合休（0.6補）は、これまでどおり休業手当60%。
 * 旧（8月分まで）: 稼働日が20日を超える月は、欠勤しても出勤＋有給＋現場都合休で20日に届けば控除なし
 *   （例: 稼働21日に欠勤1日でも20日分）。自己都合の欠勤が控除されないのはおかしい、との判断で改めた。
 * オブジェクトにしているのは、影響の試算（過去月に当てはめたら）で書き換えられるようにするため。本番では変えない。
 */
export const PAYROLL_RULES = { personalAbsenceReducesGuaranteeFromYm: '202609' }

/**
 * 日本人の1日所定労働時間。割増賃金の算定基礎（日額 ÷ 所定時間）の分母。
 * docs/labor-rules.md「日本人は1日8時間（長年の運用。日給は8時間分の対価）」に対応。
 * 外国人は変形労働時間制で7h。
 */
export const JP_PRESCRIBED_HOURS_PER_DAY = 8

/**
 * 日本人の法定休日（日曜）割増の適用開始月。
 *
 * 労基法37条の35%増は本来ずっと適用されるが、実装は 2026-08 からのため、
 * **過去月は支払済みの金額どおりに再現される必要がある**
 * （docs/historical-changes.md は労基法115条＝賃金請求権3年の証跡として、
 *  過去の計算を再現できることを前提にしている）。
 * 遡及支払いは行わない方針（2026-08-13 代表判断）。この月ゲートを外すと
 * 過去月の表示額が実際の支払額と食い違うため、変更するときは遡及支払いの
 * 実施とセットで判断すること。
 */
export const JP_LEGAL_HOLIDAY_FROM_YM = '202608'
/**
 * 日本人の日曜割増の最終月（2026-09-30 代表決定: 政仁さんを含め日本人は日曜の割増なし＝従来の運用に戻す）。
 * 10月分からは日曜の出勤も「日額 × 人工 ＋ 残業h × 1.25」の通常計算。
 * 8〜9月分は実際にこの計算で締めているので、その2か月は割増ありのまま再現する（historical-changes.md）。
 * 法定休日（週1日の休み）が取れていない週の日曜出勤は割増が法律上必要なので、
 * 「前の6日すべて出勤した日曜」を sundayNoRestDays で警告する（支給額は変えない・夜勤の法定割れと同じ扱い）。
 */
export const JP_LEGAL_HOLIDAY_UNTIL_YM = '202609'
export function jpSundayPremiumApplies(ym: string): boolean {
  return ym >= JP_LEGAL_HOLIDAY_FROM_YM && ym <= JP_LEGAL_HOLIDAY_UNTIL_YM
}

/**
 * 日本人（役員以外）の「週40時間超（月〜土の出勤×8h）」の注意点を出し始める月（'YYYYMM'）。
 * 2026-10-03 代表決定「週40時間超の割増はとりあえず従来どおり不要」→ null（出さない）。
 * 9月分から出していた注意点が、変形労働時間制の確認が取れるまで毎月「要確認」になるのを止めた。
 * 社労士から割増が要ると言われたら、ここに開始月を入れるだけでその月分から注意点が戻る（集計と目安額の計算は残してある）。
 */
export const JP_WEEK_OVER40_NOTE_FROM_YM: string | null = null

/**
 * 旧契約（useOldRules・固定月給）の人の「支給額が日給×働いた日数を下回る」の注意点を出し始める月（'YYYYMM'）。
 * 2026-10-05 代表決定「旧契約のメンバーには最低保証（日数分は払う）の決まりを置いていない。契約でも約束していない
 * ので、この注意は不要」→ null（出さない）。支給額はもともと変えていない（注意点だけ）。
 * 旧契約の人に最低保証を置くことになったら、ここに開始月を入れるとその月分から注意点が戻る。
 * 日本人月給制の月途中の入社・退職の注意点（同じ code）と、旧契約の「日曜・夜勤・所定超え」の注意点はそのまま出す。
 */
export const OLD_RULE_BELOW_WORKED_DAYS_NOTE_FROM_YM: string | null = null

// ────────────────────────────────────────
//  Firestoreデータ読み込み
// ────────────────────────────────────────

export interface MainData {
  workers: RawWorker[]
  sites: RawSite[]
  subcons: RawSubcon[]
  assign: Record<string, {
    workers?: number[]; subcons?: string[]; dispatch?: number[]
    subconRates?: Record<string, { rate?: number; otRate?: number }>
    /** 工種サイトを持つ親現場だけで使う: 作業員ごとの既定の入力先（工種サイト id）。2026-09-25 */
    defaultWorkType?: Record<string, string>
    /** 同上、外注先ごと */
    defaultWorkTypeSubcon?: Record<string, string>
    /** 日ごとの工種指定（ym → day → 工種サイト id）。作業員の既定より優先。2026-09-25 */
    dayWorkType?: Record<string, Record<string, string>>
  }>
  massign: Record<string, { workers?: number[]; subcons?: string[]; dispatch?: number[] }>
  billing: Record<string, number[]>
  workDays: Record<string, number>
  siteWorkDays: Record<string, Record<string, number>> // { YYYYMM: { siteId: count } }
  locks: Record<string, boolean>
  plData: Record<string, PLRecord[]>
  defaultRates: { tobiRate?: number; dokoRate?: number }
  mforeman: Record<string, { foreman?: number; wid?: number; note?: string }>
  /**
   * 夜勤が発生した日（台風待機など）。key = `${siteId}_${ym}`、値 = 日のリスト。
   * 出面画面で「この日は夜勤あり」と指定された日だけスタッフのセルに夜勤バッジが出る。
   * 誰が夜勤したかはエントリ側の ns フラグが持つ。ここは入力対象日を絞るためだけの指定で、
   * 給与計算・所定日数には一切影響しない（純粋なUIフィルタ）。
   */
  nightDays: Record<string, number[]>
  // 2026-05-13: 旧 main.homeLeaves 配列は廃止（homeLongLeave コレクションに統合）
  //   フィールド自体は demmen/main 上に空配列として残るが、production 読み取りはしない。
  /**
   * 応援の請求書（lib/peer-invoice.ts）に載せる自社情報（2026-09-25）。
   * 未設定（null/undefined）なら空欄のまま印刷される — 住所・登録番号・口座は社長が settings
   * 画面で自分で入力するまで**先回りで埋めない**（代表指示）。
   */
  companyProfile?: CompanyProfile | null
  /**
   * HFU → 日比建設 の請求書（lib/hfu-invoice.ts・2026-09-26）の設定。
   * HFU 側の発行者情報と、日比建設へ請求する社内単価（鳶/土工・1人工あたり税抜）。
   * 未設定なら請求書は下書きのみ（単価 0・発行は拒否）。
   */
  hfuInvoice?: HfuInvoiceSettings | null
  /** 管理者設定で投稿したお知らせ（表示はリリースノートと合わせて lib/release-notes.ts mergeAnnouncements） */
  announcements?: import('./release-notes').Announcement[]
}

/** HFU → 日比建設 の請求書の設定（settings 画面「HFU → 日比建設 の請求書」で編集） */
export interface HfuInvoiceSettings {
  profile: CompanyProfile
  /** 鳶 1人工あたりの単価（税抜）。残業は 単価÷8×1.25（円未満四捨五入）× 時間で別行 */
  tobiRate: number
  /** 土工 1人工あたりの単価（税抜） */
  dokoRate: number
  /**
   * 待機料の率（%・既定 60）。現場の都合で休ませた日（出面の 0.6補）を「日数 × 1人工の単価 × 率」で請求する
   * （2026-10-21 代表決定・2026年10月分から）。0 なら待機料の行を出さない。未保存（undefined）は既定の 60
   */
  standbyRatePct?: number
  /** 未設定なら翌月末払い */
  paymentTerms?: CompanyPaymentTerms
}

/** 応援の請求書に印字する自社（発行者）情報。settings 画面「請求書の自社情報」で編集 */
export interface CompanyProfile {
  name: string
  nameEn: string
  /** 代表者（例: 代表取締役 日比 靖仁）。任意。発行者欄に印字 */
  representative?: string
  postal: string
  address: string
  tel: string
  fax?: string
  email?: string
  /** 適格請求書発行事業者の登録番号 "T" + 13桁 */
  invoiceRegNo: string
  bank: {
    bankName: string
    branch: string
    accountType: '普通' | '当座'
    accountNo: string
    holder: string
  }
  /** 請求書番号の接頭辞。既定 "HC" */
  invoicePrefix: string
}

/** 取引先の支払条件（月末締め固定・何ヶ月後の何日払いか） */
export interface CompanyPaymentTerms {
  /** 締め日。当面は月末固定のみ */
  closing: 'end'
  /** 対象月の何ヶ月後に払うか（1=翌月払い、2=翌々月払い） */
  payMonthOffset: 1 | 2
  /** 支払日。数値 or 'end'（月末）。休日なら前営業日に繰り上げ */
  payDay: number | 'end'
}

export interface RawWorker {
  id: number; name: string; org: string; visa: string; job: string
  rate: number; hourlyRate?: number; otMul: number; hireDate: string; retired?: string; token: string
  salary?: number; memo?: string; grantMonth?: number
  visaExpiry?: string  // 在留期限 YYYY-MM-DD
  dispatchTo?: string  // 出向先名（空なら通常勤務）
  dispatchFrom?: string  // 出向開始月 YYYY-MM（空なら全期間出向扱い）
  useOldRules?: boolean  // 旧ルール（変形労働制以前）給与計算を継続するフラグ（個別対応）
  payrollNo?: string     // キャシュモ管理の従業員番号（提出帳票用・2026-09-17）
  rateFrom?: string      // 現在の rate/jpStep の適用開始日（年次改定の基準日）。types/index.ts 参照
  prevRate?: number      // rateFrom より前の月に使う日額
  prevJpStep?: number
  hourlyRateFrom?: string  // 時給の適用開始日（月途中は暦日按分）。types/index.ts 参照
  prevHourlyRate?: number
  salaryFrom?: string      // 固定月給の適用開始日（月途中は暦日按分）。types/index.ts 参照
  prevSalary?: number
  breakShortenMin?: number   // 休憩短縮に伴う定例の所定外労働（分/日）。詳細は types/index.ts
  breakShortenFrom?: string  // 上記の適用開始月 'YYYYMM'
}

export interface RawSite {
  id: string; name: string; start: string; end: string
  foreman: number; archived: boolean
  /** 通勤時間の測定（手当判定）。types/index.ts の SiteCommuteData と同形 */
  commute?: import('@/types').SiteCommuteData
  /** 運転手当を出さない現場（ごく近い現場など・代表／事業責任者が指定・2026-09-30） */
  noDriveAllowance?: boolean
  tobiRate?: number; dokoRate?: number
  rates?: { from: string; tobiRate: number; dokoRate: number }[]
  /** 現場の入り方。support（応援）は元請けを介さない直接支払いなので単価は100%受取（siteBaseRatio） */
  siteType?: 'direct' | 'support'
  /** 工種サイトの親現場 id と工種名（2026-09-15・lib/site-hierarchy.ts） */
  parentId?: string
  workType?: string
  workSchedule?: {
    startTime?: string; endTime?: string
    morningBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
    lunchBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
    afternoonBreak?: { enabled?: boolean; minutes?: number; mandatory?: boolean }
  }
}

export interface RawSubcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
  /**
   * 応援の請求書（2026-09-25）の宛名用データ。gc/prime/peer の取引先のみ編集画面に表示。
   * 郵便番号・住所・敬称（既定「御中」）・支払条件。未設定の会社は請求書を作れない。
   */
  postal?: string
  address?: string
  honorific?: string
  paymentTerms?: CompanyPaymentTerms
}

export interface PLRecord {
  fy: string | number
  grantDate: string
  grantDays: number
  carryOver: number
  adjustment: number
  used: number
  // Legacy fields from old app
  grant?: number
  carry?: number
  adj?: number
}

/** Convert old billing format (single number) to new format (array) */
export function normalizeBilling(raw: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') {
      result[k] = [v]
    } else if (Array.isArray(v)) {
      result[k] = v as number[]
    }
  }
  return result
}


/** 'YYYYMM' が「前月より前（確定済み扱い）」か。キャッシュ版を使ってよい月の判定 */
export function isClosedMonthYm(ym: string, todayIso?: string): boolean {
  const t = todayIso ? new Date(todayIso + 'T00:00:00') : todayJstDate()
  const prev = new Date(t.getFullYear(), t.getMonth() - 1, 1)
  const prevYm = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`
  return ym < prevYm
}


// ────────────────────────────────────────
//  キー解析（旧アプリのparseDKeyと同等）
//  キー形式: {siteId}_{workerId}_{ym}_{day}
//  siteIdにアンダースコアが含まれる可能性あり（例: yaesu_night）
// ────────────────────────────────────────
export function parseDKey(k: string): { sid: string; wid: string; ym: string; day: string } {
  const p = k.split('_')
  const day = p[p.length - 1]
  const ym = p[p.length - 2]
  const wid = p[p.length - 3]
  const sid = p.slice(0, p.length - 3).join('_')
  return { sid, wid, ym, day }
}

/**
 * 外注の人工（sd）のキー `{siteId}_{外注ID}_{ym}_{day}` を解析する（2026-10-02 点検で追加）。
 *
 * 外注 ID は社名から作るので「_」を含むことがある（例: 鈴高組（とび）= `________99u1`）。
 * parseDKey は後ろから3つ目だけを ID とみなすため、こうした外注の人工が原価・月次集計・請求書の集計から丸ごと抜けていた
 * （2026-06 に笹塚で8日分）。既知の外注 ID と後ろから照合し、一番長く一致したものを採る。見つからなければ parseDKey と同じ。
 */
export function parseSdKey(k: string, subconIds: string[]): { sid: string; wid: string; ym: string; day: string } {
  const p = k.split('_')
  const day = p[p.length - 1]
  const ym = p[p.length - 2]
  const head = p.slice(0, p.length - 2).join('_')   // `${siteId}_${外注ID}`
  let best = ''
  for (const id of subconIds) {
    if (id.length > best.length && head.length > id.length + 1 && head.endsWith(`_${id}`)) best = id
  }
  if (!best) return parseDKey(k)
  return { sid: head.slice(0, head.length - best.length - 1), wid: best, ym, day }
}


// ────────────────────────────────────────
//  帰国中（一時帰国）日数のカウント（2026-07-18 追加）
//  指定ワーカーの homeLongLeave 期間のうち、[rangeStartIso, rangeEndIso]（在籍期間）に
//  重なる暦日数を返す。復帰未定は endDate=番兵('9999-12-31') のため月末まで加算される。
//  期間が重複しても暦日 Set で二重計上を防ぐ。range は在籍1ヶ月以内(≤31日)に限定される。
// ────────────────────────────────────────
export function addOneDayIso(iso: string): string {
  // 引数付き new Date は許可（"今日"の argless new Date は禁止だが本関数は特定日を進めるだけ）
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
export function countHomeLeaveDaysInRange(
  homeLeaves: HomeLeaveEntry[] | undefined,
  workerId: number,
  rangeStartIso: string,
  rangeEndIso: string,
  workedDatesIso?: Set<string>,
  paidLeaveDatesIso?: Set<string>,
): { days: number; earlyReturnDates: string[] } {
  if (!homeLeaves || homeLeaves.length === 0) return { days: 0, earlyReturnDates: [] }
  const days = new Set<string>()
  for (const hl of homeLeaves) {
    if (hl.workerId !== workerId) continue
    if (!hl.startDate || !hl.endDate) continue
    // 在籍期間と帰国期間の重なり（文字列比較。YYYY-MM-DD なので辞書順=日付順）
    const s = hl.startDate > rangeStartIso ? hl.startDate : rangeStartIso
    const e = hl.endDate < rangeEndIso ? hl.endDate : rangeEndIso
    if (s > e) continue
    let cur = s
    let guard = 0
    while (cur <= e && guard < 400) {
      days.add(cur)
      cur = addOneDayIso(cur)
      guard++
    }
  }
  // ⚠️ 2026-08-20 追加（早期復帰対応）: 申請期間内でも **実際に出勤打刻がある日は帰国から外す**。
  //   帰国は「予定より早く帰ってきてそのまま復帰する」ことが実務では普通に起きるが、
  //   申請の endDate は予定のまま残るため、期間だけで数えると働いた日まで帰国扱いになり
  //   基本給の日割りが過少になる（フン(104): 63,888円 の過少支給が実際に発生）。
  //   打刻は本人が入れた事実なので、申請期間より実データを優先する。
  //   日曜は元々打刻が無いので帰国日数に残り、従来の日数計算は変わらない。
  const earlyReturnDates: string[] = []
  if (workedDatesIso && workedDatesIso.size > 0) {
    for (const d of workedDatesIso) {
      if (days.delete(d)) earlyReturnDates.push(d)
    }
    earlyReturnDates.sort()
  }
  // 2026-09-02 追加（帰国期間中の有給を解禁）: 有給を充てた日は帰国日として数えない。
  //   帰国日は「無給・非欠勤」を在籍日数からの除外で表現しているため、有給の日まで
  //   除外すると基本給・所定日数がその日ぶん縮み、**残数だけ減って賃金が出ない**。
  //   有給は賃金が発生する日なので、出勤日と同じく在籍側に残す。
  //   （早期復帰の警告とは意味が違うので earlyReturnDates には入れない）
  if (paidLeaveDatesIso && paidLeaveDatesIso.size > 0) {
    for (const d of paidLeaveDatesIso) days.delete(d)
  }
  return { days: days.size, earlyReturnDates }
}

// ────────────────────────────────────────
//  配置情報取得（旧アプリのgetAssignと同等）
//  massignを最大12ヶ月遡って検索し、見つからなければ
//  グローバルassignにフォールバック
// ────────────────────────────────────────
export function getAssign(
  main: MainData,
  siteId: string,
  ym: string,
): { workers: number[]; subcons: string[]; dispatch: number[] } {
  const mk = `${siteId}_${ym}`
  if (main.massign[mk]) {
    return {
      workers: main.massign[mk].workers || [],
      subcons: main.massign[mk].subcons || [],
      dispatch: main.massign[mk].dispatch || main.assign[siteId]?.dispatch || [],
    }
  }
  let y = parseInt(ym.slice(0, 4))
  let m = parseInt(ym.slice(4, 6))
  for (let i = 0; i < 12; i++) {
    m--
    if (m < 1) { m = 12; y-- }
    const pk = `${siteId}_${ymKey(y, m)}`
    if (main.massign[pk]) {
      return {
        workers: main.massign[pk].workers || [],
        subcons: main.massign[pk].subcons || [],
        dispatch: main.massign[pk].dispatch || main.assign[siteId]?.dispatch || [],
      }
    }
  }
  const a = main.assign[siteId]
  return { workers: a?.workers || [], subcons: a?.subcons || [], dispatch: a?.dispatch || [] }
}

// 指定YM時点でワーカーが出向中かを判定
//   - dispatchTo が空 → 出向していない
//   - dispatchFrom が空 → 全期間出向扱い（後方互換）
//   - dispatchFrom が設定済み → ym >= dispatchFrom のときのみ出向扱い
// ym は YYYYMM 形式、dispatchFrom は YYYY-MM 形式
/**
 * スタッフ1人の日額換算単価を取得（2026-06-XX 新設・C1 修正）
 *
 * 旧バグ: 月給制日本人 (rate=0, salary>0) でサイト原価が w.rate=0 で
 *   ゼロ計上される問題（compute.ts:461 と 913）
 *
 * 統一ロジック:
 *   - 月給制日本人 (visa==='none' && salary>0): salary / 20 (月所定日数前提)
 *   - 外国人・時給制 (visa!=='none' && hourlyRate>0): 時給 × 7（常に時給から導出）
 *   - その他: w.rate
 *
 * ★ 2026-07 修正: 外国人の日額は保存済み rate ではなく「時給×7」で都度算出する。
 *   旧: w.rate を使用 → 昇給で時給を上げても rate が追随せず、原価が古い単価で過小計上
 *       （監査で外国人13名中11名の日額ドリフトを検出）。時給から算出すればドリフト不能。
 *
 * 注: ベース20日固定は概算用。中途入退社按分は computeMonthly() 側で対応済み。
 *     より精密な日割りが必要な場合は呼出側で workerPrescribedDays を考慮する。
 */
export function getWorkerDailyRate(w: { visa?: string; rate?: number; salary?: number; hourlyRate?: number }): number {
  if (w.visa === 'none' && w.salary && w.salary > 0) {
    return w.salary / 20
  }
  if (w.visa && w.visa !== 'none' && w.hourlyRate && w.hourlyRate > 0) {
    return w.hourlyRate * 7
  }
  return w.rate || 0
}

export function isDispatchedAt(w: RawWorker | undefined, ym: string): boolean {
  if (!w?.dispatchTo) return false
  if (!w.dispatchFrom) return true
  const fromYm = w.dispatchFrom.replace(/-/g, '')  // YYYY-MM → YYYYMM
  return ym >= fromYm
}

// 出向判定: 指定社員が指定現場・指定YMで出向扱いかチェック
//   1) ワーカー自身の dispatchTo（開始月以降）→ 全現場で出向扱い
//   2) 現場ごとの dispatch 配列に含まれていれば出向扱い
export function isDispatched(main: MainData, workerId: number, siteId: string, ym: string): boolean {
  return createDispatchChecker(main)(workerId, siteId, ym)
}

/**
 * 「出向者か」の判定をまとめて行う関数を返す（2026-10-02 総合点検）。
 *
 * 決まりは isDispatched と同じ（人ごとの dispatchTo ＝開始月以降は全現場で出向 ／ 現場ごとの dispatch 配列）。
 * 出面を1件ずつ回す集計（compute・calcTobiEquiv・computeMonthly）から使うので、
 * 現場×月の配置（getAssign は最大12か月さかのぼる）と人の検索を覚えておく。
 *
 * 旧: 原価側（compute・computeMonthly）は人ごとの dispatchTo だけ、売上側（calcTobiEquiv の鳶換算人工）は
 *   現場ごとの dispatch 配列だけを見ていた。片方にしか登録が無い人は、原価からは引かれるのに
 *   売上の概算（鳶換算人工）には数えられる（またはその逆）ので、現場の粗利が実際より良く（悪く）出ていた。
 */
export function createDispatchChecker(main: MainData): (workerId: number, siteId: string, ym: string) => boolean {
  const workerById = new Map(main.workers.map(w => [w.id, w]))
  const listCache = new Map<string, number[]>()
  return (workerId, siteId, ym) => {
    if (isDispatchedAt(workerById.get(workerId), ym)) return true
    const ck = `${siteId}_${ym}`
    let list = listCache.get(ck)
    if (!list) { list = getAssign(main, siteId, ym).dispatch; listCache.set(ck, list) }
    return list.includes(workerId)
  }
}

// ────────────────────────────────────────
//  外注の現場別単価取得（旧アプリのgetSubconRateと同等）
// ────────────────────────────────────────
export function getSubconRate(
  main: MainData,
  scid: string,
  siteId?: string,
  ym?: string,
): { rate: number; otRate: number } {
  const sc = main.subcons.find(x => x.id === scid)
  const base = { rate: sc ? sc.rate : 0, otRate: sc ? sc.otRate : 0 }
  if (!siteId) return base
  // 2026-06-XX 修正 (I7): 月別 overrides (massign[siteId_ym].subconRates) を優先参照
  //   旧: main.assign[siteId].subconRates のみ参照 → 月別単価変更を反映できない
  //   新: massign を優先、なければ assign にフォールバック
  let ov: { rate?: number; otRate?: number } | undefined
  if (ym) {
    const massignKey = `${siteId}_${ym}`
    const mAssign = (main as { massign?: Record<string, { subconRates?: Record<string, { rate?: number; otRate?: number }> }> }).massign?.[massignKey]
    if (mAssign?.subconRates?.[scid]) ov = mAssign.subconRates[scid]
  }
  if (!ov) {
    const a = main.assign[siteId]
    if (a?.subconRates?.[scid]) ov = a.subconRates[scid]
  }
  if (!ov) return base
  const r = ov.rate || base.rate
  const o = ov.otRate || (r ? Math.round(r / 8 * 1.25) : base.otRate)
  return { rate: r, otRate: o }
}

// ────────────────────────────────────────
//  現場の常用単価・受取単価（85% or 100%）・換算係数取得
//  （旧アプリのgetSiteRatesと同等）
// ────────────────────────────────────────

/**
 * 元請け（山岡）経由の現場で当社が実際に受け取る割合。常用単価 36,000 → 受取 30,600。
 * 直（direct）現場はこの係数、応援（support）現場は元請けを介さず直接支払いなので 1.0。
 */
export const INTERMEDIARY_BASE_RATIO = 0.85

/**
 * 現場の「受取割合」（2026-09-11 追加）。
 * - direct / 未設定 … 0.85（常用単価の85%が当社受取）
 * - support（応援） … 1.0（入力した単価がそのまま受取額。例: 28,000・30,000）
 * 現場マスタの単価表示・原価収益の請求単価基準・概算売上の単価は全てこれを通す。
 */
export function siteBaseRatio(site?: { siteType?: string } | null): number {
  return site?.siteType === 'support' ? 1 : INTERMEDIARY_BASE_RATIO
}

export function getSiteRates(
  main: MainData,
  siteId?: string,
  ym?: string,
): { tobiRate: number; dokoRate: number; tobiBase: number; dokoBase: number; dokoRatio: number; baseRatio: number } {
  const defTobi = main.defaultRates.tobiRate || 36000
  const defDoko = main.defaultRates.dokoRate || 28000
  const s = siteId ? main.sites.find(x => x.id === siteId) : undefined
  const ratio = siteBaseRatio(s)
  const defTobiBase = Math.round(defTobi * ratio)
  const defDokoRatio = defTobiBase > 0 ? Math.round(defDoko * ratio) / defTobiBase : 0.778

  if (!siteId || !s || !s.rates || s.rates.length === 0) {
    return {
      tobiRate: defTobi, dokoRate: defDoko,
      tobiBase: defTobiBase, dokoBase: Math.round(defDoko * ratio),
      dokoRatio: defDokoRatio, baseRatio: ratio,
    }
  }

  // 期間別: from が <= ym の最後のエントリ
  // 2026-09-15 修正: 現場マスタの単価タブは期間開始を 'YYYY-MM-DD'（日付入力）で保存するが、
  //   旧データは 'YYYYMM'。文字列のまま 'YYYYMM' と比べると '-' が数字より小さいため
  //   「2026-10-01 開始」が 9月分にも当たっていた。月（YYYYMM）に正規化し、開始順に並べてから選ぶ
  const monthOf = (f: unknown) => String(f ?? '').replace(/-/g, '').slice(0, 6)
  const periods = [...s.rates].sort((p, q) => monthOf(p.from).localeCompare(monthOf(q.from)))
  let ap = periods[0]
  if (ym) {
    const ymN = ym.replace(/-/g, '').slice(0, 6)
    for (const r of periods) {
      if (monthOf(r.from) <= ymN) ap = r; else break
    }
  } else {
    ap = periods[periods.length - 1]
  }

  const tr = ap.tobiRate || defTobi
  const dr = ap.dokoRate || defDoko
  const tb = Math.round(tr * ratio)
  const db = Math.round(dr * ratio)
  return {
    tobiRate: tr, dokoRate: dr, tobiBase: tb, dokoBase: db,
    dokoRatio: tb > 0 ? db / tb : defDokoRatio, baseRatio: ratio,
  }
}

// ────────────────────────────────────────
//  鳶換算人工の計算（旧アプリのcalcTobiEquivと同等）
// ────────────────────────────────────────
export function calcTobiEquiv(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ymList: { y: number; m: number }[],
  siteId?: string,
): { tobiWork: number; dokoWork: number; tobiOtEq: number; dokoOtEq: number; equiv: number; tobiBase: number } {
  let tobiWork = 0, dokoWork = 0, tobiOtEq = 0, dokoOtEq = 0
  const ymSet = new Set(ymList.map(x => ymKey(x.y, x.m)))

  // 月別に集計（期間別レート適用のため）
  const monthly: Record<string, { tw: number; dw: number; toe: number; doe: number }> = {}

  // 出向者の判定は isDispatched と同じ決まり（人ごとの dispatchTo ＋ 現場ごとの dispatch 配列）。
  //   2026-10-02 総合点検: 旧はここだけ現場ごとの配列しか見ておらず、人ごとに出向を登録した人が
  //   原価からは引かれるのに鳶換算人工（売上の概算）には数えられていた
  const isDispatchedHere = createDispatchChecker(main)

  // 個人
  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    if (!ymSet.has(pk.ym)) continue
    if (siteId && pk.sid !== siteId) continue
    if (v.p || !v.w) continue
    // ⚠️ 2026-05-09: 残骸データ対策（休み/現場休/帰国中/試験 を鳶換算から除外）
    if ((v.r ?? 0) > 0 || (v.h ?? 0) > 0 || (v.hk ?? 0) > 0 || ((v as { exam?: number }).exam ?? 0) > 0) continue
    const w = main.workers.find(x => x.id === parseInt(pk.wid))
    if (!w) continue
    // 出向者: 鳶換算人工から除外
    if (isDispatchedHere(w.id, pk.sid, pk.ym)) continue
    // 休業補償(0.6): 外国人の会社都合休業 → 鳶換算から除外
    const isComp = (v.w === 0.6 && w.visa !== 'none')
    if (isComp) continue
    const stdH = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h（変形労働時間制）
    // 残業h は時刻から数え直す（応援の請求書の出面明細 buildSiteDetail と同じ・calcOvertimeHours が唯一の決まり）
    const oe = calcOvertimeHours(v, main.sites.find(s => s.id === pk.sid)?.workSchedule as SiteWorkSchedule | undefined) / stdH
    if (!monthly[pk.ym]) monthly[pk.ym] = { tw: 0, dw: 0, toe: 0, doe: 0 }
    // 2026-06-XX 修正 (C6): 単一の真理ソース isTobiGroup/isDokoGroup を使用
    //   旧: doko 以外は全部鳶側 → 事務(jimu)等も鳶換算に混入
    //   新: isTobiGroup (tobi/tobi_apprentice/shokucho/yakuin) と isDokoGroup のみ集計
    //       その他 (jimu 等) は除外
    // 2026-08: 人工ベース。夜勤日は 1.5人工（日勤＋夜勤なら 2.5人工）で元請けに請求するため
    //   鳶換算人工にも同じ人工を用いる。上で p/r/h/hk/exam と補償日は除外済みなので、
    //   夜勤が無ければ calcManDays(v) === v.w となり従来と同値。
    const md = calcManDays(v)
    if (isDokoGroup(w.job)) {
      monthly[pk.ym].dw += md; monthly[pk.ym].doe += oe; dokoWork += md; dokoOtEq += oe
    } else if (isTobiGroup(w.job)) {
      monthly[pk.ym].tw += md; monthly[pk.ym].toe += oe; tobiWork += md; tobiOtEq += oe
    }
    // 上記以外 (jimu 等) は鳶換算対象外
  }

  // 外注
  for (const [k, v] of Object.entries(attSD)) {
    if (!v) continue
    const pk = parseSdKey(k, main.subcons.map(x => x.id))   // 外注IDの「_」に対応（2026-10-02）
    if (!ymSet.has(pk.ym)) continue
    if (siteId && pk.sid !== siteId) continue
    const sc = main.subcons.find(x => x.id === pk.wid)
    if (!sc) continue
    const soe = v.on / 8 // 外注は8h換算
    if (!monthly[pk.ym]) monthly[pk.ym] = { tw: 0, dw: 0, toe: 0, doe: 0 }
    if (sc.type === '土工業者') {
      monthly[pk.ym].dw += v.n; monthly[pk.ym].doe += soe; dokoWork += v.n; dokoOtEq += soe
    } else {
      monthly[pk.ym].tw += v.n; monthly[pk.ym].toe += soe; tobiWork += v.n; tobiOtEq += soe
    }
  }

  // 月ごとにdokoRatioを取得して換算人工を合算
  let equiv = 0
  for (const [ym, md] of Object.entries(monthly)) {
    const rates = siteId ? getSiteRates(main, siteId, ym) : getSiteRates(main)
    equiv += (md.tw + md.toe) + (md.dw + md.doe) * rates.dokoRatio
  }

  // tobiBaseは最新レートから取得（KPI基準線用）
  const latestRates = siteId ? getSiteRates(main, siteId) : getSiteRates(main)
  const tobiBase = latestRates.tobiBase

  return { tobiWork, dokoWork, tobiOtEq, dokoOtEq, equiv, tobiBase }
}

// ────────────────────────────────────────
//  メイン集計エンジン（旧アプリのcompute()と同等）
//  ★ ダッシュボード・原価・月次集計の全ページで共用
// ────────────────────────────────────────

export interface ComputeResult {
  sites: Record<string, { work: number; ot: number; otEq: number; cost: number; subWork: number; subOT: number; subOtEq: number; subCost: number; dispatchDeduction: number }>
  daily: Record<string, number>  // key: ym_day
  dailySite: Record<string, number>  // key: ym_day_siteId
  monthly: Record<string, number>  // key: ym
  workers: Record<number, { work: number; ot: number; cost: number; plUsed: number; compDays: number; sites: string[]; isDispatched?: boolean; dispatchTo?: string; dispatchDeduction?: number }>
  subcons: Record<string, { work: number; ot: number; cost: number; sites: string[] }>
  siteWorkers: Record<string, { work: number; ot: number; cost: number; plUsed: number }>
  siteSubcons: Record<string, { work: number; ot: number; cost: number }>
  totalWork: number
  totalOT: number
  totalOtEq: number
  totalCost: number
  totalSubWork: number
  totalSubOT: number
  totalSubOtEq: number
  totalSubCost: number
  totalDispatchDeduction: number
}

export function compute(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ymList?: { y: number; m: number }[],
): ComputeResult {
  const ymSet = ymList ? new Set(ymList.map(x => ymKey(x.y, x.m))) : null
  const result: ComputeResult = {
    sites: {},
    daily: {}, dailySite: {}, monthly: {},
    workers: {}, subcons: {}, siteWorkers: {}, siteSubcons: {},
    totalWork: 0, totalOT: 0, totalOtEq: 0, totalCost: 0,
    totalSubWork: 0, totalSubOT: 0, totalSubOtEq: 0, totalSubCost: 0,
    totalDispatchDeduction: 0,
  }

  // サイトの初期化
  main.sites.forEach(s => {
    result.sites[s.id] = { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0, dispatchDeduction: 0 }
  })

  // ─── 個人の出面データ処理 ───
  // 同日複数現場の有給(p)を1日として数えるための dedup（computeMonthly の _plDaySeen と同扱い）
  const plDaySeenCompute = new Set<string>()
  // 出向者の判定（人ごとの dispatchTo ＋ 現場ごとの dispatch 配列・calcTobiEquiv と同じ決まり。2026-10-02 総合点検）
  const isDispatchedHere = createDispatchChecker(main)
  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    const sid = pk.sid
    const wid = parseInt(pk.wid)
    const entryYm = pk.ym
    const dayS = pk.day

    if (ymSet && !ymSet.has(entryYm)) continue
    const w = main.workers.find(x => x.id === wid)
    if (!w) continue
    // 2026-06-XX 修正 (C2): 退職済みワーカーは原価集計から除外
    //   旧: 退職済みでも出面残骸が残っていれば原価計上 → 過去月の数字が変動
    //   新: computeMonthly() と同じく isStillActiveForMonth でガード
    if (!isStillActiveForMonth(w.retired, entryYm)) continue
    if (!isHiredByMonth(w.hireDate, entryYm)) continue  // 入社前の月は対象外

    const swk = `${sid}_${w.id}`

    // この社員がこの現場・この月に出向扱いか（人ごとの dispatchTo は dispatchFrom 以降だけ／現場ごとの dispatch 配列）
    //   2026-10-02 総合点検: 旧は人ごとの dispatchTo だけ。現場の dispatch 配列にだけ入っている人は
    //   鳶換算人工（売上側）からは除かれるのに、原価からは引かれなかった
    const dispatchedThisYm = isDispatchedHere(w.id, sid, entryYm)

    // 有給: 人工としてはカウントしないがworker集計に有給日数を記録
    if (v.p) {
      if (!result.workers[w.id]) {
        result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [], isDispatched: dispatchedThisYm, dispatchTo: w.dispatchTo || '', dispatchDeduction: 0 }
      } else if (dispatchedThisYm && !result.workers[w.id].isDispatched) {
        result.workers[w.id].isDispatched = true
      }
      // 2026-08-27 横展開: 同日複数現場の p は1日（現状この plUsed を読む画面は
      //   無いが、配線された時に2倍カウントになる地雷を除去）
      const plDayKey = `${w.id}_${entryYm}_${dayS}`
      if (!plDaySeenCompute.has(plDayKey)) {
        plDaySeenCompute.add(plDayKey)
        result.workers[w.id].plUsed = (result.workers[w.id].plUsed || 0) + 1
      }
      if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
      if (!result.siteWorkers[swk]) result.siteWorkers[swk] = { work: 0, ot: 0, cost: 0, plUsed: 0 }
      result.siteWorkers[swk].plUsed = (result.siteWorkers[swk].plUsed || 0) + 1
      continue  // ★ 有給は人工にカウントしない → 即continue
    }

    // 試験: 人工にも原価にもカウントしない（compute() レベルでは無視）。
    //   給与計算上の扱い (欠勤控除から除外) は computeMonthly() の examDays で別途処理
    if (v.exam) continue

    // ⚠️ 2026-05-09: 残骸データ対策
    //   {w:1, r:1, o:5} のような残骸（出勤入力後に「休み」へ変更したが o/w が残っている）
    //   を「出勤」としてカウントしないよう、r/h/hk フラグを早期除外する。
    //   p/exam は上で個別処理済み。w==0 も下の `if (!v.w)` で除外される。
    if ((v.r ?? 0) > 0 || (v.h ?? 0) > 0 || (v.hk ?? 0) > 0) continue

    // 2026-08-27 修正（給与総点検）: 夜勤対応。
    //   夜勤のみ(ns, w=0)の日は旧 `if (!v.w) continue` で原価・人工とも0になり、
    //   日勤+夜勤の日も 1.5人工の加算分が欠落していた（computeMonthly は対応済みで
    //   ダッシュボード/原価管理だけズレる）。人工は calcManDays で統一する
    const hasNight = !!(v as { ns?: number }).ns
    if (!v.w && !hasNight) continue

    // 休業補償(0.6): 外国人の会社都合休業 → 原価のみ計上、人工数には含めない
    const isComp = (v.w === 0.6 && w.visa !== 'none')
    const otDivisor = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    // 2026-06-XX 修正 (C1): 月給制日本人 (rate=0, salary>0) のサイト原価ゼロ問題
    //   旧: w.rate を直接使用 → rate=0 だとサイト原価=0 で過小計上
    //   新: getWorkerDailyRate() で月給制も日額換算（salary/20）
    const dailyRate = getWorkerDailyRate(w)
    const otCost = (v.o || 0) * (dailyRate / otDivisor) * w.otMul
    const manDays = isComp ? v.w : calcManDays(v)  // 夜勤1.5人工を含む人工数
    const cost = (isComp ? v.w : manDays) * dailyRate + otCost
    const workCount = isComp ? 0 : manDays  // 休業補償は人工0
    const stdH = w.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h（変形労働時間制）
    const oe = isComp ? 0 : (v.o || 0) / stdH  // 残業→人工換算

    result.totalWork += workCount
    result.totalOT += (isComp ? 0 : (v.o || 0))
    result.totalOtEq += oe
    result.totalCost += cost

    if (result.sites[sid]) {
      result.sites[sid].work += workCount
      result.sites[sid].ot += (isComp ? 0 : (v.o || 0))
      result.sites[sid].otEq += oe
      result.sites[sid].cost += cost
    }

    const day = parseInt(dayS)
    const dailyKey = `${entryYm}_${day}`
    result.daily[dailyKey] = (result.daily[dailyKey] || 0) + workCount
    const dsKey = `${dailyKey}_${sid}`
    result.dailySite[dsKey] = (result.dailySite[dsKey] || 0) + workCount
    result.monthly[entryYm] = (result.monthly[entryYm] || 0) + workCount

    if (!result.workers[w.id]) {
      result.workers[w.id] = { work: 0, ot: 0, cost: 0, plUsed: 0, compDays: 0, sites: [], isDispatched: dispatchedThisYm, dispatchTo: w.dispatchTo || '', dispatchDeduction: 0 }
    } else if (dispatchedThisYm && !result.workers[w.id].isDispatched) {
      result.workers[w.id].isDispatched = true
    }
    result.workers[w.id].work += workCount
    result.workers[w.id].ot += (isComp ? 0 : (v.o || 0))
    result.workers[w.id].cost += cost
    if (!result.workers[w.id].sites.includes(sid)) result.workers[w.id].sites.push(sid)
    if (isComp) result.workers[w.id].compDays = (result.workers[w.id].compDays || 0) + 1

    // 出向者: 控除額をワーカー・サイト・全体で集計（dispatchFrom 以降のみ）
    if (dispatchedThisYm) {
      result.workers[w.id].dispatchDeduction = (result.workers[w.id].dispatchDeduction || 0) + cost
      if (result.sites[sid]) result.sites[sid].dispatchDeduction += cost
      result.totalDispatchDeduction += cost
    }

    // 現場×個人
    if (!result.siteWorkers[swk]) result.siteWorkers[swk] = { work: 0, ot: 0, cost: 0, plUsed: 0 }
    result.siteWorkers[swk].work += workCount
    result.siteWorkers[swk].ot += (isComp ? 0 : (v.o || 0))
    result.siteWorkers[swk].cost += cost
  }

  // ─── 外注の出面データ処理 ───
  for (const [k, v] of Object.entries(attSD)) {
    if (!v) continue
    const pk = parseSdKey(k, main.subcons.map(x => x.id))   // 外注IDの「_」に対応（2026-10-02）
    const sid = pk.sid
    const scid = pk.wid
    const entryYm = pk.ym
    const dayS = pk.day

    if (ymSet && !ymSet.has(entryYm)) continue
    const sc = main.subcons.find(x => x.id === scid)
    if (!sc) continue

    // ★ 現場別単価を使用（旧アプリのgetSubconRateと同等）
    // 2026-06-XX 修正 (I7): 月別単価 (massign) を優先するため entryYm を渡す
    const scR = getSubconRate(main, scid, sid, entryYm)
    const cost = v.n * scR.rate + v.on * scR.otRate
    const soe = v.on / 8  // 外注は8h換算

    result.totalSubWork += v.n
    result.totalSubOT += v.on
    result.totalSubOtEq += soe
    result.totalSubCost += cost

    if (result.sites[sid]) {
      result.sites[sid].subWork += v.n
      result.sites[sid].subOT += v.on
      result.sites[sid].subOtEq += soe
      result.sites[sid].subCost += cost
    }

    const day = parseInt(dayS)
    const dailyKey = `${entryYm}_${day}`
    result.daily[dailyKey] = (result.daily[dailyKey] || 0) + v.n
    const dsKey = `${dailyKey}_${sid}`
    result.dailySite[dsKey] = (result.dailySite[dsKey] || 0) + v.n
    result.monthly[entryYm] = (result.monthly[entryYm] || 0) + v.n

    if (!result.subcons[scid]) result.subcons[scid] = { work: 0, ot: 0, cost: 0, sites: [] }
    result.subcons[scid].work += v.n
    result.subcons[scid].ot += v.on
    result.subcons[scid].cost += cost
    if (!result.subcons[scid].sites.includes(sid)) result.subcons[scid].sites.push(sid)

    // 現場×外注
    const ssk = `${sid}_${scid}`
    if (!result.siteSubcons[ssk]) result.siteSubcons[ssk] = { work: 0, ot: 0, cost: 0 }
    result.siteSubcons[ssk].work += v.n
    result.siteSubcons[ssk].ot += v.on
    result.siteSubcons[ssk].cost += cost
  }

  return result
}

// ────────────────────────────────────────
//  請求額合計取得
// ────────────────────────────────────────
export function getBillTotal(main: MainData, siteId: string, ym: string): number {
  const arr = main.billing[`${siteId}_${ym}`]
  return arr ? arr.reduce((s, v) => s + (v || 0), 0) : 0
}

// ────────────────────────────────────────
//  出面概算：過去N月の確定請求から1鳶換算人工あたり売上平均を算出
//  （旧アプリのgetAvgRevenuePerEquivと同等）
// ────────────────────────────────────────
export function getAvgRevenuePerEquiv(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  baseYM: string,
  siteId?: string,
  months: number = 3,
): number | null {
  let sumBilling = 0
  let sumEquiv = 0
  let hasData = false

  let y = parseInt(baseYM.slice(0, 4))
  let m = parseInt(baseYM.slice(4, 6))

  for (let i = 0; i < months; i++) {
    m--
    if (m < 1) { m = 12; y-- }
    const mStr = ymKey(y, m)

    // Check billing for this month
    let mBill = 0
    if (siteId) {
      mBill = getBillTotal(main, siteId, mStr)
    } else {
      for (const site of main.sites) {
        mBill += getBillTotal(main, site.id, mStr)
      }
    }
    if (mBill <= 0) continue

    // Calculate tobiEquiv for this month
    const mTobiEq = calcTobiEquiv(main, attD, attSD, [{ y, m }], siteId)
    if (mTobiEq.equiv <= 0) continue

    sumBilling += mBill
    sumEquiv += mTobiEq.equiv
    hasData = true
  }

  if (!hasData || sumEquiv <= 0) return null
  return sumBilling / sumEquiv
}

// ────────────────────────────────────────
//  期間管理（旧アプリのbuildYMList/stepPeriod/buildPeriodLabelと同等）
// ────────────────────────────────────────

export function getFiscalYear(y: number, m: number): number {
  return m >= 10 ? y : y - 1
}

export function buildYMList(mode: string, y: number, m: number): { y: number; m: number }[] {
  const list: { y: number; m: number }[] = []
  if (mode === 'month') {
    list.push({ y, m })
  } else if (mode === 'fy') {
    const fy = getFiscalYear(y, m)
    const nowYM = currentYmJst()
    for (let i = 0; i < 12; i++) {
      const mm = ((10 - 1 + i) % 12) + 1
      const yy = mm >= 10 ? fy : fy + 1
      list.push({ y: yy, m: mm })
      if (ymKey(yy, mm) > nowYM) break
    }
  } else {
    const n = mode === '3m' ? 3 : mode === '6m' ? 6 : 12
    let ty = y, tm = m
    for (let i = 0; i < n; i++) {
      list.unshift({ y: ty, m: tm })
      tm--
      if (tm < 1) { tm = 12; ty-- }
    }
  }
  return list
}

// ────────────────────────────────────────
//  ヘルパー
// ────────────────────────────────────────

export function isLocked(locks: Record<string, boolean>, ym: string): boolean {
  return !!locks[ym]
}

export function getYmOptions(count: number = 6): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = todayJstDate()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    result.push({ ym: ymKey(y, m), label: `${y}年${m}月` })
  }
  return result
}
