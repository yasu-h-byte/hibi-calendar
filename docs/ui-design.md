# UI・デザインルール

## デザイン方針（2026-07-03 刷新）

- **管理者画面 = 案A「モダン・ネイビー」**: HIBIネイビーを保ったまま、カード・表・ラベルを磨き上げ
- **スタッフ・職長スマホ画面 = 案C「フィールド・コントラスト」**: 直射日光下の視認性最優先。チャコール＋工事アンバー、濃色ベタ＋太字

## カラー（Tailwind トークン: tailwind.config.ts の `hibi.*`）
- `hibi-navy` #1B2A4A（メインカラー・サイドバー・フッター合計行）
- `hibi-light` #2A3F6A（navy のホバー色）
- `hibi-bg` #F6F7FA（管理画面ページ背景。globals.css で body に適用）
- `hibi-line` #E6E9F0（カードの細枠線）
- `hibi-thead` #F2F4F9（グリッド日付ヘッダー背景）
- `hibi-charcoal` #20262F（スマホのヘッダー・文字）
- `hibi-amber` #F5A623 / `hibi-amberDark` #DD9314（スマホ主役ボタン）
- ダークモード対応（管理画面のみ。スマホ画面は非対応）

## カード様式（管理画面共通）
- `bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm`
- 共通ヘルパー: `lib/styles.ts` の `cardCls()` / `modalContentCls()`
- `border-l-4` の意味色アクセント付きカード（ダッシュボード等）は左アクセント維持＋`shadow-sm` のみ
- モーダル・ドロップダウン等の浮遊要素は `shadow-lg/xl` 維持

## ボタンの3段階格付け（管理画面）
- 主役: `bg-hibi-navy hover:bg-hibi-light text-white rounded-lg font-bold`
- 脇役: `bg-white border border-gray-300 text-hibi-navy rounded-lg font-medium`（+dark系）
- 危険: `bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold`
- 承認フローの意味色（職長承認=blue-500 / 最終承認=green-500）は色相維持で `rounded-lg font-bold`

## ステータスピル（システム共通）
淡色背景＋濃色文字＋ `rounded-md font-bold`（dark: は 900/30 地に 300 文字）:
- 出勤=green / 半日=amber / 有給=violet / 試験=indigo / 休み=red / 現場休=gray / 帰国=cyan / 残業数値=amber文字

## 保存状態インジケータ
`text-xs font-bold rounded-full px-2.5 py-1` のピル形で統一。
保存中=blue-50/navy、保存済み=green-50/green-700「✓ 保存済み」、エラー=red-100/red-700

## 管理者画面
- PCレイアウト優先
- サイドバー幅: w-52（208px）
- ヘッダーバーなし（サイドバーにロゴ・通知・ユーザー情報を集約）
- モバイル時: 左上のフローティングハンバーガーメニュー

## スタッフ画面（案C フィールド・コントラスト）
- スマホ最適化・ページ背景 #F1F2F5
- ヘッダー: `bg-hibi-charcoal text-white`
- 主役ボタン（出勤登録）: `bg-hibi-amber text-hibi-charcoal rounded-xl font-extrabold` + amberシャドウ
- 脇役ボタン（休み・キャンセル等）: 白ベタ + `border-2 border-gray-300 text-hibi-charcoal font-bold`
- 実労働時間カード: `bg-[#FFF6E3] border-[#F2D9A0]`、数値 `text-[#8A5A00] font-extrabold tabular-nums`
- 登録済み表示: 濃色ベタ（出勤=`bg-[#1E9E52] text-white` / 休み=`bg-gray-500 text-white`）
- フォント16px基本
- タップターゲット44px以上
- 日本語とベトナム語を必ず並記
- レガシー入力モード（2026年4月以前の3ボタン UI）は旧デザインのまま凍結

## 通知
- サイドバーのユーザー名横にベルアイコン
- 通知は問題が解決されるまで常時表示（既読/dismiss機能なし）
- バッジは点滅なし（静止表示）
- 通知パネル: left-0, w-72, z-[100]

## 色分けルール（スタッフ画面）
- 稼働日：青 / đi làm（出勤）
- 休日（土日）：グレー / nghỉ（休み）
- 祝日：赤 / nghỉ lễ（祝日）
- 有給：緑 / nghỉ phép（有給休暇）

## 言語表示ルール
- 管理者画面：日本語のみ
- スタッフ画面：日本語とベトナム語を必ず並記
- 署名ボタン：「内容を確認しました / Tôi đã xác nhận nội dung」
- 通信エラー：「つうしん エラー / Lỗi kết nối」
- 読み込み中：「よみこみちゅう... / Đang tải...」
- キャンセル：「やめる / Hủy」

## ダッシュボード（管理者）

### 勤怠申請カード
- 最上位に表示。対応待ちが0件のときは非表示
- 申請を「職長承認待ち」と「最終承認待ち」の2グループに分けて視覚的に区別
  - 職長承認待ち: 黄色背景 + ⏳ サブ見出し
  - 最終承認待ち: 青色背景 + ⏳ サブ見出し
- 承認ボタン表示はロールに応じて切り替え（詳細は roles-auth.md を参照）
  - foreman: 「最終承認」ボタンの代わりに「最終承認待ち」ラベルのみ表示
- 一時導入した「PendingRequestsBanner」（オレンジ・バウンス）は採用見送り（削除済み）

### 本日の稼働状況
- 「休み」リストから帰国中スタッフを除外
- 判定ソースは `main.homeLeaves` と `homeLongLeave` の両方を参照

## スタッフ画面（スマホ）

### ヘッダー
- スタッフ名にベトナム語名（`nameVi`）を併記

### タップターゲット・色
- 残業 ± ボタン: w-14 h-14（拡大）
- 過去日「やめる / Hủy」ボタン: 警告色（border-2 で強調）
- 送信中（有給申請・帰国申請の送信ボタン）はスピナーを表示

### 休憩チェックボックス
- 表示は午前・午後のみ。昼休憩は UI から削除し、内部で「取得」扱いとして計算
- 現場マスタで `lunchBreak.enabled = false` を設定すれば計算からも除外される

### 道具代カード
- 「期間 / Kỳ」見出しで期間を表示
- 形式: `2026/2/7 〜 2027/2/6`（西暦付き、開始日と終了日の両方）

### AttendanceStatus とステータス色
| status | 表示 | スマホ色 |
|--------|------|----------|
| working | しごと / đi làm | 青 |
| holiday | やすみ / nghỉ | グレー |
| paid_leave | ゆうきゅう / nghỉ phép | 緑 |
| home_leave | ✈️ きこくちゅう / Đang về nước | cyan |
| exam | 📝 しけん | purple |

