/**
 * 画面ごとに必要な権限（2026-10-02・代表「職長に給与の画面は見せない。お互いの給与が見えるとまずい」）。
 *
 * 旧: メニューは権限で出し分けていたが、画面そのものには鍵が無く（app/(app)/layout.tsx はログイン済みかだけを確認）、
 *     職長でも URL を打てば人員マスタ・賃金・月次集計などの画面を開けた（中身は API が止めていたが、給与の一部が漏れていた）。
 * 新: app/(app) の全画面をここに並べ、必要な権限（どれか1つ）が無い人には画面を出さない。
 *     新しい画面を足したら、ここにも1行足すこと（__tests__/pageGuard.test.ts が足し忘れを落とす）。
 * 権限の中身は lib/permissions.ts が唯一の決まり。API 側の権限チェック（requireCap）はこれとは別に必ず行う。
 */
import type { Capability } from './permissions'

/** null = ログインしていれば誰でも（廃止した画面の転送だけのページなど） */
export const PAGE_CAPS: { path: string; caps: Capability[] | null }[] = [
  { path: '/dashboard', caps: ['dashboard.view'] },
  { path: '/attendance', caps: ['attendance.view'] },
  { path: '/calendar', caps: ['calendar.view'] },
  { path: '/leave', caps: ['leave.view'] },
  { path: '/monthly', caps: ['monthly.view'] },
  { path: '/peer-statement', caps: ['invoice.view'] },
  { path: '/peer-invoice', caps: ['invoice.view'] },
  { path: '/paper-invoice', caps: ['invoice.view'] },
  { path: '/subcon-invoice', caps: ['invoice.view'] },
  { path: '/cost', caps: ['cost.view'] },
  { path: '/workers', caps: ['workers.view'] },
  { path: '/staff-docs', caps: ['staffDocs.view'] },
  { path: '/tool-budget', caps: ['toolBudget.view'] },
  { path: '/compensation', caps: ['wage.view'] },
  { path: '/wage-analysis', caps: ['wageAnalysis.view'] },
  { path: '/wage', caps: ['wage.view'] },
  // 職長は「評価入力」タブだけ（他のタブは画面と API が別に止める）
  { path: '/evaluation', caps: ['evaluation.input', 'wage.view'] },
  { path: '/sites', caps: ['masters.view'] },
  { path: '/subcons', caps: ['masters.view'] },
  { path: '/settings', caps: ['system.admin'] },
  { path: '/access-log', caps: ['system.admin'] },
  { path: '/debug-att', caps: ['system.admin'] },
  { path: '/docs', caps: ['docs.view'] },
  // 廃止した画面（転送先の画面がそれぞれ止める）
  { path: '/guide', caps: null },
]

/**
 * その画面に必要な権限（どれか1つ）。null は誰でも。
 * 一覧に無い画面は、職長に見せない側に倒す（事務・役員以上＝dashboard.view と同じ）。
 */
export function requiredCapsForPath(pathname: string): Capability[] | null {
  const hit = PAGE_CAPS
    .filter(p => pathname === p.path || pathname.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return hit ? hit.caps : ['dashboard.view']
}
