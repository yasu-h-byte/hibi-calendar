import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { Worker } from '@/types'
import { todayJstIso, addMonthsSafe } from './date-utils'

/**
 * 人員マスタの読み出し。
 *
 * ⚠️ **この map は許可リストになっている。** Firestore に保存されていても、ここに
 *    書き忘れたフィールドは呼び出し側に届かない。「保存したのに画面では未入力のまま」
 *    という形で表面化し、書き込み側を疑って時間を溶かす（2026-08-26 に birthDate で発生）。
 *    Worker 型にフィールドを足したら、必ずここにも足すこと。
 *    漏れは `__tests__/workersMapping.test.ts` が検出する。
 */
export async function getWorkers(): Promise<Worker[]> {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)

  if (!docSnap.exists()) {
    return []
  }

  return mapRawWorkers(docSnap.data().workers || [])
}

/**
 * 人員の項目を「給与」と「それ以外」に仕分ける（2026-10-02 代表「給与は靖仁・政仁・森田だけ」）。
 * /api/workers は相手によって返す項目を変える:
 *   給与を見られる人（pay.view）= 全部 ／ 事務・役員（workers.view）= WORKER_OFFICE_KEYS ／ 職長 = WORKER_PUBLIC_KEYS
 * mapRawWorkers に項目を足したら、必ずどちらかに入れる（__tests__/workerKeys.test.ts が仕分け漏れを落とす）。
 */
export const WORKER_PAY_KEYS = [
  'rate', 'hourlyRate', 'otMul', 'salary', 'jpGrade', 'jpStep', 'rateFrom', 'prevRate', 'prevJpStep',
  'hourlyRateFrom', 'prevHourlyRate', 'salaryFrom', 'prevSalary', 'scheduledChanges', 'appliedChanges',
] as const
/** 職長にも返してよい項目（名前・所属・在留資格・職種・入社日など） */
export const WORKER_PUBLIC_KEYS = ['id', 'name', 'nameVi', 'company', 'visaType', 'jobType', 'hireDate', 'retired', 'dispatchTo', 'dispatchFrom', 'canDrive'] as const
/** 事務所の人（給与は見られない事務・役員）に返す項目。給与以外の人員マスタの項目（スマホURLは workers.edit のときだけ） */
export const WORKER_OFFICE_KEYS = [
  ...WORKER_PUBLIC_KEYS,
  'token', 'visaExpiry', 'useOldRules', 'payrollNo', 'birthDate', 'nonSmoker', 'children', 'breakShortenMin', 'breakShortenFrom', 'memo',
] as const

/**
 * 代表だけが直接書き換えられる項目（lib/permissions.ts workers.editPay）＝ 給与の項目すべて ＋ 旧ルール継続。
 *
 * 2026-10-02 総合点検: 旧は app/api/workers/route.ts に手書きの一覧（OWNER_ONLY_PAY_FIELDS）が別にあり、
 *   rateFrom・prevRate・prevJpStep・salaryFrom・prevSalary が抜けていた。事務が「適用開始日を先の日付＋直前の日額」を
 *   送ると、今月の給与計算の日額・月給が変わり、監査ログ（auditTrail）にも残らなかった。
 *   一覧を WORKER_PAY_KEYS から作って1つにする（給与の項目を足せば、自動で代表専用・監査対象になる）。
 */
export const WORKER_OWNER_ONLY_KEYS: readonly string[] = [...WORKER_PAY_KEYS, 'useOldRules']

/**
 * /api/workers の add・update が受け付ける項目（**許可リスト**・Firestore の生のキー名＝ org / visa / job）。
 *
 * 2026-10-02 総合点検: 旧の update は body のキーを何でも人員マスタへマージしていた
 *   （token を書き換える・prevRate を足す・知らない項目を増やす、がそのまま通った）。
 *   ここに無いキーは 400 で断る。項目を足すときは、画面より先にここへ足す。
 * - WORKER_WRITABLE_PAY_KEYS は代表だけ（値が変わるときに workers.editPay を確かめる）
 * - scheduledChanges / appliedChanges は日付指定の切り替えの仕組み（lib/worker-crud.ts）が書くので入れない
 * - token は generateToken / revokeToken だけが書く
 */
export const WORKER_WRITABLE_BASE_KEYS = [
  'name', 'nameVi', 'org', 'visa', 'job', 'hireDate', 'retired', 'visaExpiry', 'memo', 'birthDate', 'payrollNo',
  'dispatchTo', 'dispatchFrom', 'canDrive', 'nonSmoker', 'children', 'breakShortenMin', 'breakShortenFrom',
] as const
export const WORKER_WRITABLE_PAY_KEYS = [
  'rate', 'hourlyRate', 'otMul', 'salary', 'jpGrade', 'jpStep', 'useOldRules',
  'rateFrom', 'prevRate', 'prevJpStep', 'hourlyRateFrom', 'prevHourlyRate', 'salaryFrom', 'prevSalary',
] as const
/**
 * 空文字・null を送ると「その項目を消す」になる項目（2026-10-02 総合点検）。
 * 旧: 画面は `retired: form.retired || undefined` のように送り、JSON でキーごと落ちて「変更なし」になっていた
 *   ＝**誤って入れた退職日・在留期限・メモを画面から消せなかった**。キーを送らない（undefined）は今までどおり「変更なし」。
 * 名前・所属・在留資格・職種・入社日は空にできない（消すと集計や役割の判定が壊れる）。
 */
export const WORKER_CLEARABLE_KEYS: readonly string[] = [
  'nameVi', 'retired', 'visaExpiry', 'memo', 'birthDate', 'payrollNo', 'dispatchTo', 'dispatchFrom',
  'breakShortenMin', 'breakShortenFrom',
  'hourlyRate', 'salary', 'jpGrade', 'jpStep', 'rateFrom', 'prevRate', 'prevJpStep',
  'hourlyRateFrom', 'prevHourlyRate', 'salaryFrom', 'prevSalary',
]

/**
 * demmen/main の workers 配列（生データ）を Worker 型へ写像する（2026-09-02 抽出）。
 *
 * main ドキュメントは約260KBあり、1リクエスト内で getWorkers / getStaffSites /
 * getSites がそれぞれ再読すると読みだけで数秒かかる。API側で main を1回だけ読み、
 * この関数で写像することで重複読みをなくす（スマホ出面が20秒かかった障害の対処）。
 * 許可リスト方式なので Worker 型にフィールドを足したら必ずここにも足すこと
 * （漏れは __tests__/workersMapping.test.ts が検出する）。
 */
export function mapRawWorkers(raw: unknown[]): Worker[] {
  const workers: Worker[] = (raw as Record<string, unknown>[]).map((w: Record<string, unknown>) => ({
    id: w.id as number,
    name: w.name as string,
    nameVi: (w.nameVi as string) || '',
    // 大文字の 'HFU' も HFU（締め・本人確認と同じ orgKeyOf・2026-10-02 総合点検。旧: 小文字だけで、表記ゆれの人が日比建設に出た）
    company: String(w.org || '').toLowerCase() === 'hfu' ? 'HFU' : '日比',
    visaType: (w.visa as string) || '',
    token: (w.token as string) || '',
    jobType: (w.job as string) || '',
    rate: (w.rate as number) || 0,
    hourlyRate: (w.hourlyRate as number) || undefined,
    otMul: (w.otMul as number) || 1.25,
    hireDate: (w.hireDate as string) || '',
    retired: (w.retired as string) || '',
    salary: (w.salary as number) || undefined,
    visaExpiry: (w.visaExpiry as string) || '',
    dispatchTo: (w.dispatchTo as string) || '',
    dispatchFrom: (w.dispatchFrom as string) || '',
    useOldRules: (w.useOldRules as boolean) || undefined,
    payrollNo: (w.payrollNo as string) || undefined,
    birthDate: (w.birthDate as string) || '',
    jpGrade: (w.jpGrade as string) || undefined,
    jpStep: (w.jpStep as number) || undefined,
    rateFrom: (w.rateFrom as string) || undefined,
    prevRate: typeof w.prevRate === 'number' ? (w.prevRate as number) : undefined,
    prevJpStep: typeof w.prevJpStep === 'number' ? (w.prevJpStep as number) : undefined,
    hourlyRateFrom: (w.hourlyRateFrom as string) || undefined,
    prevHourlyRate: typeof w.prevHourlyRate === 'number' ? (w.prevHourlyRate as number) : undefined,
    salaryFrom: (w.salaryFrom as string) || undefined,
    scheduledChanges: Array.isArray(w.scheduledChanges) ? (w.scheduledChanges as Worker['scheduledChanges']) : undefined,
    appliedChanges: Array.isArray(w.appliedChanges) ? (w.appliedChanges as Worker['appliedChanges']) : undefined,
    prevSalary: typeof w.prevSalary === 'number' ? (w.prevSalary as number) : undefined,
    canDrive: typeof w.canDrive === 'boolean' ? (w.canDrive as boolean) : undefined,
    nonSmoker: typeof w.nonSmoker === 'boolean' ? (w.nonSmoker as boolean) : undefined,
    children: Array.isArray(w.children) ? (w.children as string[]) : undefined,
    breakShortenMin: (w.breakShortenMin as number) || undefined,
    breakShortenFrom: (w.breakShortenFrom as string) || undefined,
    // 2026-10-02 総合点検: メモは保存されるのに読み出していなかった（人員マスタで入れても開き直すと空・一覧にも出ない）。
    //   Worker 型（types/index.ts）に無い項目なので、入っているときだけ足す
    ...(typeof w.memo === 'string' && w.memo ? { memo: w.memo } : {}),
  }))

  return workers
}

/**
 * 職長の通行証・個人パスワード・スマホURLを「管理者側の人」として扱う人か（2026-10-02 総合点検）。
 * 代表（0）・事業責任者（1）と、職種が役員・事務の人。
 * この人たちのスマホURL（合言葉）は最終承認などの鍵を兼ねるので、代表にだけ返し、発行・失効も代表だけにする
 * （app/api/workers/route.ts）。旧: 人員マスタを編集できる人（事務）が政仁さん・代表の合言葉を読める・発行し直せた
 * ＝事務が最終承認まで一人で完結できた。
 */
export function isOfficeSideWorker(w: { id: number; jobType?: string | null; job?: string | null }): boolean {
  const job = w.jobType ?? w.job
  return w.id === 0 || w.id === 1 || job === 'yakuin' || job === 'jimu'
}

/**
 * スマホURL（合言葉）がいま使えるか（2026-10-02 総合点検）。
 *
 * 旧: 退職しても合言葉はずっと有効だった（getWorkerByToken に退職日の判定が無く、発行し直すまで本人の出面・有給・
 *     欠勤控除の日額が見え、職長は現場マスタから外すまで承認もできた）。
 * 新: - 'active'  … 在籍中（退職日の当日まで）。今までどおり全部使える
 *     - 'grace'   … 退職日の翌日〜**退職した月の翌月末**。見るだけと、最後の月の本人確認（締め前の月末確認は翌月10日頃まで）だけ
 *     - 'expired' … それ以降。使えない
 * 退職日が日付の形でない古いデータ（'true' など）は、いつ辞めたか分からないので 'expired'。
 */
export type StaffTokenState = 'active' | 'grace' | 'expired'
export function staffTokenStateOf(w: { retired?: string | null }, todayIso: string = todayJstIso()): StaffTokenState {
  if (!isAlreadyRetired(w.retired, todayIso)) return 'active'
  const r = retiredDateOf(w.retired)
  if (!r) return 'expired'
  // 退職した月の翌々月の1日より前＝翌月末まで
  const graceEndExclusive = addMonthsSafe(`${r.slice(0, 7)}-01`, 2)
  return todayIso < graceEndExclusive ? 'grace' : 'expired'
}

/**
 * 合言葉から本人を探す（純関数・main を読み済みの API 用）。
 * 既定は在籍中の人だけ。`allowGrace: true` は「見るだけ・本人確認」の入口だけが付ける（書き込みの入口には付けない）。
 */
export function findWorkerByToken<W extends { token?: string | null; retired?: string | null }>(
  workers: W[], token: string | null | undefined, opts: { allowGrace?: boolean; todayIso?: string } = {},
): W | null {
  // 空の合言葉は誰にも一致させない（未発行の人は token が '' で、'' 同士が一致してしまうため）
  if (!token) return null
  const w = workers.find(x => x.token === token)
  if (!w) return null
  const st = staffTokenStateOf(w, opts.todayIso)
  if (st === 'active' || (st === 'grace' && opts.allowGrace)) return w
  return null
}

export async function getWorkerByToken(token: string, opts: { allowGrace?: boolean } = {}): Promise<Worker | null> {
  if (!token) return null
  return findWorkerByToken(await getWorkers(), token, opts)
}

/**
 * 表示時に最新の workerName を解決するヘルパー（2026-05-13 追加）
 *
 * Why: 帰国情報・評価・申請などの永続レコードは作成時に workerName を
 *   キャッシュしているが、人員マスタで改名しても追従しないため、
 *   表示時にマスタからルックアップして最新名を保証する必要がある。
 *
 * - 通常: workers マスタから ID で引いた名前を返す
 * - フォールバック: マスタから見つからない場合（退職して削除等）は
 *   引数の cached を返す。それも無ければ `ID:{id}` を返す。
 *
 * 任意の name フィールドを持つ Worker 互換型を受け付ける汎用版。
 */
export function resolveWorkerName<T extends { id: number; name: string }>(
  workers: T[],
  workerId: number,
  cached?: string | null,
): string {
  const found = workers.find(w => w.id === workerId)
  if (found?.name) return found.name
  if (cached) return cached
  return `ID:${workerId}`
}

/**
 * 多数の workerId を一括ルックアップする場合の Map ヘルパー。
 * 大量レコードで find ループを毎回回すコストを避ける。
 */
export function buildWorkerNameMap<T extends { id: number; name: string }>(
  workers: T[],
): Map<number, string> {
  const m = new Map<number, string>()
  for (const w of workers) m.set(w.id, w.name)
  return m
}

/**
 * 「指定月にまだ在籍中」かを判定（2026-05-27 追加）
 *
 * - retired が空 / undefined → 常に在籍中 (true)
 * - retired が「表示月の月初」以降 → まだその月までは勤務する (true)
 *   例: ym=202606、retired=2026-06-30 → true（6月末日まで勤務）
 *   例: ym=202607、retired=2026-06-30 → false（既に退職済み）
 *
 * 用途:
 *   - 出面入力グリッド (api/attendance/grid)
 *   - 就業カレンダー署名対象 (api/calendar/*)
 *   - 退職予定バナー
 *
 * これにより `!w.retired` を使う既存箇所のバグ
 * （retired フィールドが入った瞬間に全画面から消える）を防ぐ。
 *
 * @param retired  YYYY-MM-DD 形式の退職日（空文字／undefined OK）
 * @param ym       表示対象月。"YYYYMM"（6桁）または "YYYY-MM"（7桁ダッシュ付き）の両方を受け付ける
 *                 2026-05-27: ダッシュ付き形式も受け付けるように修正
 *                 （以前は正規表現で6桁限定だったため YYYY-MM 渡しで安全側 true にフォール
 *                  バックし、退職者が表示画面に残るバグが発生していた）
 */
export function isStillActiveForMonth(retired: string | undefined | null, ym: string): boolean {
  if (!retired) return true
  // 2026-10-02 総合点検: 古いデータの retired: 'true'（文字列・真偽値）は「いつか分からないが退職済み」。
  //   旧: 'true' >= '2026-10-01' が真になり、ずっと在籍扱いだった
  if (!retiredDateOf(retired)) return false
  if (!ym) return true  // ym 不在は安全側で表示
  // "YYYYMM" / "YYYY-MM" の両方に対応
  const normalized = ym.replace('-', '')
  if (!/^\d{6}$/.test(normalized)) return true  // 不正フォーマットは安全側で表示
  const monthFirstDay = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-01`
  return retired >= monthFirstDay
}

/**
 * 「その月までに入社済みか」を判定（2026-06 追加 / isStillActiveForMonth の入社版）
 *
 * - hireDate が空 → 入社日未設定（既存スタッフ扱い）→ true（対象）
 * - hireDate の年月 <= ym の年月 → 入社済み → true
 * - hireDate の年月 >  ym の年月 → 入社前 → false（対象外）
 *
 * 用途: 月次集計・原価・出面グリッド等で「入社前の月に表示しない」ためのガード。
 *   例: 濱上(hireDate 2026-06-01) は 202605 では false（5月に出さない）、202606 で true。
 */
export function isHiredByMonth(hireDate: string | undefined | null, ym: string): boolean {
  if (!hireDate) return true
  if (!ym) return true
  const normalized = ym.replace('-', '')
  if (!/^\d{6}$/.test(normalized)) return true
  const ymMonth = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}` // 'YYYY-MM'
  const hireMonth = hireDate.slice(0, 7)                                 // 'YYYY-MM'
  return hireMonth <= ymMonth
}

/**
 * その日に在籍しているか（入社日〜退職日。日単位・2026-10-02 追加）。
 *
 * isHiredByMonth / isStillActiveForMonth は「月」で見るので、10/26 入社の人は 10月の初めから「在籍」になる。
 * 「この日の入力が無い」「休みの人」「アクセスが無い」などの日単位のお知らせは、こちらで入社前・退職後の日を外す。
 *   2026-10-02 代表指摘: 10/26 入社のホアンさんに、10/2 の時点で「直近4稼働日に出面の入力がありません」が出ていた。
 *
 * @param iso YYYY-MM-DD
 */
export function isEmployedOn(w: { hireDate?: string | null; retired?: string | null }, iso: string): boolean {
  if (w.hireDate && iso < w.hireDate) return false
  // 日付の形でない退職日（古い 'true'）は退職済み扱い（2026-10-02 総合点検。旧: 文字列比較で在籍になっていた）
  if (w.retired && !retiredDateOf(w.retired)) return false
  if (w.retired && iso > w.retired) return false
  return true
}

/**
 * 「今日時点で既に退職済み」かを判定（2026-06-XX 追加）
 *
 * - retired が空 → 退職予定なし → false（在籍中）
 * - retired < todayIso → 退職日が過去 → true（退職済み）
 * - retired >= todayIso → 退職予定だが今日時点では在籍 → false
 *
 * 用途:
 *   - ダッシュボードの「今日時点で在籍中のメンバー」判定
 *   - 自動有給付与通知の対象判定
 *   - アクセスログの「現役スタッフ」判定
 *
 * isStillActiveForMonth との違い:
 *   - isStillActiveForMonth(retired, ym): 月単位の集計対象判定
 *   - isAlreadyRetired(retired, todayIso): 今日時点で退職済みか判定
 *
 * @param retired   YYYY-MM-DD 形式の退職日
 * @param todayIso  YYYY-MM-DD 形式の今日の日付（省略時は new Date() を使用）
 */
export function isAlreadyRetired(
  retired: string | undefined | null,
  todayIso?: string,
): boolean {
  if (!retired) return false  // 退職予定なし
  // 2026-10-02 総合点検: 古いデータの retired: 'true'（文字列・真偽値）は退職済み。
  //   旧: 'true' < '2026-10-02' が偽になり、ずっと在籍扱い（ログイン・合言葉・通知の対象に残っていた）
  if (!retiredDateOf(retired)) return true
  const today = todayIso || todayJstIso()  // 既定は日本時間の今日（UTCだとJST朝に1日ズレる）
  return retired < today
}

/**
 * 退職日が 'YYYY-MM-DD' の形ならその日付、そうでなければ null（2026-10-02 総合点検）。
 * 古いデータには retired: 'true' や true が残っていることがあり、日付として比べると必ず「在籍」になる。
 * 退職の判定（isAlreadyRetired / isStillActiveForMonth / isEmployedOn）は必ずこれを通して形を確かめる。
 */
export function retiredDateOf(retired: unknown): string | null {
  return typeof retired === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(retired) ? retired : null
}

/**
 * 道具代管理の対象者判定（2026-08-28 に日本人へ拡大）
 *
 * - 外国人（技能実習・特定技能）… 従来から対象
 * - 日本人の現場スタッフ（visa 無し/none で、役員・事務を除く）… 2026-08-28 追加
 * - 今日時点で退職済みは除外（退職「予定」日が未来なら在職中扱い）
 *
 * tool-budget API と スタッフスマホ画面の道具代カードの両方がこれを使う。
 * 判定を変えるときはここだけ直す。
 */
export function isToolBudgetEligible(w: {
  visa?: string | null
  job?: string | null
  retired?: string | null
  hireDate?: string | null
}, todayIso?: string): boolean {
  // 2026-10-02 総合点検: 引数の todayIso を退職判定に渡していなかった（基準日を指定しても「今日」で判定していた）
  if (isAlreadyRetired(w.retired, todayIso)) return false
  const visa = w.visa || 'none'
  if (visa.startsWith('jisshu') || visa.startsWith('tokutei')) return true
  if (visa === 'none') {
    // 役員・事務は対象外
    if (w.job === 'yakuin' || w.job === 'jimu') return false
    // 2026-08-31 代表決定: 日本人は**入社6ヶ月未満は対象外**。
    //   有給の初回付与（入社6ヶ月後）と発生タイミングを揃える。
    //   入社日が未登録の人は判定できないので対象に含める（従来どおり）。
    if (w.hireDate) {
      const today = todayIso || todayJstIso()
      if (today < addMonthsSafe(w.hireDate, TOOL_BUDGET_JP_MIN_MONTHS)) return false
    }
    return true
  }
  return false
}

/** 日本人の道具代が発生するまでの在籍月数（有給の初回付与と同じ6ヶ月） */
export const TOOL_BUDGET_JP_MIN_MONTHS = 6

/** 日本人の道具代が発生する日（入社6ヶ月後）。未登録なら null */
export function toolBudgetStartFor(hireDate?: string | null): string | null {
  return hireDate ? addMonthsSafe(hireDate, TOOL_BUDGET_JP_MIN_MONTHS) : null
}

/**
 * 区分別の既定予算から、そのスタッフの道具代既定額を返す（2026-08-28 追加）。
 *
 * 優先順位:
 *   外国人 … budgetByVisa[visaコード完全一致] → budgetByVisa['jisshu'/'tokutei'（区分まとめ）] → 既定額
 *   日本人 … budgetByJob[職種] → 既定額
 * 個別に setBudget した期間レコードがある場合はそちらが優先（呼び出し側で record?.budget ?? これ）。
 */
export function toolBudgetDefaultFor(
  w: { visa?: string | null; job?: string | null },
  cfg: {
    defaultBudget?: number
    budgetByVisa?: Record<string, number>
    budgetByJob?: Record<string, number>
  },
): number {
  const fallback = cfg.defaultBudget || 30000
  const visa = w.visa || 'none'
  if (visa !== 'none') {
    const group = visa.startsWith('jisshu') ? 'jisshu' : visa.startsWith('tokutei') ? 'tokutei' : ''
    return cfg.budgetByVisa?.[visa] ?? (group ? cfg.budgetByVisa?.[group] : undefined) ?? fallback
  }
  return cfg.budgetByJob?.[w.job || ''] ?? fallback
}

/**
 * カレンダー署名対象スタッフ判定の共通述語（2026-05-27 追加）
 *
 * 「外国人 × トークン保有 × 当該月在籍 × 当該月全期間帰国でない」の条件を
 * 一箇所に集約。以前は3 つの API ルート (status / public-sites / sign-self) で
 * 微妙に違う条件を書いていたためズレが発生しやすかった。
 *
 * ⚠️ **「トークンを持っている＝ベトナム人」は成り立たない**（2026-09-02 事故）。
 *   日本人スタッフにマイページ用トークンを発行した途端、`!!w.token` だけで
 *   判定していた通知・公開ページが日本人9名を「未署名」に数えた。署名は
 *   変形労働時間制（外国人のみ）の周知・同意なので、visa の判定が必須。
 *   新しい呼び出し箇所を書くときは必ずこの述語を通すこと。
 *
 * @param worker  Firestore raw worker（`visa`）でも Worker 型（`visaType`）でも可
 * @param ym      "YYYY-MM" or "YYYYMM"
 * @param fullMonthHomeLeaveWorkerIds  当該月全期間帰国中のスタッフ ID 集合
 */
export function isCalendarSignTarget(
  worker: { id: number; visa?: string; visaType?: string; token?: string; retired?: string; hireDate?: string },
  ym: string,
  fullMonthHomeLeaveWorkerIds: Set<number>,
): boolean {
  if (!worker.token) return false
  // raw worker は visa、Worker 型は visaType と名前が違うので両方を受ける
  const visa = worker.visa ?? worker.visaType
  if (!visa || visa === 'none') return false  // 日本人は対象外
  if (!isStillActiveForMonth(worker.retired, ym)) return false
  // 入社前の月は署名対象外（2026-09-21）。旧: 入社日を見ておらず、8/1 入社のフォン・タンが
  //   7月の「未署名 2名」として全体状況に出続けていた。入社日が未登録の人は従来どおり対象
  if (!isHiredByMonth(worker.hireDate, ym)) return false
  if (fullMonthHomeLeaveWorkerIds.has(worker.id)) return false
  return true
}

/**
 * その月（'YYYYMM'）の給与計算に使う日額（2026-09-03 追加・年次改定の適用開始日対応）。
 *
 * 年次改定（基準日 10/1）を 9 月中に確定すると人員マスタの rate は新額になるが、
 * 9 月分の給与は改定前の日額で計算しなければならない。確定時に rateFrom（適用開始日）と
 * prevRate（直前の日額）を一緒に書き、基準日より前の月は prevRate を返す。
 * rateFrom が無い（改定履歴の無い）人は従来どおり rate。
 */
export function effectiveRateForYm(
  w: { rate?: number; rateFrom?: string; prevRate?: number },
  ym: string,
): number {
  if (w.rateFrom && w.prevRate != null && /^\d{4}-\d{2}-\d{2}$/.test(w.rateFrom)) {
    const fromYm = w.rateFrom.slice(0, 4) + w.rateFrom.slice(5, 7)
    if (ym.replace('-', '') < fromYm) return w.prevRate
  }
  return w.rate || 0
}

/**
 * その月の給与計算に使う時給（2026-09-10 追加・時給の適用開始日対応）。
 *
 * - 適用開始日より前の月 … prevHourlyRate
 * - 適用開始日を含む月 … **暦日按分**した時給（中途入退社の日割りと同じ考え方。
 *   基本給が「時給×20日×7h」の月額固定なので日単位では分けられない）
 *   例: 9/21 に 1,425→1,585 なら (1,425×20日 + 1,585×10日) ÷ 30日 = 1,478.33
 * - 適用開始日以降の月 … hourlyRate
 * hourlyRateFrom が無い人は従来どおり hourlyRate。
 */
export function effectiveHourlyRateForYm(
  w: { hourlyRate?: number; hourlyRateFrom?: string; prevHourlyRate?: number },
  ym: string,
): number | undefined {
  const cur = w.hourlyRate
  if (!w.hourlyRateFrom || w.prevHourlyRate == null || !/^\d{4}-\d{2}-\d{2}$/.test(w.hourlyRateFrom)) return cur
  const y = Number(ym.slice(0, 4)); const m = Number(ym.replace('-', '').slice(4, 6))
  const fromY = Number(w.hourlyRateFrom.slice(0, 4)); const fromM = Number(w.hourlyRateFrom.slice(5, 7)); const fromD = Number(w.hourlyRateFrom.slice(8, 10))
  if (y < fromY || (y === fromY && m < fromM)) return w.prevHourlyRate
  if (y > fromY || (y === fromY && m > fromM)) return cur
  // 同じ月: 暦日按分
  const dim = new Date(y, m, 0).getDate()
  const daysBefore = Math.max(0, Math.min(dim, fromD - 1))
  const blended = ((w.prevHourlyRate * daysBefore) + ((cur || 0) * (dim - daysBefore))) / dim
  return Math.round(blended * 100) / 100
}

/**
 * その月の給与計算に使う固定月給（2026-09-14 追加）。考え方は effectiveHourlyRateForYm と同じ。
 * - 適用開始日より前の月 … prevSalary
 * - 適用開始日を含む月 … 暦日按分（円未満切り上げ）
 * - 適用開始日以降の月 … salary
 */
export function effectiveSalaryForYm(
  w: { salary?: number; salaryFrom?: string; prevSalary?: number },
  ym: string,
): number | undefined {
  const cur = w.salary
  if (!w.salaryFrom || w.prevSalary == null || !/^\d{4}-\d{2}-\d{2}$/.test(w.salaryFrom)) return cur
  const y = Number(ym.slice(0, 4)); const m = Number(ym.replace('-', '').slice(4, 6))
  const fromY = Number(w.salaryFrom.slice(0, 4)); const fromM = Number(w.salaryFrom.slice(5, 7)); const fromD = Number(w.salaryFrom.slice(8, 10))
  if (y < fromY || (y === fromY && m < fromM)) return w.prevSalary
  if (y > fromY || (y === fromY && m > fromM)) return cur
  const dim = new Date(y, m, 0).getDate()
  const daysBefore = Math.max(0, Math.min(dim, fromD - 1))
  return Math.ceil(((w.prevSalary * daysBefore) + ((cur || 0) * (dim - daysBefore))) / dim)
}

/**
 * 指定日時点で有効な時給（月の按分をしない「その日の時給」）。2026-09-14 追加。
 * 賃金分析など「今いくらか」を見る画面用。給与計算は effectiveHourlyRateForYm を使う。
 */
export function hourlyRateOn(
  w: { hourlyRate?: number; hourlyRateFrom?: string; prevHourlyRate?: number },
  dateIso: string,
): number | undefined {
  if (w.hourlyRateFrom && w.prevHourlyRate != null && dateIso < w.hourlyRateFrom) return w.prevHourlyRate
  return w.hourlyRate
}

