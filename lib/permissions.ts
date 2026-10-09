/**
 * 役割ごとの権限（2026-09-26・代表決定）。**権限の決まりはこのファイルだけ**。
 *
 * メニュー（components/Sidebar.tsx）・画面のボタン・サーバーのチェック（lib/auth.ts の requireCap）・
 * 設定画面の権限表は、すべてここを読む。旧実装はメニューの roles・MENU_ID_MAP・設定の
 * ALL_MENUS/DEFAULT_PERMISSIONS（Firestore rolePermissions で上書き可）の3か所がばらばらで食い違っていた。
 *
 * 原則（CLAUDE.md「承認フローの原則」）:
 *   現場の作業は職長、事務処理は事務、最終承認は事業責任者（政仁さん）、システムは代表。
 *   政仁さん以外の役員は事業責任者と同じものを「見るだけ」（承認・確定はしない）。
 *   賃金（時給・号俸・日額）の直接の書き換えは代表だけ。事業責任者は評価の承認・号俸の改定を通して決める。
 *
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */

/** 権限の判定に使う役割 */
export type PermRole = 'owner' | 'approver' | 'officer' | 'jimu' | 'foreman'

export const PERM_ROLE_LABEL: Record<PermRole, string> = {
  owner: '代表',
  approver: '事業責任者',
  officer: '役員',
  jimu: '事務',
  foreman: '職長',
}

export const PERM_ROLES: PermRole[] = ['foreman', 'jimu', 'approver', 'officer', 'owner']

/**
 * ログインユーザー（AuthUser.role / workerId）から権限上の役割を出す。
 * - 'admin' は代表（super-admin・workerId 0）だけ。職種「役員」は 'officer'（lib/auth.ts buildAuthUser）
 */
export function permRoleOf(user: { role?: string | null; workerId?: number | null } | null | undefined): PermRole | null {
  if (!user?.role) return null
  switch (user.role) {
    case 'admin': case 'super-admin': return 'owner'
    case 'approver': return 'approver'
    case 'officer': return 'officer'
    case 'jimu': return 'jimu'
    case 'foreman': return 'foreman'
    default: return null
  }
}

const ALL_OFFICE: PermRole[] = ['jimu', 'approver', 'officer', 'owner']
const VIEWERS: PermRole[] = ['approver', 'officer', 'owner']
/**
 * 個人の給与（時給・日額・月給・支給額・昇給額）に関わる権限の役割（2026-10-02 代表）。
 * 給与を見られるのは 代表（靖仁さん）・事業責任者（政仁さん）・事務（森田さん）だけ。役員（officer）・職長は外す。
 * さらに役割だけでなく本人も確かめる（PAY_VIEWER_WORKER_IDS）＝二重の鍵。事務の役割は奥寺さん・佐藤さんにも付くため
 */
const PAY_ROLES: PermRole[] = ['jimu', 'approver', 'owner']

/**
 * できること → できる役割。label は設定画面の権限表にそのまま出る。
 * group は権限表の見出し。担当現場の制限（職長は自分の現場だけ）は各 API が別途チェックする。
 */
export const CAPABILITIES = {
  // ── 毎日 ──
  'dashboard.view':          { group: '毎日', label: 'ダッシュボード', roles: ALL_OFFICE },
  'attendance.view':         { group: '毎日', label: '出面を見る', roles: ['foreman', ...ALL_OFFICE] },
  // 事務は入力漏れのフォローと過去日の修正（docs/manual-morita.md §3-1）。職長承認は職長が担当現場で行う
  'attendance.input':        { group: '毎日', label: '出面の入力（職長は担当現場・事務は漏れのフォローと修正）', roles: ['foreman', 'jimu', 'owner'] },
  'attendance.foremanApprove': { group: '毎日', label: '出面の職長承認（担当現場）', roles: ['foreman', 'owner'] },
  // 2026-10-02 代表決定: 昨日までの日の出面を、さかのぼって入力・修正できる（代表と事業責任者＝政仁さん）。
  //   本人のスマホ入力が無い日の出勤も入れられる（外国人スタッフの「出勤は本人の申告から」canAdminEditEntry の例外）。
  //   政仁さんは attendance.input を持たないが、昨日までの日なら入力のある日の上書き・削除もできる（同日 代表判断で広げた）。当日は本人と職長
  'attendance.backfill':     { group: '毎日', label: '昨日までの出面を、さかのぼって入力・修正（本人の入力が無い日の出勤も）', roles: ['approver', 'owner'] },
  // 工種（鉄骨・仮設など）の決定は職長と事業責任者（代表決定 2026-09-28）。スタッフ本人には選ばせない
  'attendance.inputSupport': { group: '毎日', label: '応援現場の出面の入力・職長承認（一括入力・配置・運転の記録）', roles: ['approver', 'owner'] },
  'attendance.workType':     { group: '毎日', label: '出面の工種（鉄骨・仮設など）の切り替え・日ごとの工種指定', roles: ['foreman', 'jimu', 'approver', 'owner'] },
  'attendance.history':      { group: '毎日', label: '出面の変更履歴を見る・復元', roles: ['jimu', 'approver', 'owner'] },
  'attendance.finalApprove': { group: '毎日', label: '出面の最終承認', roles: ['approver', 'owner'] },
  // 2026-10-01 代表: 職長でない人が現場の職長に登録されている現場は、政仁さんが職長承認を代行する
  'attendance.foremanApproveProxy': { group: '毎日', label: '職長がいない現場（職長でない人が登録）の出面の職長承認（代行）', roles: ['approver', 'owner'] },
  // ── 毎月 ──
  'calendar.view':           { group: '毎月', label: '就業カレンダーを見る', roles: ['foreman', ...VIEWERS] },
  'calendar.edit':           { group: '毎月', label: '就業カレンダーの作成・提出（担当現場）', roles: ['foreman', 'owner'] },
  'calendar.approve':        { group: '毎月', label: '就業カレンダーの承認', roles: ['approver', 'owner'] },
  'leave.view':              { group: '毎月', label: '休暇管理を見る', roles: ALL_OFFICE },
  'leave.foremanApprove':    { group: '毎月', label: '有給・帰国申請の職長承認（担当現場）', roles: ['foreman', 'approver', 'owner'] },
  'leave.finalApprove':      { group: '毎月', label: '有給・帰国申請の最終承認', roles: ['approver', 'owner'] },
  'leave.manage':            { group: '毎月', label: '有給の付与・時季指定・買取の記録', roles: ['jimu', 'approver', 'owner'] },
  // 2026-09-26 代表: 帰国情報は森田さんも補助的に登録・変更（復帰日の登録を含む）。削除は事業責任者・代表だけ
  'homeLeave.edit':          { group: '毎月', label: '帰国情報の登録・変更・復帰日の登録', roles: ['jimu', 'approver', 'owner'] },
  'homeLeave.delete':        { group: '毎月', label: '帰国情報の削除・残っている帰国表示の整理', roles: ['approver', 'owner'] },
  'monthly.view':            { group: '毎月', label: '月次集計・帳票を見る（給与を含む）', roles: PAY_ROLES },
  'monthly.close':           { group: '毎月', label: '月次の締め・帳票出力', roles: ['jimu', 'approver', 'owner'] },
  'invoice.view':            { group: '毎月', label: '請求書・支払を見る', roles: ALL_OFFICE },
  // 2026-10-02 総合点検: 代表・事業責任者も申請できる（直接発行できる人が申請を止められる理由が無い。API の実装と表をそろえた）
  'invoice.request':         { group: '毎月', label: '請求書の発行を申請・取り下げ', roles: ['jimu', 'approver', 'owner'] },
  'invoice.approve':         { group: '毎月', label: '請求書の承認・発行・取り消し', roles: ['approver', 'owner'] },
  // 2026-10-02 代表: 応援の請求書はしばらく手作り。手作りの請求書を入れて、システムの計算と見比べる（lib/paper-invoice.ts）。削除は invoice.approve
  'invoice.paper':           { group: '毎月', label: '紙（手作り）で出した請求書の登録・修正', roles: ['jimu', 'approver', 'owner'] },
  // 2026-10-05 代表: 外注から紙で届く請求書を DEDURA＋ に入れて共有する（今は代表、数か月後から森田さん。lib/subcon-invoice.ts）。削除は invoice.approve
  'invoice.subcon':          { group: '毎月', label: '受け取った外注の請求書の登録・修正', roles: ['jimu', 'approver', 'owner'] },
  // ── 経営 ──
  'cost.view':               { group: '経営', label: '原価・収益を見る（人件費を含む）', roles: PAY_ROLES },
  'cost.edit':               { group: '経営', label: '現場の請求額を入力', roles: ['jimu', 'approver', 'owner'] },
  'cockpit.view':            { group: '経営', label: '経営コックピット', roles: ['owner'] },
  // ── 人・賃金 ──
  'workers.view':            { group: '人・賃金', label: '人員マスタを見る', roles: ALL_OFFICE },
  'workers.edit':            { group: '人・賃金', label: '人員マスタの基本情報・電話URL', roles: ['jimu', 'owner'] },
  'workers.editPay':         { group: '人・賃金', label: '給与欄（時給・号俸・日額など）を直接書き換え', roles: ['owner'] },
  'toolBudget.view':         { group: '人・賃金', label: '道具代を見る', roles: ALL_OFFICE },
  'toolBudget.edit':         { group: '人・賃金', label: '道具代の登録', roles: ['jimu', 'owner'] },
  'evaluation.input':        { group: '人・賃金', label: '評価の入力', roles: ['foreman', 'approver', 'owner'] },
  'pay.view':                { group: '人・賃金', label: '個人の給与（時給・日額・月給・支給額）を見る', roles: PAY_ROLES },
  'wage.view':               { group: '人・賃金', label: '賃金・評価を見る', roles: ['approver', 'owner'] },
  'wage.decide':             { group: '人・賃金', label: '評価の承認・号俸の改定・賞与の確定', roles: ['approver', 'owner'] },
  'wageAnalysis.view':       { group: '人・賃金', label: '賃金分析', roles: ['owner'] },
  // 書類庫（在留カード・雇用契約書など）。機微な個人情報なので職長・役員には見せない（代表 2026-09-28）
  'staffDocs.view':          { group: '人・賃金', label: '書類庫を見る（在留カード・契約書など）', roles: ['jimu', 'approver', 'owner'] },
  'staffDocs.edit':          { group: '人・賃金', label: '書類庫への登録・旧版への切り替え', roles: ['jimu', 'approver', 'owner'] },
  'staffDocs.delete':        { group: '人・賃金', label: '書類庫の書類の削除', roles: ['owner'] },
  // ── マスタ ──
  'masters.view':            { group: 'マスタ', label: '現場・取引先マスタを見る', roles: ALL_OFFICE },
  'masters.edit':            { group: 'マスタ', label: '現場・取引先マスタの編集', roles: ['jimu', 'owner'] },
  // 運転手当を出さない現場の指定（ごく近い現場など）は代表と事業責任者の判断（代表 2026-09-30）
  'sites.noDriveAllowance':  { group: 'マスタ', label: '運転手当を出さない現場の指定', roles: ['approver', 'owner'] },
  // ── 管理 ──
  'system.admin':            { group: '管理', label: 'システム設定・パスワード・バックアップ・アクセス履歴', roles: ['owner'] },
  'docs.view':               { group: '管理', label: '資料一覧', roles: ['foreman', ...ALL_OFFICE] },
  // 困ったこと・要望（2026-10-09 代表）。書けるのはログインしている人全員（見られるのは自分の書き込みだけ）。全部を見て返信・状態を変えるのは代表
  'feedback.post':           { group: '管理', label: '困ったこと・要望を書く（自分の書き込みを見る・返信する）※試験運用中は森田さん・代表だけ', roles: ['foreman', ...ALL_OFFICE] },
  'feedback.manage':         { group: '管理', label: '困ったこと・要望を全部見る・返信する・状態を変える', roles: ['owner'] },
} as const satisfies Record<string, { group: string; label: string; roles: readonly PermRole[] }>

export type Capability = keyof typeof CAPABILITIES

export function roleCan(role: PermRole | null, cap: Capability): boolean {
  if (!role) return false
  return (CAPABILITIES[cap].roles as readonly PermRole[]).includes(role)
}

/**
 * 給与を見られる本人（2026-10-02 代表「僕と政仁と森田以外は見られないように」）。
 * 0 = 日比靖仁（代表・代表パスワードのログインも workerId 0）／ 1 = 日比政仁（事業責任者）／ 303 = 森田陽子（事務）。
 * ⚠️ 人を足すときは代表の指示があるときだけ。役割（PAY_ROLES）と本人（ここ）の両方がそろわないと給与は見えない
 */
export const PAY_VIEWER_WORKER_IDS: readonly number[] = [0, 1, 303]

/** 個人の給与が見える権限（役割に加えて本人も確かめる）。画面の鍵・API の鍵の両方がこれを使う */
export const PAY_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'pay.view', 'monthly.view', 'monthly.close', 'cost.view', 'cost.edit',
  'wage.view', 'wage.decide', 'wageAnalysis.view', 'workers.editPay', 'cockpit.view',
  // スタッフのスマホURL（token）で本人のページを開くと、欠勤控除の日額（時給×7）などが見える。
  //   URL を扱える人員マスタの編集も3人だけにする（2026-10-02 総点検: 奥寺さん・佐藤さんが時給を逆算できた）
  'workers.edit',
  // 書類庫には雇用契約書（賃金が書いてある）がある。見る・入れる・消すも3人だけ（代表 2026-09-28 の決まりどおり）
  'staffDocs.view', 'staffDocs.edit', 'staffDocs.delete',
])

export const isPayViewerId = (workerId: unknown): boolean =>
  typeof workerId === 'number' && PAY_VIEWER_WORKER_IDS.includes(workerId)

/**
 * 「困ったこと・要望」の試験運用（2026-10-09 代表「まずは森田さんと靖仁だけに開放して試験運用」）。
 * 0 = 日比靖仁（代表）／ 303 = 森田陽子（事務）。ここにいない人には、メニュー・画面・API・件数のどれにも出さない。
 * 全員に開くときは null にする（そのとき lib/release-notes.ts にお知らせを足す）
 */
export const FEEDBACK_PILOT_WORKER_IDS: readonly number[] | null = [0, 303]
const FEEDBACK_CAPS: ReadonlySet<Capability> = new Set<Capability>(['feedback.post', 'feedback.manage'])

/** 役割と本人（給与の権限・試験運用中の機能のときだけ）の両方で判定する。サーバーは lib/auth.ts の requireCap / callerCan が同じ判定 */
export function capAllowed(role: PermRole | null, workerId: unknown, cap: Capability): boolean {
  if (!roleCan(role, cap)) return false
  if (PAY_CAPS.has(cap) && !isPayViewerId(workerId)) return false
  if (FEEDBACK_CAPS.has(cap) && FEEDBACK_PILOT_WORKER_IDS
    && !(typeof workerId === 'number' && FEEDBACK_PILOT_WORKER_IDS.includes(workerId))) return false
  return true
}

/** 画面用: ログインユーザーがそのことをできるか */
export function can(user: Parameters<typeof permRoleOf>[0], cap: Capability): boolean {
  return capAllowed(permRoleOf(user), user?.workerId, cap)
}
