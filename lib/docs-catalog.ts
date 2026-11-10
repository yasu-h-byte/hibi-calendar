/**
 * 資料一覧（/docs）に並べる資料の台帳。
 * 画面（app/(app)/docs/page.tsx）と、「使い方を聞く」の AI に読ませる資料の出し分け（lib/help.ts）の両方が使う。
 * マニュアルを改訂したら、ここの `updated` を直す（CLAUDE.md「マニュアル改訂ルール」）。
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */

export type DocRole = 'admin' | 'approver' | 'foreman' | 'jimu'

export interface DocItem {
  title: string
  desc: string
  url: string
  badge?: string
  internal?: boolean
  updated: string
  // このロールに関係する資料。未指定 = 全員向け。admin は常に全資料が対象。
  roles?: DocRole[]
}

export type DocCategory = 'guide' | 'manual' | 'staff' | 'archive'

// 全資料（フラットに保持。category は表示グループ用）
export const DOCS: (DocItem & { category: DocCategory })[] = [
  // ── 全員向けの入口 ──
  { category: 'guide', title: 'ロール別やることチェックリスト', desc: '事務・役員・職長・スタッフが日次／月次／年次で何をすべきかを1ページに集約', url: '/manual-checklist.html', badge: '日次参照', updated: '2026-10-03' },

  // ── 事務（森田さん・2026-10からキャシュモ委託体制） ──
  { category: 'manual', roles: ['jimu'], title: '事務業務マニュアル（森田さん向け）', desc: '奥寺さん・佐藤さんの業務を統合した引き継ぎ版。出面補助・申請承認・道具代・月次締め・キャシュモへの資料提出まで（給与計算・振込はキャシュモ委託）', url: '/manual-morita.html', badge: 'NEW', updated: '2026-11-10' },
  { category: 'manual', roles: ['jimu', 'approver', 'admin'], title: '山岡への請求書マニュアル', desc: '大林組の請求書（控え）のPDFと山岡の控除計算書を入れると、85%・他社借受の切り出し・給与の控除を計算して山岡の書式で印刷。格納（森田さん）→ 確認1（政仁さん）→ 確認2（代表）の手順、読み取りの注意の見方、出面との検算、割合（IHI の90%など）の変え方。画面のスクショつき', url: '/manual-prime-invoice.html', badge: 'NEW', updated: '2026-10-20' },
  { category: 'manual', roles: ['jimu'], title: '社労士提出用資料マニュアル', desc: 'キャシュモに毎月渡す2資料（月次集計Excel・計算根拠PDF）と根拠書類3点（勤務予定シフト・実労働時間明細・出面一覧）の説明。変形労働時間制・3段階残業判定・有給日給・日本人の計算方法・端数処理', url: '/manual-syaroshi.html', updated: '2026-10-23' },

  // ── お知らせ（計算ルールの変更） ──

  // ── 事業責任者（政仁さん） ──
  { category: 'manual', roles: ['approver'], title: '政仁さん向けマニュアル', desc: '出面の最終承認・有給/帰国申請の承認・就業カレンダー承認（事業責任者の承認業務に特化）。10月改訂で スマホのマイページからの最終承認・代行 を追加', url: '/manual-masahito.html', badge: '10月改訂', updated: '2026-10-20' },

  // ── 職長 ──
  { category: 'manual', roles: ['foreman'], title: '職長向けマニュアル', desc: '毎日の出面確認・就業カレンダー・夜勤の入力。10月改訂で マイページからの承認（出面のまとめ承認・有給・帰国申請）を追加', url: '/manual-foreman.html', badge: '10月改訂', updated: '2026-10-03' },

  // ── 有給担当（事務・事業責任者） ──
  { category: 'manual', roles: ['jimu', 'approver'], title: '休暇管理マニュアル', desc: '有給・帰国休暇の唯一の参照元。帰国期間中でも有給を使えるようになった点（2026-09）と、年5日の日本人特則・買取上限（残−5日）・買取の自動記録・HFU移籍の勤続通算', url: '/manual-yukyu.html', badge: '10月改訂', updated: '2026-10-08' },

  // ── 評価（運用前・管理者のみ） ──
  { category: 'manual', roles: ['admin'], title: '評価管理マニュアル（ベトナム人）', desc: '年次評価と時給改定（入社記念日サイクル）。5タブ構成・評価者ウェイト・スコア計算・昇給テーブル', url: '/manual-evaluation.html', updated: '2026-10-03' },
  { category: 'manual', roles: ['admin', 'approver'], title: '賃金・評価 操作マニュアル（日本人）', desc: '号俸制の年次改定の回し方（評語・代表加算・平均昇給率）と賞与4区分（利益分配・精勤・禁煙・子ども手当）の作成〜確定〜有給買取の自動記録まで', url: '/manual-wage-jp.html', badge: 'NEW', updated: '2026-10-08' },

  // ── スタッフ向け（全員が内容を把握しておく／スタッフ本人はスマホから） ──
  { category: 'staff', title: 'マイページの使い方（日本人スタッフ向け）', desc: '有給の残数確認と申請・年5日ルール・道具代の残額確認（申請はマネーフォワード）。専用URLの配布時に一緒に渡す1枚もの', url: '/manual-mypage-jp.html', badge: 'NEW', updated: '2026-10-08' },
  { category: 'staff', title: '有給休暇のルール（日本人スタッフ向け）', desc: '年5日は現場が動いている日に必ず休む・有給の申請・有給精算（日給月給の人が残りを給料に回す・月24日まで）・期末の買取。マイページの「有給のルールを読む」から開く。トークノートでの周知用の文もこの内容', url: '/notice-yukyu-rule-jp.html', badge: 'NEW', updated: '2026-10-08' },
  { category: 'staff', title: '【お知らせ】給料の計算のしかた（2026年9月分から）', desc: 'ベトナム人スタッフ向け（日本語＋ベトナム語）。「自分の都合で休んでも給料があまり減らない」ゆがみを直す理由（2人の比較つき）と5つのルール・計算例。自分の都合の欠勤は1日ごとに保証が1日減る（働いた日の分は必ず払う）。8月分までの支払いはそのまま', url: '/notice-salary-rule-2026-09.html', badge: '日本語+ベトナム語', updated: '2026-09-30' },
  { category: 'staff', title: 'スタッフ向けマニュアル（ベトナム人）', desc: '使う場面ごと（毎日・休むとき・毎月・ときどき）の7章。出勤登録／休みの出し方（会社の都合・自分の都合・有給・帰国）／月末の出面の確認／カレンダーの署名／忘れた・まちがえたとき／有給・道具代の残り／困ったとき（日本語＋ベトナム語）', url: '/staff-manual-vi.html', badge: '日本語+ベトナム語', updated: '2026-10-03' },
  { category: 'staff', title: '変形労働時間制と残業のルール', desc: '変形労働時間制のしくみ・残業の3段階判定・給料の4層構造・計算例・FAQ（スタッフへの制度説明用）', url: '/manual-henkei-vi.html', badge: '日本語+ベトナム語', updated: '2026-09-26' },
  // ── 過去資料（役目を終えたが記録として残す）──
  // 2026-09-02: 奥寺さん・佐藤さんの退職（9月末）とキャシュモ委託に伴い、個人名義の
  //   3冊は「事務業務マニュアル（森田さん向け）」へ統合。原本は記録として残す。
  { category: 'archive', title: '請求書の発行マニュアル（2026年9月26日版）', desc: '森田さん向け事務マニュアル（請求）と政仁さん向けマニュアル（承認）へ統合済み。個人パスワードの発行手順は森田さんマニュアルの付録へ', url: '/manual-invoice.html', updated: '2026-09-26' },
  { category: 'archive', title: '【お知らせ】最低20日保証と現場都合休の計算変更（8月分から）', desc: '8月分からの計算変更のお知らせ（周知済み）。ルールは休暇管理マニュアル・社労士提出用資料マニュアルに反映済み', url: '/notice-20day-guarantee.html', updated: '2026-10-02' },
  { category: 'archive', title: '奥寺さん向けマニュアル（〜2026年9月）', desc: '森田さん向けマニュアルへ統合済み。出面補助・月次集計・月締め・帳票出力の旧版', url: '/manual-okudera.html', updated: '2026-10-02' },
  { category: 'archive', title: '給与計算マニュアル（奥寺さん用・〜2026年9月）', desc: '給与計算はキャシュモへ委託済み。システムの計算ロジック詳細の記録として保存（検算・保守時の参照用）', url: '/manual-payroll-okudera.html', updated: '2026-10-02' },
  { category: 'archive', title: '道具代管理マニュアル（佐藤さん向け・〜2026年9月）', desc: '森田さん向けマニュアルへ統合済み。購入登録・残額管理の旧版', url: '/manual-sato.html', updated: '2026-09-02' },
  { category: 'archive', title: '新しい給与制度の説明（スライド・2026年5月移行時）', desc: '旧制度→変形労働時間制への移行を対面説明したときのスライド。移行完了につき過去資料', url: '/manual-kyuyo-hikaku-vi.html', updated: '2026-08-01' },
]

/** 資料一覧の「あなたに関係する資料」の判定（役割が分からないときは全部見せる） */
export function isForRole(item: DocItem, role: DocRole | null): boolean {
  if (!item.roles) return true // 全員向け
  if (role === 'admin') return true // 管理者は全資料が対象
  if (!role) return true // ロール不明時は全部見せる（安全側）
  return item.roles.includes(role)
}
