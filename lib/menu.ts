/**
 * サイドメニューとメニュー検索（2026-09-26・メニュー見直し）。
 *
 * 並びは「いつ使うか」の順（毎日 → 毎月 → 経営 → 人・賃金 → マスタ → 管理）。
 * 誰に見せるかは lib/permissions.ts の権限（cap）だけで決める（メニュー側に役割を書かない）。
 *
 * SEARCH_ENTRIES はメニュー検索用。画面の中のタブ・機能まで直接飛べるようにする
 * （「どこにあったっけ」を無くすため）。画面やタブを足したら、ここにも1行足すこと。
 */
import type { Capability } from './permissions'

export interface MenuItem {
  label: string
  icon: string
  href?: string
  external?: string
  section: string
  cap: Capability
  /** 同じ画面の別 URL（?tab= 等）もこの項目を選択中にする */
  activePrefixes?: string[]
}

export const MENU_SECTIONS = ['毎日', '毎月', '経営', '人・賃金', 'マスタ', '管理'] as const

export const MENU_ITEMS: MenuItem[] = [
  // ── 毎日 ──
  { label: 'ダッシュボード', icon: '📊', href: '/dashboard', section: '毎日', cap: 'dashboard.view' },
  // PC 版とスマホ版は画面の中で切り替える（両方から相互リンクあり）。メニューは1つ
  { label: '出面入力', icon: '📋', href: '/attendance', section: '毎日', cap: 'attendance.view', activePrefixes: ['/attendance/mobile'] },
  // ── 毎月 ──
  { label: '就業カレンダー', icon: '📅', href: '/calendar', section: '毎月', cap: 'calendar.view' },
  { label: '月次集計・締め', icon: '🗓', href: '/monthly', section: '毎月', cap: 'monthly.view' },
  { label: '帳票出力', icon: '📑', href: '/monthly?tab=export', section: '毎月', cap: 'monthly.view' },
  { label: '休暇管理', icon: '🌴', href: '/leave', section: '毎月', cap: 'leave.view' },
  { label: '請求書・支払', icon: '🧾', href: '/peer-statement', section: '毎月', cap: 'invoice.view', activePrefixes: ['/peer-invoice'] },
  // ── 経営 ──
  { label: '原価・収益', icon: '💰', href: '/cost', section: '経営', cap: 'cost.view' },
  // 経営コックピットと一体で使う（現場別の粗利・外注の照合・資金繰りは向こうで見る）
  { label: '経営コックピット', icon: '📈', external: 'https://keieidashboard.vercel.app/genba', section: '経営', cap: 'cockpit.view' },
  // ── 人・賃金 ──
  { label: '人員マスタ', icon: '👷', href: '/workers', section: '人・賃金', cap: 'workers.view' },
  // 評価管理・昇給履歴・賃金制度・賃金分析はハブで国籍別に分岐
  { label: '賃金・評価', icon: '💴', href: '/compensation', section: '人・賃金', cap: 'wage.view', activePrefixes: ['/wage', '/evaluation', '/wage-analysis'] },
  // 職長の評価入力の入口（ハブは職長には見せない）。通知ベルの「評価入力をお願いします」もここから
  { label: '評価入力', icon: '📝', href: '/evaluation', section: '人・賃金', cap: 'evaluation.input' },
  { label: '道具代管理', icon: '🔧', href: '/tool-budget', section: '人・賃金', cap: 'toolBudget.view' },
  // ── マスタ ──
  { label: '現場マスタ', icon: '🏗', href: '/sites', section: 'マスタ', cap: 'masters.view' },
  { label: '取引先マスタ', icon: '🏢', href: '/subcons', section: 'マスタ', cap: 'masters.view' },
  // ── 管理 ──
  // 会社・請求書／単価の既定値／ログイン・権限／お知らせ／バックアップ・履歴（アクセス履歴もここから）
  { label: '管理者設定', icon: '⚙️', href: '/settings', section: '管理', cap: 'system.admin', activePrefixes: ['/access-log'] },
  { label: '資料一覧', icon: '📁', href: '/docs', section: '管理', cap: 'docs.view' },
]

export interface SearchEntry {
  /** 検索結果に出す名前 */
  label: string
  /** どの画面のどこか（結果の2行目） */
  where: string
  href: string
  cap: Capability
  /** ひらがな・別名・よく使う言い方 */
  keywords?: string
}

/** 画面の中のタブ・機能への近道（メニュー項目そのものも検索対象に自動で入る） */
export const SEARCH_ENTRIES: SearchEntry[] = [
  // 出面
  { label: 'スマホ版の出面入力', where: '出面入力', href: '/attendance/mobile', cap: 'attendance.view', keywords: 'すまほ モバイル 携帯' },
  { label: '出面の変更履歴・復元', where: '出面入力 → 変更履歴', href: '/attendance', cap: 'attendance.history', keywords: 'りれき 戻す 誤削除 上書き' },
  { label: '出面データ確認ツール', where: '保守（代表のみ）', href: '/debug-att', cap: 'system.admin', keywords: 'でばっぐ 修正 移し替え' },
  // 月次・帳票
  { label: '月締め（ロック）', where: '月次集計・締め', href: '/monthly', cap: 'monthly.close', keywords: 'しめ ろっく 締め 解除' },
  { label: '所定日数', where: '月次集計・締め', href: '/monthly', cap: 'monthly.view', keywords: 'しょていにっすう' },
  { label: 'キャシュモ提出（月次集計Excel・計算根拠PDF）', where: '帳票出力', href: '/monthly?tab=export', cap: 'monthly.view', keywords: 'きゃしゅも 社労士 給与 excel pdf' },
  { label: '出面一覧・勤務予定シフト・実労働時間明細', where: '帳票出力 → 根拠書類', href: '/monthly?tab=export', cap: 'monthly.view', keywords: 'しゅつづら しふと' },
  { label: '外注先向け 出面確認書', where: '帳票出力 → 社内用', href: '/monthly?tab=export', cap: 'monthly.view', keywords: 'がいちゅう 確認書' },
  { label: '歩掛管理表', where: '帳票出力 → 社内用', href: '/monthly?tab=export', cap: 'monthly.view', keywords: 'ぶがかり' },
  { label: '有給管理台帳（Excel）', where: '休暇管理 → 管理簿出力', href: '/leave', cap: 'leave.view', keywords: 'ゆうきゅう 台帳 管理簿' },
  { label: '周知・同意台帳（Excel）', where: '就業カレンダー → 下の方', href: '/calendar', cap: 'calendar.approve', keywords: 'どうい しゅうち 署名 台帳' },
  // 休暇
  { label: '有給・帰国の申請一覧（承認）', where: '休暇管理 → 申請', href: '/leave?tab=requests', cap: 'leave.view', keywords: 'しょうにん 申請 ゆうきゅう' },
  { label: '帰国情報', where: '休暇管理 → 帰国情報', href: '/leave?tab=homeleave', cap: 'leave.view', keywords: 'きこく 一時帰国 長期' },
  { label: '有給の手動付与・時季指定・買取', where: '休暇管理 → 一覧 → 編集／メニュー', href: '/leave', cap: 'leave.manage', keywords: 'ふよ かいとり じきしてい' },
  // 請求
  { label: '応援の請求書（同業者へ）', where: '請求書・支払 → 会社ごと', href: '/peer-statement', cap: 'invoice.view', keywords: 'せいきゅうしょ 応援 同業者' },
  { label: 'HFU → 日比建設 の請求書', where: '請求書・支払 → HFU', href: '/peer-invoice?company=__hfu_to_hibi__', cap: 'invoice.view', keywords: 'えいちえふゆー hfu 請求書' },
  { label: '請求書の自社情報・振込先', where: '管理者設定 → 会社・請求書', href: '/settings?tab=company', cap: 'system.admin', keywords: '登録番号 インボイス 口座 振込' },
  // 経営
  { label: '現場の請求額の入力', where: '原価・収益 → 現場別', href: '/cost', cap: 'cost.edit', keywords: 'せいきゅうがく 売上 粗利' },
  // 人・賃金
  { label: '電話URL・QR（スタッフのスマホ）', where: '人員マスタ → 編集', href: '/workers', cap: 'workers.edit', keywords: 'とーくん url qr マイページ' },
  { label: '昇給履歴', where: '賃金・評価 → 昇給履歴', href: '/workers?tab=raise-history', cap: 'wage.view', keywords: 'しょうきゅう りれき' },
  { label: '評価管理（ベトナム人）', where: '賃金・評価', href: '/evaluation', cap: 'wage.view', keywords: 'ひょうか 評価 セッション' },
  { label: '号俸表・年次改定（日本人）', where: '賃金・評価 → 賃金制度', href: '/wage', cap: 'wage.decide', keywords: 'ごうほう 号俸 改定' },
  { label: '賞与（日本人）', where: '賃金・評価 → 賃金制度 → 賞与', href: '/wage?tab=bonus', cap: 'wage.decide', keywords: 'しょうよ ぼーなす' },
  { label: '賃金分析', where: '賃金・評価（代表のみ）', href: '/wage-analysis', cap: 'wageAnalysis.view', keywords: 'ちんぎん ぶんせき カーブ' },
  // マスタ
  { label: '現場の単価（常用・受取）', where: '現場マスタ → 編集 → 単価', href: '/sites', cap: 'masters.view', keywords: 'たんか 常用' },
  { label: '工種（鉄骨など）の追加', where: '現場マスタ → 編集', href: '/sites', cap: 'masters.edit', keywords: 'こうしゅ 鉄骨 仮設' },
  { label: '通勤時間・運転手当', where: '現場マスタ → 編集 → その他', href: '/sites', cap: 'masters.view', keywords: 'つうきん 運転手当' },
  { label: '外注単価', where: '取引先マスタ', href: '/subcons', cap: 'masters.view', keywords: 'がいちゅう たんか' },
  // 管理
  { label: '個人パスワード', where: '管理者設定 → ログイン・権限', href: '/settings?tab=users', cap: 'system.admin', keywords: 'ぱすわーど ログイン' },
  { label: '役割ごとの権限', where: '管理者設定 → ログイン・権限', href: '/settings?tab=users', cap: 'system.admin', keywords: 'けんげん ろーる' },
  { label: 'お知らせの投稿', where: '管理者設定 → お知らせ', href: '/settings?tab=announcements', cap: 'system.admin', keywords: 'おしらせ' },
  { label: 'バックアップ・復元', where: '管理者設定 → バックアップ・履歴', href: '/settings?tab=activity', cap: 'system.admin', keywords: 'ばっくあっぷ リストア' },
  { label: '操作の記録（アクティビティ）', where: '管理者設定 → バックアップ・履歴', href: '/settings?tab=activity', cap: 'system.admin', keywords: 'ろぐ 履歴 操作' },
  { label: 'スタッフのアクセス履歴', where: '管理者設定 → バックアップ・履歴', href: '/access-log', cap: 'system.admin', keywords: 'あくせす ログイン 未アクセス' },
  { label: 'HFU → 日比建設 の請求書の設定（単価・HFUの会社情報）', where: '管理者設定 → 会社・請求書', href: '/settings?tab=company', cap: 'system.admin', keywords: 'えいちえふゆー hfu 単価' },
  { label: '既定の単価（鳶・土工）・基本給ベース日数', where: '管理者設定 → 単価の既定値', href: '/settings?tab=settings', cap: 'system.admin', keywords: 'でふぉると たんか ベース日数' },
  { label: 'マニュアル', where: '資料一覧', href: '/docs', cap: 'docs.view', keywords: 'まにゅある 使い方 手順' },
]

/** かな・カナ・全半角・大小文字の違いを無視して比べるための正規化 */
export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    // カタカナ → ひらがな
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
}

/** 検索語（空白区切りは AND）に合う項目 */
export function searchMenu(query: string, entries: SearchEntry[]): SearchEntry[] {
  const words = normalizeForSearch(query).split(' ').filter(Boolean)
  if (words.length === 0) return []
  return entries.filter(e => {
    const hay = normalizeForSearch(`${e.label} ${e.where} ${e.keywords || ''}`)
    return words.every(w => hay.includes(w))
  })
}
