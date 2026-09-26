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
  'attendance.history':      { group: '毎日', label: '出面の変更履歴を見る・復元', roles: ['jimu', 'approver', 'owner'] },
  'attendance.finalApprove': { group: '毎日', label: '出面の最終承認', roles: ['approver', 'owner'] },
  // ── 毎月 ──
  'calendar.view':           { group: '毎月', label: '就業カレンダーを見る', roles: ['foreman', ...VIEWERS] },
  'calendar.edit':           { group: '毎月', label: '就業カレンダーの作成・提出（担当現場）', roles: ['foreman', 'owner'] },
  'calendar.approve':        { group: '毎月', label: '就業カレンダーの承認', roles: ['approver', 'owner'] },
  'leave.view':              { group: '毎月', label: '休暇管理を見る', roles: ALL_OFFICE },
  'leave.foremanApprove':    { group: '毎月', label: '有給・帰国申請の職長承認（担当現場）', roles: ['foreman', 'approver', 'owner'] },
  'leave.finalApprove':      { group: '毎月', label: '有給・帰国申請の最終承認', roles: ['approver', 'owner'] },
  'leave.manage':            { group: '毎月', label: '有給の付与・時季指定・買取の記録', roles: ['jimu', 'approver', 'owner'] },
  'monthly.view':            { group: '毎月', label: '月次集計・帳票を見る', roles: ALL_OFFICE },
  'monthly.close':           { group: '毎月', label: '月次の締め・帳票出力', roles: ['jimu', 'approver', 'owner'] },
  'invoice.view':            { group: '毎月', label: '請求書・支払を見る', roles: ALL_OFFICE },
  'invoice.request':         { group: '毎月', label: '請求書の発行を申請', roles: ['jimu'] },
  'invoice.approve':         { group: '毎月', label: '請求書の承認・発行・取り消し', roles: ['approver', 'owner'] },
  // ── 経営 ──
  'cost.view':               { group: '経営', label: '原価・収益を見る', roles: ALL_OFFICE },
  'cost.edit':               { group: '経営', label: '現場の請求額を入力', roles: ['jimu', 'approver', 'owner'] },
  'cockpit.view':            { group: '経営', label: '経営コックピット', roles: ['owner'] },
  // ── 人・賃金 ──
  'workers.view':            { group: '人・賃金', label: '人員マスタを見る', roles: ALL_OFFICE },
  'workers.edit':            { group: '人・賃金', label: '人員マスタの基本情報・電話URL', roles: ['jimu', 'owner'] },
  'workers.editPay':         { group: '人・賃金', label: '給与欄（時給・号俸・日額など）を直接書き換え', roles: ['owner'] },
  'toolBudget.view':         { group: '人・賃金', label: '道具代を見る', roles: ALL_OFFICE },
  'toolBudget.edit':         { group: '人・賃金', label: '道具代の登録', roles: ['jimu', 'owner'] },
  'evaluation.input':        { group: '人・賃金', label: '評価の入力', roles: ['foreman', 'approver', 'owner'] },
  'wage.view':               { group: '人・賃金', label: '賃金・評価を見る', roles: VIEWERS },
  'wage.decide':             { group: '人・賃金', label: '評価の承認・号俸の改定・賞与の確定', roles: ['approver', 'owner'] },
  'wageAnalysis.view':       { group: '人・賃金', label: '賃金分析', roles: ['owner'] },
  // ── マスタ ──
  'masters.view':            { group: 'マスタ', label: '現場・取引先マスタを見る', roles: ALL_OFFICE },
  'masters.edit':            { group: 'マスタ', label: '現場・取引先マスタの編集', roles: ['jimu', 'owner'] },
  // ── 管理 ──
  'system.admin':            { group: '管理', label: 'システム設定・パスワード・バックアップ・アクセス履歴', roles: ['owner'] },
  'docs.view':               { group: '管理', label: '資料一覧', roles: ['foreman', ...ALL_OFFICE] },
} as const satisfies Record<string, { group: string; label: string; roles: readonly PermRole[] }>

export type Capability = keyof typeof CAPABILITIES

export function roleCan(role: PermRole | null, cap: Capability): boolean {
  if (!role) return false
  return (CAPABILITIES[cap].roles as readonly PermRole[]).includes(role)
}

/** 画面用: ログインユーザーがそのことをできるか */
export function can(user: Parameters<typeof permRoleOf>[0], cap: Capability): boolean {
  return roleCan(permRoleOf(user), cap)
}
