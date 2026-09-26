/**
 * お知らせ（2026-09-26〜）。
 *
 * お知らせは2か所から集まる:
 *   1. 管理者設定「お知らせ」タブで投稿したもの（demmen/main.announcements）
 *   2. このファイルの RELEASE_NOTES（機能を出すたびにコードと一緒に書く「更新のお知らせ」）
 * 2 は代表の指示（2026-09-26「お知らせ欄、あなたの判断で内容更新していってほしい」）で、
 * 機能をリリースしたコミットに1件足す。デプロイと同時に表示され、DB を直接書き換えない。
 *
 * roles を付けると、その役割の人にだけ出る（lib/permissions.ts の PermRole）。無ければ全員。
 * 書き方: 使う人の言葉で「何が変わったか」「自分は何をすればいいか」を2〜4行。技術用語は使わない。
 */
import type { PermRole } from './permissions'

export interface Announcement {
  id: string
  title: string
  content: string
  category: 'new' | 'fix' | 'info'
  publishedAt: string
  publishedBy: string
  /** 出す相手（無ければ全員） */
  roles?: PermRole[]
}

const OFFICE: PermRole[] = ['jimu', 'approver', 'officer', 'owner']

/** 新しいものを上に足していく */
export const RELEASE_NOTES: Announcement[] = [
  {
    id: 'rn_20260926_foreman',
    title: '職長のみなさんへ: ログインし直しと、承認待ちのお知らせ',
    content:
      'アプリを開くと一度だけ「もう一度ログインしてください」と出ます。いつもどおりログインすれば大丈夫です。\n'
      + '自分の現場の有給・帰国申請が職長承認待ちになると、ベル（🔔）でお知らせするようになりました。承認は「出面入力」→「📱 スマホ版へ」→「承認」タブです。\n'
      + 'メニューの「スマホ入力」は無くなりました。スマホ版は「出面入力」の中から開けます。',
    category: 'new',
    publishedAt: '2026-09-26T18:00:00+09:00',
    publishedBy: '日比靖仁',
    roles: ['foreman'],
  },
  {
    id: 'rn_20260926_menu',
    title: 'メニューが新しくなりました（検索もできます）',
    content:
      'メニューを「毎日／毎月／経営／人・賃金／マスタ／管理」の順に並べ替えました。帳票出力はメニューから直接開けます。\n'
      + 'メニューの一番上の検索欄に「有給台帳」「請求書」「締め」などと打つと、その画面・タブへすぐ行けます。\n'
      + '役割ごとにできることを整理しました（最終承認は政仁さん、事務の仕事は森田さん）。',
    category: 'new',
    publishedAt: '2026-09-26T17:50:00+09:00',
    publishedBy: '日比靖仁',
    roles: OFFICE,
  },
  {
    id: 'rn_20260926_morita',
    title: '森田さんへ: 引き継ぎのマニュアルを1冊にまとめました',
    content:
      '給与締め・有給まわり・道具代・請求まわりの手順を「資料一覧 → 事務業務マニュアル（森田さん向け）」にまとめました。\n'
      + '最初に「毎月のカレンダー」を見ると、月初から月末まで何をするかがわかります。\n'
      + '帰国情報の登録・期間の変更・復帰日の登録も、連絡を受けたときに森田さんが入れられるようになりました。',
    category: 'info',
    publishedAt: '2026-09-26T17:40:00+09:00',
    publishedBy: '日比靖仁',
    roles: ['jimu', 'owner'],
  },
  {
    id: 'rn_20260926_invoice',
    title: '請求書: 森田さんが申請 → 政仁さんが承認して発行',
    content:
      '応援の請求書と HFU → 日比建設 の請求書を、出面から自動で作れるようになりました。\n'
      + '森田さんが「請求書・支払」で「発行を申請」→ 政仁さんのベル（🔔）に届くので、内容を確認して「承認して発行」。\n'
      + '政仁さんは「原価・収益」（現場ごとの請求額・粗利）も使えるようになりました。',
    category: 'new',
    publishedAt: '2026-09-26T17:30:00+09:00',
    publishedBy: '日比靖仁',
    roles: ['jimu', 'approver', 'owner'],
  },
]

/**
 * 投稿したお知らせとリリースノートを合わせ、その人に出すものを新しい順に返す。
 * role が不明（null）のときは「全員向け」だけ。
 */
export function mergeAnnouncements(stored: Announcement[], role: PermRole | null): Announcement[] {
  const visible = (a: Announcement) => !a.roles || (role !== null && a.roles.includes(role))
  return [...stored, ...RELEASE_NOTES]
    .filter(visible)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
}
