/**
 * MF経費の申請の事前チェックの決まり（docs/mf-expense-check.md・2026-11-08〜）。
 *
 * ここは純粋な計算だけ（Firestore も MF の API も触らない）。画面からも import する。
 * 個人のデータはここに書かない（CLAUDE.md「個人の金額を画面の JS に書かない」）。
 * MF とのやり取りと保存は lib/mf-expense-client.server.ts / lib/mf-expense-run.server.ts。
 *
 * 第1段階は「見るだけ」。ここで出した指摘を一覧に出すだけで、MF の申請には何も書かない。
 */

// ────────────────────────────────────────
//  科目の種類と設定
// ────────────────────────────────────────

export type MfItemKind = 'transit' | 'gas' | 'tool' | 'noReceipt' | 'other'

export const MF_ITEM_KIND_LABEL: Record<MfItemKind, string> = {
  transit: '交通費（領収書は不要）',
  gas: 'ガソリン代',
  tool: '道具代',
  noReceipt: 'その他（領収書は不要）',
  other: 'その他（領収書が必要）',
}

export const MF_ITEM_KINDS = Object.keys(MF_ITEM_KIND_LABEL) as MfItemKind[]

/** どの会社の MF か。日比建設は全員、HFU は技能実習生だけ（2026-11-09 代表） */
export type MfOrg = 'hibi' | 'hfu'
export const MF_ORG_LABEL: Record<MfOrg, string> = { hibi: '日比建設', hfu: 'HFU' }
/** HFU はこの月の分から見る（2026-11-09 代表） */
export const MF_HFU_FROM_YM = '202611'

export interface MfExpenseSettings {
  /** HFU の技能実習生もチェックするか。科目と結びつけの準備ができてから入れる */
  hfuEnabled: boolean
  /** MF の経費科目 ID → 種類。未設定の科目は科目で決まるチェックをしない（誤った指摘を出さない） */
  itemKinds: Record<string, MfItemKind>
  /** T3・T4 の「いつもと大きく違う」の幅（%） */
  amountPct: number
  /** T5 で見逃す差（円）。曜日やルートで変わる小さな差は出さない（2026-11-09 代表） */
  siteTransitMargin: number
  /** T6 で見逃す差（円）。既定は 0＝小さな差も拾って訂正してもらう（2026-11-09 代表） */
  routeMargin: number
  /** M1（出し忘れの声かけ）を出し始める日 */
  m1Day: number
  /** M2（締め切り後）を出し始める日 */
  m2Day: number
  transitWords: string[]
  gasWords: string[]
  splitWords: string[]
}

export const DEFAULT_MF_EXPENSE_SETTINGS: MfExpenseSettings = {
  hfuEnabled: false,
  itemKinds: {},
  amountPct: 30,
  siteTransitMargin: 300,
  routeMargin: 0,
  m1Day: 8,
  m2Day: 11,
  transitWords: ['電車', 'バス', '地下鉄', '新幹線', 'JR', 'メトロ'],
  gasWords: ['ガソリン', '給油', '軽油', 'レギュラー', 'ハイオク'],
  splitWords: ['折半', '半額'],
}

/** 保存値を、欠けている項目は既定値で埋めて返す（古い保存値でも動くように） */
export function normalizeMfExpenseSettings(raw: Partial<MfExpenseSettings> | null | undefined): MfExpenseSettings {
  const d = DEFAULT_MF_EXPENSE_SETTINGS
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const words = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : fallback)
  return {
    hfuEnabled: raw?.hfuEnabled === true,
    itemKinds: raw?.itemKinds || {},
    amountPct: num(raw?.amountPct, d.amountPct),
    siteTransitMargin: num(raw?.siteTransitMargin, d.siteTransitMargin),
    routeMargin: num(raw?.routeMargin, d.routeMargin),
    m1Day: num(raw?.m1Day, d.m1Day),
    m2Day: num(raw?.m2Day, d.m2Day),
    transitWords: words(raw?.transitWords, d.transitWords),
    gasWords: words(raw?.gasWords, d.gasWords),
    splitWords: words(raw?.splitWords, d.splitWords),
  }
}

/** 設定の入力の不備（無ければ null）。画面とサーバーの両方で同じ判定を使う */
export function mfExpenseSettingsError(s: MfExpenseSettings): string | null {
  if (!Number.isInteger(s.amountPct) || s.amountPct < 1 || s.amountPct > 100) return '「大きく違う」の幅は 1〜100 の整数で入れてください'
  if (!Number.isInteger(s.siteTransitMargin) || s.siteTransitMargin < 0 || s.siteTransitMargin > 10000) return '同じ現場の交通費で見逃す差は 0〜10000 の整数で入れてください'
  if (!Number.isInteger(s.routeMargin) || s.routeMargin < 0 || s.routeMargin > 10000) return '同じ区間の最安で見逃す差は 0〜10000 の整数で入れてください'
  if (!Number.isInteger(s.m1Day) || s.m1Day < 1 || s.m1Day > 28) return '出し忘れの声かけの日は 1〜28 で入れてください'
  if (!Number.isInteger(s.m2Day) || s.m2Day < 1 || s.m2Day > 28) return '締め切り後の確認の日は 1〜28 で入れてください'
  if (s.m1Day >= s.m2Day) return '出し忘れの声かけの日は、締め切り後の確認の日より前にしてください'
  for (const v of Object.values(s.itemKinds)) {
    if (!MF_ITEM_KINDS.includes(v)) return '科目の種類が正しくありません'
  }
  return null
}

// ────────────────────────────────────────
//  指摘
// ────────────────────────────────────────

export type MfRuleId = 'U1' | 'U2' | 'K2' | 'X1' | 'T1' | 'T3' | 'T5' | 'T6' | 'T4' | 'D1' | 'D2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'K1' | 'G1' | 'G2' | 'G3' | 'M1' | 'M2'

/** confirm = 要確認（総務が見る）／ info = 参考（一覧に出すだけ） */
export type MfFlagLevel = 'confirm' | 'info'

/** MF の承認の段階（誰が何番目で、今どこで止まっているか）。従業員の情報は名前だけ持つ */
export interface MfApprovalStep {
  step: number
  name: string
  approvedAt: string | null
  active: boolean
}

export interface MfRawApproval {
  step?: number | null
  is_active?: boolean | null
  approved_at?: string | null
  approve_office_member?: { name?: string | null } | null
}

export function summarizeMfApprovals(raw: MfRawApproval[] | null | undefined): MfApprovalStep[] {
  return (raw || [])
    .map(a => ({
      step: Number(a.step) || 0,
      name: (a.approve_office_member?.name || '').slice(0, 60),
      approvedAt: a.approved_at || null,
      active: a.is_active === true,
    }))
    .sort((a, b) => a.step - b.step)
}

const MF_WAITING_STEP: Record<string, number> = {
  waiting_step_one: 1, waiting_step_two: 2, waiting_step_three: 3, waiting_step_four: 4, waiting_step_five: 5,
}

/** 「今だれの承認待ちか」。名前が取れなければ MF の状態から「第N承認待ち」にする */
export function mfApprovalWaitingLabel(status: string, approvals: MfApprovalStep[] | undefined): string {
  const names = (approvals || []).filter(a => a.active && a.name).map(a => a.name)
  if (names.length > 0) return `${names.join('・')} さんの承認待ち`
  const n = MF_WAITING_STEP[status]
  return n ? `第${n}承認待ち` : ''
}

/** 要確認の申請に総務が残す1行（「確認した・理由」）。MF には書かない（2026-11-09） */
export interface MfExpenseReview {
  /** 確認したときの要確認の指摘（mfFlagKey）。これより増えたら要確認に戻す */
  flagKeys?: string[]
  note: string
  byName: string
  at: string
}

export const MF_REVIEW_NOTE_MAX = 200

/** 指摘の見分け。確認したときの指摘と今の指摘を比べる */
export const mfFlagKey = (f: Pick<MfExpenseFlag, 'rule' | 'txId'>): string => `${f.rule}:${f.txId || ''}`

export const mfConfirmFlagKeys = (flags: MfExpenseFlag[]): string[] =>
  Array.from(new Set(flags.filter(f => f.level === 'confirm').map(mfFlagKey)))

/**
 * 確認メモが今の指摘をすべて見たものか。確認のあとに増えた指摘（領収書を遅れて読んだ・別の申請が来た・出面を直した）を
 * 「確認済み」の中に隠さない（2026-11-09 総点検）。flagKeys の無い古いメモは、すべて見たものとして扱う
 */
export function mfReviewIsCurrent(review: MfExpenseReview | undefined, flags: MfExpenseFlag[]): boolean {
  if (!review) return false
  if (!review.flagKeys) return true
  const seen = new Set(review.flagKeys)
  return mfConfirmFlagKeys(flags).every(k => seen.has(k))
}

export type MfCheckState = 'confirm' | 'reviewed' | 'receipt' | 'clean'

/** 一覧の札。領収書をまだ読めていない申請は「問題なし」と言えないので、チェック済みと分ける（2026-11-09 総点検） */
export function mfCheckState(c: { confirmCount: number; review?: MfExpenseReview; flags: MfExpenseFlag[]; receiptPending?: number }): MfCheckState {
  if (c.confirmCount > 0) return mfReviewIsCurrent(c.review, c.flags) ? 'reviewed' : 'confirm'
  if ((c.receiptPending || 0) > 0 || c.flags.some(f => f.rule === 'R4')) return 'receipt'
  return 'clean'
}

/** 読み取り結果が今の添付のものか（差し替えられていたら読み直すまで使わない） */
export function mfIsReceiptReadCurrent(tx: Pick<MfExpenseTx, 'fileId'>, read: Pick<MfReceiptRead, 'fileId'> | undefined): boolean {
  return !!read && !(tx.fileId && read.fileId && tx.fileId !== read.fileId)
}

/** これ以下の金額は駐輪場代の可能性を見る（実データの5か月分で、区間の無い500円以下の交通費はすべて駐輪場だった・2026-11-09 総チェック） */
export const MF_PARKING_SUSPECT_MAX = 500

/** 交通費の明細に混ざっている駐輪場代。領収書が申請額より小さく少額なら、その領収書の分（電車代 1,420円＋駐輪場代 110円 → 110） */
export function mfParkingInFare(amount: number, receiptAmount: number | null | undefined): number {
  if (receiptAmount === null || receiptAmount === undefined || receiptAmount <= 0) return 0
  return receiptAmount < Math.round(amount) && receiptAmount <= MF_PARKING_SUSPECT_MAX ? receiptAmount : 0
}

/** 朝のチェックが止まっていないか。読む側で時刻を見るので、cron そのものが動かなかった日も分かる（通知ベル） */
export function mfRunProblem(state: { completedDate: string | null; lastError: string | null }, today: string, jstHour: number, label: string): string | null {
  if (state.lastError) return `${label}のチェックが失敗しています`
  if (jstHour >= 8 && state.completedDate !== today) return `${label}の今朝のチェックが終わっていません`
  return null
}

/** 駐輪場の明細には駅名が書かれるので、電車の言葉で「科目違い」にしない（駐輪場代を分けて出し直した人が止まらないように） */
const MF_PARKING_WORDS = ['駐輪', '駐車']
const KATAKANA = /[ァ-ヶー]/

/** カタカナの言葉は、続きもカタカナなら別の言葉として扱う（バス → バスケット、レギュラー → レギュラーサイズ） */
export function mfTextHasWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!KATAKANA.test(word[0]) || !KATAKANA.test(text[i + word.length] || '')) return true
  }
  return false
}

/** 確認メモの入力を整える。画面とサーバで同じ判定にする */
export function normalizeMfReviewNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  const note = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!note) return { ok: false, error: '確認した内容や理由を書いてください' }
  if (note.length > MF_REVIEW_NOTE_MAX) return { ok: false, error: `${MF_REVIEW_NOTE_MAX} 文字までで書いてください` }
  return { ok: true, note }
}

/**
 * 毎朝のチェックのあとも確認メモを残してよいか。同じ提出のあいだは残し、出し直された申請は中身が変わるので消す。
 * submittedAt は 2026-11-09 に足した項目なので、無い古い控えは提出日で比べる
 */
export function isSameMfSubmission(
  before: { submittedAt?: string; submittedIso: string } | undefined,
  now: { submittedAt: string; submittedIso: string },
): boolean {
  if (!before) return false
  if (before.submittedAt && now.submittedAt) return before.submittedAt === now.submittedAt
  return before.submittedIso === now.submittedIso
}

/** 領収書の読み取り結果（expenseReceiptReads）。画像は持たず、読んだ日付と金額だけ */
export interface MfReceiptRead {
  fileId: string
  readable: boolean
  date: string | null
  amount: number | null
  reason?: string
  readAt: string
  model: string
}

/**
 * 領収書の日付・金額のずれの重さ。読み取りの精度を確かめる間は「参考」で出す（2026-11-09 代表）。
 * 精度に問題がないと分かったら 'confirm' に変える（ここ1か所）
 */
export const MF_RECEIPT_FLAG_LEVEL: MfFlagLevel = 'info'

export const MF_RULE_LABEL: Record<MfRuleId, string> = {
  U1: '作業員が未確定',
  R2: '領収書の日付',
  R3: '領収書の金額',
  R4: '領収書の読み取り',
  R5: '交通費と駐輪場代',
  X1: '明細の読み取り',
  U2: '科目が未設定',
  K2: '駐輪場代の疑い',
  T5: '同じ現場の交通費',
  T6: '同じ区間の最安',
  T1: '交通費と出勤日',
  T3: '交通費の金額',
  T4: 'ガソリン代',
  D1: '日付',
  D2: '二重申請',
  R1: '領収書',
  K1: '科目',
  G1: '道具代の対象',
  G2: '道具代の残額',
  G3: '道具代の折半',
  M1: '出し忘れ',
  M2: '締め切り後',
}

export interface MfExpenseFlag {
  rule: MfRuleId
  level: MfFlagLevel
  message: string
  /** どの明細の指摘か（申請全体の指摘は無し） */
  txId?: string
  /** 領収書から読み取った値（R2・R3・R5） */
  receipt?: { date?: string; amount?: number }
  /** 同じ現場のいつもの金額（T5）・同じ区間の社内の最安（T6） */
  usual?: number
  /** その日の交通費の合計（T5。1行の金額ではなく合計で比べている） */
  dayTotal?: number
  /** 同じ区間で最安より高い、ほかの明細の数（T6。指摘は区間ごとに1回なので、文面で伝える） */
  moreLines?: number
}

/** 保存する明細（MF の項目のうち、チェックと表示に要るものだけ） */
export interface MfExpenseTx {
  id: string
  /** 利用日 YYYY-MM-DD（無ければ空） */
  date: string
  amount: number
  itemId: string
  itemName: string
  remark: string
  memo: string
  hasFile: boolean
  /** MF の添付の ID（差し替えの見分け用） */
  fileId?: string
  /** 領収書から読み取った内容（読んだ明細だけ） */
  receipt?: { readable: boolean; date: string | null; amount: number | null }
}

/** 過去の明細（T3・T4・D2・M1 に使う）。その人が出した他の申請も含む */
export interface MfHistoryTx {
  id: string
  reportId: string
  memberId: string
  date: string
  amount: number
  itemId: string
  remark: string
}

// ────────────────────────────────────────
//  日付の小道具（'YYYY-MM-DD' と 'YYYYMM' の文字列だけで計算する）
// ────────────────────────────────────────

export const ymOfIso = (iso: string): string => iso.slice(0, 4) + iso.slice(5, 7)

export function shiftYm(ym: string, delta: number): string {
  const total = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + delta
  const y = Math.floor(total / 12)
  return `${y}${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * これより後の日に出た申請は、月末に当月分を出した可能性を見る。
 * 前月分の申請はキャシュモの締め切り（当月15日）までに出るので、16日以降は当月分もありうる
 */
export const MONTH_END_SUBMIT_FROM_DAY = 16

/**
 * 何月分の申請か。決まりは「前月分を当月に申請する」だが、実データでは月末に当月分を出す人がいた
 * （2026-11-09: 10/31 に 10月分を出した申請が全明細「当月の日付」になった）。
 * 16日以降に出て、当月の明細のほうが多ければ当月分とする。15日までは前月分のまま（当月の日付が混ざったら D1 で知らせる）
 */
export function targetYmOf(submittedIso: string, txDates: string[] = []): string {
  const thisYm = ymOfIso(submittedIso)
  const prevYm = shiftYm(thisYm, -1)
  if (Number(submittedIso.slice(8, 10)) < MONTH_END_SUBMIT_FROM_DAY) return prevYm
  const count = (ym: string) => txDates.filter(d => d && ymOfIso(d) === ym).length
  return count(thisYm) > count(prevYm) ? thisYm : prevYm
}

/** 前月・当月の明細の控えを読み直す間隔。朝 7:00 に読めば 7:10 の続きでは読み直さず、申請の読み取りに時間を使える */
export const MF_HOT_HISTORY_TTL_MS = 6 * 60 * 60_000

/** 明細の控えをそのまま使えるか。前月より古い月は控えがあれば十分、前月・当月は読んでから間もなければ使う */
export function isMfHistoryFresh(ym: string, hotFromYm: string, fetchedAt: string | undefined, nowMs: number): boolean {
  if (ym < hotFromYm) return true
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN
  return Number.isFinite(at) && nowMs - at < MF_HOT_HISTORY_TTL_MS
}

const fmtYm = (ym: string) => `${Number(ym.slice(4, 6))}月`
const fmtDay = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`
const yen = (n: number) => `${Math.round(n).toLocaleString('ja-JP')}円`

const normalizeRemark = (s: string) => s.normalize('NFKC').replace(/[\s　]/g, '').toLowerCase()

// ────────────────────────────────────────
//  申請ごとのチェック
// ────────────────────────────────────────

/** 道具代の台帳の情報（lib/mf-expense-run.server.ts が道具代管理の計算を使って作る） */
export interface MfToolContext {
  /** その日に道具代の対象か（役員・事務・入社6か月未満は false） */
  eligibleOn(date: string): boolean
  /** その日の領収書が入る期間と、その期間の残額。期間が決まらなければ null */
  periodOn(date: string): { periodStart: string; remaining: number } | null
}

export interface MfReportCheckInput {
  reportId: string
  submittedIso: string
  today: string
  txs: MfExpenseTx[]
  /** その人の過去の明細（この申請の明細が混ざっていてもよい。D2・T3 はこの申請を除いて見る） */
  history: MfHistoryTx[]
  settings: MfExpenseSettings
  /** 'worker' = 作業員に結びついている／'pending' = 未確定／'excluded' = 作業員ではない（出面・道具代を見ない） */
  link: 'worker' | 'pending' | 'excluded'
  /** その人が出勤した日（link === 'worker' のときだけ意味がある） */
  workDays: Set<string>
  /** 出面を読んだ月（ここに無い月の日付は T1 で見ない） */
  loadedYms: Set<string>
  tool: MfToolContext | null
  /** 領収書の読み取り結果（明細ID → 結果）。無ければ領収書の中身は見ない */
  receiptReads?: Record<string, MfReceiptRead>
  /** その人がその日に入った現場（1日に1現場の日だけ。T5 に使う） */
  siteOfDay?: Record<string, { id: string; name: string }>
  /** 区間ごとの社内の最安（buildMfRouteMinFares）。T6 に使う */
  routeMinFares?: Record<string, number>
}

/**
 * 明細の内容から区間のキーを作る。MF の経路検索が書く「秋津~笹塚 往復電車代」の形だけを読む。
 * 名前の前置き「笹塚(秋津~笹塚 往復電車代)」は外し、「中里(東京都)／西武バス」の括弧は残す。上りと下りは同じ区間として扱う
 */
export function mfRouteKey(remark: string): string | null {
  const s = remark.normalize('NFKC').replace(/[〜～]/g, '~')
  const parts = s.split('~')
  if (parts.length !== 2) return null
  const m = parts[1].match(/^(.*?)\s*(往復|片道)/)
  if (!m) return null
  const to = m[1].trim()
  let depth = 0
  let open = -1
  Array.from(parts[0]).forEach((c, i) => {
    if (c === '(') { if (depth === 0) open = i; depth++ } else if (c === ')' && depth > 0) depth--
  })
  const from = (depth > 0 ? parts[0].slice(open + 1) : parts[0]).trim()
  if (!from || !to) return null
  return `${[from, to].sort().join('~')} ${m[2]}`
}

export interface MfRouteTableEntry {
  memberId: string
  name: string
  amount: number
  lines: number
}

export interface MfRouteTableRow {
  route: string
  /** 社内の最安（全期間の実績） */
  min: number
  entries: MfRouteTableEntry[]
  /** 最安との差額の合計（円） */
  excess: number
}

/** 月ごとの区間の比較表。最安との差額が大きい区間から並べる（画面の「区間の比較」） */
export function buildMfRouteTable(
  rows: { itemId: string; amount: number; remark: string; date: string; memberId: string }[],
  settings: MfExpenseSettings,
  minFares: Record<string, number>,
  nameOf: (memberId: string) => string,
): Record<string, MfRouteTableRow[]> {
  const months = new Map<string, Map<string, Map<string, MfRouteTableEntry>>>()
  for (const r of rows) {
    if (settings.itemKinds[r.itemId] !== 'transit' || !(r.amount > 0) || !r.date) continue
    const route = mfRouteKey(r.remark)
    if (!route || minFares[route] === undefined) continue
    const ym = ymOfIso(r.date)
    if (!months.has(ym)) months.set(ym, new Map())
    const routes = months.get(ym)!
    if (!routes.has(route)) routes.set(route, new Map())
    const entries = routes.get(route)!
    const key = `${r.memberId}|${r.amount}`
    const cur = entries.get(key)
    if (cur) cur.lines++
    else entries.set(key, { memberId: r.memberId, name: nameOf(r.memberId), amount: r.amount, lines: 1 })
  }
  const out: Record<string, MfRouteTableRow[]> = {}
  for (const [ym, routes] of Array.from(months)) {
    out[ym] = Array.from(routes).map(([route, entries]) => {
      const min = minFares[route]
      const list = Array.from(entries.values()).sort((a, b) => b.amount - a.amount || b.lines - a.lines)
      return { route, min, entries: list, excess: list.reduce((s, e) => s + Math.max(0, e.amount - min) * e.lines, 0) }
    }).sort((a, b) => b.excess - a.excess || a.route.localeCompare(b.route))
  }
  return out
}

/** 区間ごとの社内の最安。1回だけの金額は打ち間違いかもしれないので、2回以上出た金額の中で一番安いものにする */
export function buildMfRouteMinFares(rows: { itemId: string; amount: number; remark: string }[], settings: MfExpenseSettings): Record<string, number> {
  const seen = new Map<string, Map<number, number>>()
  for (const r of rows) {
    if (settings.itemKinds[r.itemId] !== 'transit' || !(r.amount > 0)) continue
    const key = mfRouteKey(r.remark)
    if (!key) continue
    const counts = seen.get(key) || new Map<number, number>()
    counts.set(r.amount, (counts.get(r.amount) || 0) + 1)
    seen.set(key, counts)
  }
  const out: Record<string, number> = {}
  for (const [key, counts] of Array.from(seen)) {
    const repeated = Array.from(counts).filter(([, n]) => n >= 2).map(([a]) => a)
    if (repeated.length > 0) out[key] = Math.min(...repeated)
  }
  return out
}

export function checkExpenseReport(input: MfReportCheckInput): { flags: MfExpenseFlag[]; targetYm: string } {
  const { reportId, submittedIso, today, txs, history, settings, link, workDays, loadedYms, tool } = input
  const targetYm = targetYmOf(submittedIso, txs.map(t => t.date))
  const flags: MfExpenseFlag[] = []
  const kindOf = (itemId: string): MfItemKind | undefined => settings.itemKinds[itemId]
  const others = history.filter(h => h.reportId !== reportId)
  const hasAttendance = link === 'worker'
  const pct = settings.amountPct / 100

  if (link === 'pending') {
    flags.push({ rule: 'U1', level: 'confirm', message: 'MF の従業員と作業員の結びつけが未確定です。出面と道具代のチェックはしていません' })
  }

  for (const tx of txs) {
    const kind = kindOf(tx.itemId)
    const label = `${tx.date ? fmtDay(tx.date) : '日付なし'} ${tx.itemName} ${yen(tx.amount)}`

    // D1: 前月以外の日付
    if (!tx.date) {
      flags.push({ rule: 'D1', level: 'confirm', txId: tx.id, message: `${tx.itemName} ${yen(tx.amount)}: 日付が入っていません` })
    } else if (tx.date > today) {
      flags.push({ rule: 'D1', level: 'confirm', txId: tx.id, message: `${label}: 未来の日付です` })
    } else if (ymOfIso(tx.date) !== targetYm) {
      const older = ymOfIso(tx.date) < targetYm
      flags.push({ rule: 'D1', level: 'confirm', txId: tx.id, message: `${label}: ${fmtYm(targetYm)}分の申請に${older ? 'それより前の月の出し忘れ' : '当月の日付'}が入っています` })
    }

    // D2: 同じ人・同じ日・同じ金額・同じ科目が他の申請にもある
    if (tx.date && others.some(o => o.date === tx.date && o.amount === tx.amount && o.itemId === tx.itemId)) {
      flags.push({ rule: 'D2', level: 'confirm', txId: tx.id, message: `${label}: 同じ日・同じ金額・同じ科目の明細が他の申請にもあります` })
    }

    // R1: 領収書なし（交通費など領収書の要らない科目と、未設定の科目は見ない）
    if ((kind === 'gas' || kind === 'tool' || kind === 'other') && !tx.hasFile) {
      flags.push({ rule: 'R1', level: 'confirm', txId: tx.id, message: `${label}: 領収書が添付されていません` })
    }

    // R2・R3・R4: 領収書の中身と申請の比較。確信が持てない項目は AI が null にするので、読めた項目だけ比べる
    const stored = tx.hasFile ? input.receiptReads?.[tx.id] : undefined
    const read = mfIsReceiptReadCurrent(tx, stored) ? stored : undefined
    if (read) {
      if (!read.readable || (read.date === null && read.amount === null)) {
        flags.push({ rule: 'R4', level: 'info', txId: tx.id, message: `${label}: 領収書を読み取れませんでした。目で確かめてください` })
      } else {
        if (read.date && tx.date && read.date !== tx.date) {
          flags.push({ rule: 'R2', level: MF_RECEIPT_FLAG_LEVEL, txId: tx.id, receipt: { date: read.date }, message: `${label}: 領収書の日付は ${fmtDay(read.date)} です` })
        }
        // 折半・半額は申請額が領収書と違って当たり前なので比べない
        const isSplit = settings.splitWords.some(w => `${tx.remark} ${tx.memo}`.includes(w))
        if (read.amount !== null && !isSplit && read.amount !== Math.round(tx.amount)) {
          // 交通費のずれは、電車代に駐輪場代を足した明細が多い。駐輪場代は分けて申請する決まりで、差し戻すので要確認にする（2026-11-09 代表）
          const transit = kind === 'transit'
          flags.push({
            rule: transit ? 'R5' : 'R3', level: transit ? 'confirm' : MF_RECEIPT_FLAG_LEVEL, txId: tx.id, receipt: { amount: read.amount },
            message: transit
              ? (mfParkingInFare(tx.amount, read.amount) > 0
                ? `${label}: 付いている領収書は ${yen(read.amount)} です（電車代 ${yen(tx.amount - read.amount)}＋駐輪場代 ${yen(read.amount)} かもしれません）。写真を確かめて、分けて申請してもらってください`
                : `${label}: 付いている領収書は ${yen(read.amount)} で、申請の金額と違います。写真を確かめてください`)
              : `${label}: 領収書の金額は ${yen(read.amount)} です`,
          })
        }
        // 交通費は金額のずれを必ず見る決まりなので、金額が読めなかったら「問題なし」にしない
        if (read.amount === null && kind === 'transit') {
          flags.push({ rule: 'R4', level: 'info', txId: tx.id, message: `${label}: 領収書の金額を読み取れませんでした。目で確かめてください` })
        }
      }
    }

    // K1: 摘要と科目が合わない
    if (kind) {
      const text = tx.remark
      const isParking = MF_PARKING_WORDS.some(w => text.includes(w))
      const transitWord = isParking ? undefined : settings.transitWords.find(w => mfTextHasWord(text, w))
      const gasWord = settings.gasWords.find(w => mfTextHasWord(text, w))
      // ガソリン代には店の名前（JR川口駅前店など）が書かれるので、電車の言葉では見ない
      if (kind !== 'transit' && kind !== 'gas' && transitWord) {
        flags.push({ rule: 'K1', level: 'confirm', txId: tx.id, message: `${label}: 内容に「${transitWord}」とありますが、交通費の科目ではありません` })
      } else if (kind !== 'gas' && gasWord) {
        flags.push({ rule: 'K1', level: 'confirm', txId: tx.id, message: `${label}: 内容に「${gasWord}」とありますが、ガソリン代の科目ではありません` })
      }
    }

    // T1: 交通費の日に出勤が無い
    if (kind === 'transit' && hasAttendance && tx.date && loadedYms.has(ymOfIso(tx.date)) && tx.date <= today && !workDays.has(tx.date)) {
      flags.push({ rule: 'T1', level: 'confirm', txId: tx.id, message: `${label}: この日は現場に出た記録がありません（休み・欠勤・現場都合休の可能性があります）` })
    }

    // T3: いつもの金額と大きく違う（同じ経路・同じ科目の直近3か月）
    if (kind === 'transit' && tx.remark) {
      const route = normalizeRemark(tx.remark)
      const past = others.filter(o => {
        if (o.itemId !== tx.itemId || normalizeRemark(o.remark) !== route || !o.date) return false
        const ym = ymOfIso(o.date)
        return ym >= shiftYm(targetYm, -3) && ym < targetYm
      })
      if (past.length >= 2) {
        const avg = past.reduce((s, o) => s + o.amount, 0) / past.length
        if (avg > 0 && Math.abs(tx.amount - avg) / avg > pct) {
          flags.push({ rule: 'T3', level: 'info', txId: tx.id, message: `${label}: 同じ経路のいつもの金額（平均${yen(avg)}）と大きく違います` })
        }
      }
    }

    // G1・G3: 道具代の対象と折半
    if (kind === 'tool') {
      if (hasAttendance && tool && tx.date) {
        if (!tool.eligibleOn(tx.date)) {
          flags.push({ rule: 'G1', level: 'confirm', txId: tx.id, message: `${label}: この人は道具代の対象外です（役員・事務・入社6か月未満）` })
        } else if (!tool.periodOn(tx.date)) {
          flags.push({ rule: 'G1', level: 'confirm', txId: tx.id, message: `${label}: この日付が入る道具代の期間がありません（期間の起点日を確認してください）` })
        }
      }
      const splitWord = settings.splitWords.find(w => `${tx.remark} ${tx.memo}`.includes(w))
      if (splitWord) {
        flags.push({ rule: 'G3', level: 'confirm', txId: tx.id, message: `${label}: 「${splitWord}」とあります。領収書の金額と申請額を確かめてください` })
      }
    }
  }

  // G2: 承認すると道具代の残額がマイナスになる（同じ期間の明細を合計して見る）
  if (hasAttendance && tool) {
    const byPeriod = new Map<string, { remaining: number; total: number }>()
    for (const tx of txs) {
      if (kindOf(tx.itemId) !== 'tool' || !tx.date || !tool.eligibleOn(tx.date)) continue
      const p = tool.periodOn(tx.date)
      if (!p) continue
      const cur = byPeriod.get(p.periodStart) || { remaining: p.remaining, total: 0 }
      cur.total += tx.amount
      byPeriod.set(p.periodStart, cur)
    }
    byPeriod.forEach(({ remaining, total }) => {
      if (remaining - total < 0) {
        flags.push({ rule: 'G2', level: 'confirm', message: `道具代 ${yen(total)} を承認すると、残額 ${yen(remaining)} を超えてマイナスになります` })
      }
    })
  }

  // T6: 同じ区間で社内の最安より高い（2026-11-09 代表・最安ルートの決まり）。申請ごと・区間ごとに1回だけ出す
  if (input.routeMinFares) {
    // 駐輪場代が混ざった明細は、電車代の分だけで比べる（混ざったままだと差額が水増しされ、最安どおりの人にも出る）
    const fareOf = (t: MfExpenseTx): number => {
      const read = t.hasFile ? input.receiptReads?.[t.id] : undefined
      return t.amount - (mfIsReceiptReadCurrent(t, read) ? mfParkingInFare(t.amount, read?.amount) : 0)
    }
    const over = new Map<string, { first: MfExpenseTx; fare: number; lines: number; min: number }>()
    for (const t of txs) {
      if (kindOf(t.itemId) !== 'transit') continue
      const key = mfRouteKey(t.remark)
      const min = key ? input.routeMinFares[key] : undefined
      const fare = fareOf(t)
      if (!key || min === undefined || fare - min <= settings.routeMargin) continue
      const cur = over.get(key)
      if (cur) cur.lines++
      else over.set(key, { first: t, fare, lines: 1, min })
    }
    for (const [key, { first, fare, lines, min }] of Array.from(over)) {
      flags.push({ rule: 'T6', level: 'confirm', txId: first.id, usual: min, moreLines: lines - 1, message: `${key}: ${yen(fare)}（${lines} 件）。同じ区間で社内で一番安い金額は ${yen(min)} です` })
    }
  }

  // K2: 電車代の科目で出ている駐輪場代。領収書と金額が合うので R5 には掛からず、店名に「駐輪」が無いことも多い（2026-11-09 総チェック）
  const parkingLines = txs.filter(t => {
    if (kindOf(t.itemId) !== 'transit' || t.amount <= 0) return false
    if (MF_PARKING_WORDS.some(w => t.remark.includes(w))) return true
    return t.hasFile && t.amount <= MF_PARKING_SUSPECT_MAX && mfRouteKey(t.remark) === null && !settings.transitWords.some(w => mfTextHasWord(t.remark, w))
  })
  if (parkingLines.length > 0) {
    const first = parkingLines[0]
    const more = parkingLines.length - 1
    flags.push({
      rule: 'K2', level: 'confirm', txId: first.id, moreLines: more,
      message: `${first.date ? fmtDay(first.date) : '日付なし'} ${first.itemName} ${yen(first.amount)}${more > 0 ? `（ほか ${more} 件）` : ''}: 電車代の科目に、駐輪場代のような少額の明細があります。駐輪場代なら「駐車場・駐輪場代」で申請してもらってください`,
    })
  }

  // U2: 種類が未設定の科目。領収書や科目のチェックをしていないので、黙って「チェック済み」にしない（2026-11-09 総チェック）
  const unsetItems = new Map<string, MfExpenseTx>()
  for (const t of txs) if (!kindOf(t.itemId) && !unsetItems.has(t.itemId)) unsetItems.set(t.itemId, t)
  for (const t of Array.from(unsetItems.values())) {
    flags.push({ rule: 'U2', level: 'confirm', txId: t.id, message: `${t.itemName || '科目なし'}: 種類が未設定の科目です。「科目の種類」タブで選ぶまで、領収書などのチェックをしていません` })
  }

  // ここから先は「その月まとめて」見る決まり。この申請と、同じ人の他の申請の両方を合わせる
  if (hasAttendance) {
    const sameMonth = (date: string, ym: string) => !!date && ymOfIso(date) === ym
    const allForMonth = (ym: string) => [
      ...txs.filter(t => sameMonth(t.date, ym)).map(t => ({ date: t.date, amount: t.amount, itemId: t.itemId })),
      ...others.filter(o => sameMonth(o.date, ym)).map(o => ({ date: o.date, amount: o.amount, itemId: o.itemId })),
    ]
    const workDaysIn = (ym: string) => Array.from(workDays).filter(d => ymOfIso(d) === ym)
    const targetTxs = allForMonth(targetYm)
    // T5: 同じ人・同じ現場なのに、日によって交通費の合計が違う（2026-11-09 代表）。
    // 3日以上あって、一番多い金額が1つに決まるときだけ、それと決まりの金額（siteTransitMargin）より違う日を出す
    if (input.siteOfDay) {
      const dayTotal = new Map<string, number>()
      for (const r of targetTxs) {
        if (kindOf(r.itemId) === 'transit') dayTotal.set(r.date, (dayTotal.get(r.date) || 0) + r.amount)
      }
      const bySite = new Map<string, { name: string; days: [string, number][] }>()
      for (const [date, total] of Array.from(dayTotal)) {
        const site = input.siteOfDay[date]
        if (!site) continue
        const cur = bySite.get(site.id) || { name: site.name, days: [] }
        cur.days.push([date, total])
        bySite.set(site.id, cur)
      }
      for (const { name, days } of Array.from(bySite.values())) {
        if (days.length < 3) continue
        const counts = new Map<number, number>()
        for (const [, total] of days) counts.set(total, (counts.get(total) || 0) + 1)
        const ranked = Array.from(counts).sort((a, b) => b[1] - a[1])
        if (ranked[0][1] < 2 || ranked[1]?.[1] === ranked[0][1]) continue
        const usual = ranked[0][0]
        for (const [date, total] of days.sort((a, b) => a[0].localeCompare(b[0]))) {
          const mine = txs.find(t => t.date === date && kindOf(t.itemId) === 'transit')
          if (Math.abs(total - usual) <= settings.siteTransitMargin || !mine) continue
          flags.push({ rule: 'T5', level: 'confirm', txId: mine.id, usual, dayTotal: total, message: `${fmtDay(date)} の交通費 ${yen(total)}: 同じ現場（${name}）のいつもの金額 ${yen(usual)} と違います` })
        }
      }
    }

    const gasTotal = (rows: { amount: number; itemId: string }[]) => rows.filter(r => kindOf(r.itemId) === 'gas').reduce((s, r) => s + r.amount, 0)

    // 「出勤した日に交通費が無い」は見ない。皆で車に乗り合わせて通う日があり、つけ忘れと区別できない（2026-11-09 代表）。
    // 電車代があるのに出面が無い日（欠勤の疑い）は T1 で拾う

    // T4: ガソリン代 ÷ 出勤日数が、直近3か月の平均と大きく違う。給油日と出勤日は合わないので月の合計で見る
    if (txs.some(t => kindOf(t.itemId) === 'gas')) {
      const days = workDaysIn(targetYm).length
      const total = gasTotal(targetTxs)
      const ratios = [1, 2, 3].flatMap(back => {
        const ym = shiftYm(targetYm, -back)
        const d = workDaysIn(ym).length
        const g = gasTotal(allForMonth(ym))
        return d > 0 && g > 0 ? [g / d] : []
      })
      if (days > 0 && total > 0 && ratios.length > 0) {
        const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length
        const cur = total / days
        if (Math.abs(cur - avg) / avg > pct) {
          flags.push({ rule: 'T4', level: 'info', message: `ガソリン代が出勤1日あたり ${yen(cur)} です（直近の平均 ${yen(avg)}）` })
        }
      }
    }
  }

  return { flags, targetYm }
}

// ────────────────────────────────────────
//  月の声かけ（M1・M2）
// ────────────────────────────────────────

export interface MfReminderPerson {
  memberId: string
  name: string
  /** 前月の出勤日数 */
  workDays: number
  /** 前月分の申請が出ているか（承認待ち・承認済みのどちらでも） */
  filed: boolean
  /** 前月より前の3か月のうち、申請のあった月数 */
  recentMonths: number
}

export interface MfReminderEntry {
  /** 画面に渡すときだけ付ける */
  org?: MfOrg
  rule: 'M1' | 'M2'
  level: MfFlagLevel
  memberId: string
  name: string
  message: string
}

export function buildMonthlyReminders(args: {
  today: string
  settings: MfExpenseSettings
  people: MfReminderPerson[]
  rejected: { memberId: string; name: string; title: string }[]
}): MfReminderEntry[] {
  const { today, settings, people, rejected } = args
  const day = Number(today.slice(8, 10))
  if (day < settings.m1Day) return []
  const isAfterDeadline = day >= settings.m2Day
  const rule = isAfterDeadline ? 'M2' as const : 'M1' as const
  const level: MfFlagLevel = isAfterDeadline ? 'confirm' : 'info'
  const prev = fmtYm(shiftYm(ymOfIso(today), -1))

  // 「毎月出している人」だけ。現場の人の大半は車に乗り合わせで経費が無いので、全員を出すと声かけ先が埋もれる
  const notFiled: MfReminderEntry[] = people
    .filter(p => !p.filed && p.workDays > 0 && p.recentMonths >= 2)
    .map(p => ({ rule, level, memberId: p.memberId, name: p.name, message: `${prev}分の申請がまだありません（${prev}の出勤 ${p.workDays} 日）` }))

  if (!isAfterDeadline) return notFiled
  return [
    ...notFiled,
    ...rejected.map(r => ({ rule: 'M2' as const, level: 'confirm' as const, memberId: r.memberId, name: r.name, message: `差し戻したままの申請があります（${r.title || '題名なし'}）` })),
  ]
}

// ────────────────────────────────────────
//  MF の従業員と作業員の結びつけ
// ────────────────────────────────────────

export type MfLinkHow = 'number' | 'manual' | 'excluded'

export interface MfMemberLink {
  /** 画面に渡すときだけ付ける（保存先が会社ごとに分かれているので、保存はしない） */
  org?: MfOrg
  mfId: string
  number: string
  name: string
  active: boolean
  workerId: number | null
  /** number = 番号の一致で自動／manual = 人が確定／excluded = 作業員ではない／null = 未確定 */
  how: MfLinkHow | null
  /** 未確定のときの候補（氏名が近い作業員） */
  candidates: number[]
  /** 番号は一致したが氏名が違う（確かめてほしい目印） */
  nameDiffers?: boolean
}

/** その会社のチェックの対象の作業員か */
export function isMfWorkerInOrg(org: MfOrg, w: { org?: unknown; visa?: string | null }): boolean {
  if (org === 'hibi') return w.org === '日比' || w.org === 'hibi'
  return String(w.org || '').toLowerCase() === 'hfu' && (w.visa || '').startsWith('jisshu')
}

/** MF の事業者の一覧から HFU を見つける（登記の名前は「エイチエフユナイテッド株式会社」） */
export function mfHfuOffice<T extends { id: string; name: string }>(offices: T[], hibiOfficeId: string): T | undefined {
  return offices.find(o => o.id !== hibiOfficeId && (o.name.includes('エイチエフユナイテッド') || /HFU/i.test(o.name)))
}

const isLinkedMember = (m: MfMemberLink | undefined): boolean => !!m && m.how !== 'excluded' && m.workerId !== null

/**
 * HFU の申請を読むか。技能実習生に結びついた人と、結びつけ待ち（氏名の近い実習生がいる人）だけ。
 * 本部・不動産の人の明細は読まない
 */
export function mfHfuReportInScope(m: MfMemberLink | undefined): boolean {
  return isLinkedMember(m) || (!!m && m.how === null && m.candidates.length > 0)
}

/** 区間の比較に入れる HFU の人（結びついた実習生だけ。本部の人の通勤は現場の比較にならない） */
export const mfHfuMemberCounts = isLinkedMember

/** 人が結びつけを決める必要があるか。HFU で候補のいない人は実習生ではないので数えない */
export function mfMemberNeedsLink(m: MfMemberLink): boolean {
  return m.active && m.how === null && !(m.org === 'hfu' && m.candidates.length === 0)
}

export interface MfWorkerForLink {
  id: number
  name: string
  payrollNo?: string
}

const normalizeName = (s: string) => s.normalize('NFKC').replace(/[\s　・･.,]/g, '').toLowerCase()
const normalizeNumber = (s: string | undefined | null) => String(s ?? '').normalize('NFKC').trim().replace(/^0+(?=\d)/, '')

function nameScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.8
  const chars = new Set(b)
  const common = Array.from(new Set(a)).filter(c => chars.has(c)).length
  return common / Math.max(new Set(a).size, chars.size)
}

/**
 * 結びつけを作り直す（代表決定 2026-11-08: 番号は自動・氏名は候補を出して総務が確定）。
 * - 人が決めたもの（manual・excluded）は上書きしない
 * - MF の従業員番号とキャシュモ番号（payrollNo）が1対1で一致した人だけ自動で結ぶ
 * - それ以外は未確定のまま、氏名の近い作業員を候補に出す（氏名だけでは自動で結ばない。他人の出面と比べてしまうため）
 */
export function linkMfMembers(
  members: { mfId: string; number: string; name: string; active: boolean }[],
  workers: MfWorkerForLink[],
  existing: Record<string, MfMemberLink | undefined>,
): Record<string, MfMemberLink> {
  const byNumber = new Map<string, MfWorkerForLink[]>()
  for (const w of workers) {
    const n = normalizeNumber(w.payrollNo)
    if (n) byNumber.set(n, [...(byNumber.get(n) || []), w])
  }
  const memberNumberCount = new Map<string, number>()
  for (const m of members) {
    const n = normalizeNumber(m.number)
    if (n) memberNumberCount.set(n, (memberNumberCount.get(n) || 0) + 1)
  }

  const out: Record<string, MfMemberLink> = {}
  for (const m of members) {
    const base = { mfId: m.mfId, number: m.number, name: m.name, active: m.active }
    const prev = existing[m.mfId]
    if (prev?.how === 'manual' || prev?.how === 'excluded') {
      out[m.mfId] = { ...base, workerId: prev.workerId, how: prev.how, candidates: [] }
      continue
    }
    const n = normalizeNumber(m.number)
    const hits = n && memberNumberCount.get(n) === 1 ? byNumber.get(n) || [] : []
    if (hits.length === 1) {
      const hit = hits[0]
      const link: MfMemberLink = { ...base, workerId: hit.id, how: 'number', candidates: [] }
      if (normalizeName(hit.name) !== normalizeName(m.name)) link.nameDiffers = true
      out[m.mfId] = link
      continue
    }
    const target = normalizeName(m.name)
    const candidates = workers
      .map(w => ({ id: w.id, score: nameScore(target, normalizeName(w.name)) }))
      .filter(c => c.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(c => c.id)
    out[m.mfId] = { ...base, workerId: null, how: null, candidates }
  }
  return out
}
