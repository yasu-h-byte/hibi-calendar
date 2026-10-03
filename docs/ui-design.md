# UI・デザインルール

## デザイン方針（2026-09-30 第2次刷新「案1 UDホワイト」）

- **全画面 = 案1「UDホワイト」**: 白いサイドバー・白いカード・薄いグレーの地。読みやすさ最優先
  - 3案（案1 UDホワイト／案2 ブランド直結＝上部メニュー／案3 帳場＝紙と墨）の見本から代表が選択（2026-09-30）
  - 前回（2026-07-03 管理画面=案A「モダン・ネイビー」／スマホ=案C「フィールド・コントラスト」）は控えめすぎて
    「全く変わってない」と見えた反省から、ひと目で変わる方向にした
- **字は BIZ UDPゴシック**（`app/layout.tsx` の next/font → Tailwind `font-sans`）。数字の 1/l・3/8 や濁点を読み間違えにくい
- **アイコンは線のアイコン**（`components/ui/Icon.tsx`）。メニューに絵文字は使わない（OSで絵柄が変わる・白地で色がうるさい）
- **紺（hibi-navy）は錨として絞って使う**: 主役ボタン・選択中の字・出面グリッドの所属区切り行と合計行・頭文字アイコン
- **スマホ画面**: 上の帯は白地＋濃い文字（`components/StaffHeader.tsx`）。主役ボタン（出勤登録）は工事アンバーのまま

## カラー（Tailwind トークン: tailwind.config.ts の `hibi.*`）
- `hibi-navy` #1B2A4A（主役ボタン・選択中の字・グリッドの所属区切り行と合計行）
- `hibi-light` #2A3F6A（navy のホバー色）
- `hibi-bg` #F3F5F8（ページ背景。globals.css で body に適用）
- `hibi-line` #E3E7EE（カード・サイドバーの細枠線）
- `hibi-sub` #5B6475（補足の文字。白地で 4.5:1 以上）
- `hibi-active` #EAF0FA（サイドバーの選択中・情報ピルの地）
- `hibi-thead` #F2F4F9（グリッド日付ヘッダー背景）
- `hibi-charcoal` #20262F（スマホの文字。ヘッダーの地には使わない＝2026-09-30 から白）
- `hibi-amber` #F5A623 / `hibi-amberDark` #DD9314（スマホ主役ボタン）
- ダークモード対応（管理画面のみ。スマホ画面は非対応）

## ブランド（システム名 DEDURA＋）

**会社名とシステム名は別物。混同しないこと。**

| | 名称 | 使う場所 |
|---|---|---|
| システム名 | **DEDURA＋**（デヅラプラス） | ブラウザタブ・PWA・アプリアイコン・サイドバー・ログイン画面 |
| 運営表記 | **Operated by BOWHEAD HOLDINGS** | サイドバー・ログイン画面で DEDURA＋ の下に小さく添える（`DEDURA_BYLINE`） |
| 会社名 | **HIBI CONSTRUCTION** | 公開カレンダー・評価帳票などの印字・LINE通知文の差出人 |

**サイドバーに会社ロゴは置かない。** 見るのは社内4ロール（管理者・事業責任者・事務・職長）
だけで会社名を常時掲げる情報価値が薄いうえ、白いロゴカードがメニューより目立って視線の
優先順位が逆転していたため。このシステムは日比建設と HFU 両社の人員を扱うので、
常設表示は個社名ではなくグループ名を出す。会社名は上表の場所に残っている。

運営表記に **`Managed by` は使わない**。英語では「他社に代わって運用受託している」含みが出るため。
自社グループが自社のために運営しているシステムなので `Operated by` が正確。
サイドバーの内寸は 184px（w-56・左右 px-5）なので、9px・字間標準・`whitespace-nowrap` で1行に収める。
`DEDURA＋` との間隔（`mt-1`）と明るさ（白地では `gray-500`・ダークでは `white/50`）はロックアップとして成立する下限値で、
広げると別物に見え、暗くすると 9px では読めなくなる。
なお `Sidebar` は `print:hidden` なので、この変更は印刷物・帳票に一切影響しない。

- 由来: 「出面（でづら）」＋ 機能拡張の「＋」。表記は旧アプリ `dedura-kanri` に合わせて **DEDURA**（DEZURA ではない）
- **＋ は単管クランプ**（直交する2本のパイプ＋ボルトの芯）がモチーフ。とび・土工の道具をそのまま記号にしている。**この意味づけは変えない**
- タグライン: **現場を組む。日々を組む。**（ログイン画面に表示）

### 実装

- アプリ画面内のシステム名表示は **必ず `components/Brand.tsx` 経由**。
  `<DeduraWordmark size="sm|md|lg" variant="navy|white" />` / `<DeduraMark />` / `DEDURA_TAGLINE`
  （アプリのフォントと自動で揃うため。SVG ファイルを `<img>` で貼らない）
- マークのサイズは文字のキャップハイト（≒ font-size × 0.85）に合わせる。等倍にすると
  ＋だけ大きく見えてワードマークが分離する
- 16px 未満ではボルトの芯を省略（潰れて濁るため）。`DeduraMark` が自動で処理する

### アセット

| ファイル | 用途 |
|---|---|
| `public/brand/dedura-icon.svg` | アプリアイコンの原本（アンバー地＋ネイビーのクランプ）。文字を含まないのでフォント環境に依存しない |
| `public/brand/icon-192.png` / `icon-512.png` | PWA（`manifest.json`、`purpose: any maskable`） |
| `public/brand/apple-touch-icon.png` | iOS ホーム画面 |
| `public/brand/favicon-32.png` | ファビコン |
| `public/brand/dedura-logo.svg` | 横組みワードマーク。**印刷物・社外資料用**。アプリ画面では使わない |
| `public/logo.png` | **会社ロゴ**（HIBI CONSTRUCTION）。サイドバー上部・評価帳票で継続使用 |

PNG は原本 SVG から再生成する:

```bash
cd public/brand && qlmanage -t -s 512 -o . dedura-icon.svg && mv dedura-icon.svg.png icon-512.png && sips -z 192 192 icon-512.png --out icon-192.png && sips -z 180 180 icon-512.png --out apple-touch-icon.png && sips -z 32 32 icon-512.png --out favicon-32.png
```

## 文字の大きさ（2026-10-03・rem 系に統一）

`text-[10px]` のような **px 指定は使わない**（ブラウザ・OS の「文字を大きく」設定が効かない）。2026-10-03 に 650か所を
rem 系へまとめて直した（見た目は同じ）。`npm run lint:px` が px 指定を検出する（意図した行は `// px-ok`）。

| 大きさ | クラス | 使いどころ |
|---|---|---|
| 10px 相当 | `text-3xs` | 札・出面グリッドのマスの補足だけ。**本文・スタッフ画面には使わない** |
| 11px 相当 | `text-2xs` | 表の補足・単位 |
| 12px | `text-xs` | 補足の本文（スタッフ画面の小さい文字はここが下限） |
| 13px 相当 | `text-[0.8125rem]` | 表の本文 |
| 14px | `text-sm` | 本文・メニュー |
| 15px 相当 | `text-[0.9375rem]` | スマホの本文 |
| 16px | `text-base` | スマホの基本 |
| 17px 相当 | `text-[1.0625rem]` | スマホの見出し |
| 18〜20px | `text-lg` / `text-xl` | 見出し |
| 22〜32px | `text-[1.375rem]` 〜 `text-[2rem]` / `text-3xl` | カードの主数字 |

- 10px 相当より小さい字は使わない（例外はサイドバーの社名行 9px 相当だけ）
- `text-3xs`・`text-2xs` は行の高さを持たない（親から継承。元の px 指定と同じ振る舞い）
- 中間の大きさ（13・15・17px 相当）は今後、標準の段（xs/sm/base/lg）へ寄せていく予定。新しい画面では標準の段を使う

## カード様式（管理画面共通）
- `bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700`（影は付けない＝2026-09-30）
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

## 保存・右パネル・並記の決まり（2026-10-02 総合点検）
- **保存は結果（`res.ok`）を必ず見る**。サーバが断った（権限 403・締め済み 409・通信失敗）のに画面が「保存済み」のままになる箇所を全部直した。
  断られたら理由を出して表示を元に戻す（出面の承認・原価の請求額・月次の所定日数・現場／取引先マスタ・運転者の記録など）。
  旧: 応答を見ずに成功扱い（運転者のモーダルは保存に失敗しても閉じていた）
- **保存の結果は押した場所の近くに出す**（画面の上の帯や alert に頼らない）。運転者の記録は保存できたときだけ閉じ、だめなら赤い理由をモーダル内に出す
- **右パネル（`SidePanel`・`components/ui/PageParts.tsx`）の `dirty`**: 編集フォームとして使う画面（人員マスタ・現場マスタ・取引先マスタ）は未保存の変更があるかを渡す。
  Esc・背景クリック・「閉じる」「×」のすべてが `confirmDiscard(dirty)`（`lib/hooks/discardGuard.ts`・純関数）を通り、
  「保存していない変更があります。閉じると消えます。閉じますか？」と1か所で同じ確認になる。旧: 入れかけの内容が確認なしで消えていた
- **スタッフ画面の並記の文言は `lib/labels.ts`**（`BiText`・`biLine`・`STAFF_TEXT`・`STAFF_STATUS_BI`）に集め、画面はそこから読む。新しい文言もここに足す（色のクラス名は置かない）。
  旧: 画面ごとの直書きで、あとから足した所が日本語だけ・英語だけ（'Error'）になっていた。例: 「今日: 出勤 07:30〜16:30 登録済み / Hôm nay: Đi làm · Đã đăng ký」「もう一度 / Thử lại」「却下の理由 / Lý do từ chối」
- **凡例は文字で**: 出面グリッドのマスの右上の点（誰が入れたか）は凡例を表の下に文字で出す（旧: 色だけで、説明が `title` にしか無かった）。
  カレンダー署名の出勤・休みも色だけで示さず、文字と日越の凡例を添える
- スタッフ画面の内訳・期限などの小さい文字は 12px 以上（旧 10px / 9px）

## 確認・お知らせ・保存の部品（2026-10-03 UI/UX 磨き込み 土台②・代表 OK）

ブラウザ標準の `confirm()` / `alert()` / `prompt()` は使わない（OS ごとに見た目が違う・ボタンがいつも OK／キャンセル・理由を書けない・
スマホで字が小さい・「通信エラーが発生しました」だけで次の手が分からない）。見本: https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh
2026-10-03 に全画面（計 268か所）を置き換え済み。`npm run lint:dialog` が app/・components/・lib/ のどこでも検出する。

**確認（`lib/confirm-dialog.ts`・窓は `components/ui/Confirm.tsx` の `<ConfirmHost />`）**

| 型 | 使う関数 | 決まり |
|---|---|---|
| ① ふつうの確認（提出・承認・保存・上書き） | `await confirmDialog({ title, description, confirmLabel })` | 主役ボタンは紺。言葉は起きることの動詞（提出する・承認する）。「やめる」が左 |
| ② 取り消し・削除（元に戻せない） | `await confirmDanger({ … })` | 赤は取り消し・削除・消すときだけ。「元に戻せません。」が自動で付く |
| ③ 理由を書く確認（承認後の修正・却下） | `await confirmWithReason({ …, reason: { label } })` | 理由を書くまで主役ボタンを押せない。やめたら null |
| ④ スタッフ向け | `vi: { title, confirmLabel, cancelLabel }` を渡す | 日越並記・指で押せる高さのボタン（52px） |

- Esc・背景クリックは「やめる」。右パネル（z-60）の上に出る（z-80）
- 右パネルの未保存ガードは `confirmDiscardDialog(dirty)`（`lib/hooks/discardGuard.ts`）。「閉じずに戻る」「保存せずに閉じる」（赤）

**お知らせ（`lib/notify.ts`・帯は `components/Toast.tsx` の `<ToastProvider>`）**

| 種類 | 使う関数 | 見た目 |
|---|---|---|
| うまくいった | `notify.success('葛西のカレンダーを提出しました')` | 緑の帯・右上（スマホは幅いっぱい）・3秒で消える。「何を・どうしたか」を1行 |
| 失敗した | `notify.failed('保存', res.error, 次の手)` / `notify.error(見出し, 理由と次の手)` | 赤の帯・**閉じるまで残る**。1行目「保存できませんでした」、2行目に理由と次の手。通信の失敗は定型文 |
| 入力の不備 | `<FieldError>`（`components/ui/PageParts.tsx`）＋ 欄に `aria-invalid` | 帯は出さず、その欄のすぐ下に赤字。`scrollToFirstInvalid()` で最初の不備まで動かす |

- サーバの断り（403・409）は `data.error` の文をそのまま理由に。status 番号・「エラー:」・絵文字は出さない

**保存ボタン（`components/ui/SaveButton.tsx`）**: 「保存する」→「保存しています」（二度押しできない）→「✓ 保存しました」（2秒）→ 戻る。失敗は「もう一度保存する」＋赤の帯。
`onSave` が throw か `{ ok: false, error }` を返すとボタンが帯を出す。新しい保存ボタンはこれで作る（既存の「保存中...」ボタンは順次置き換え）

**モーダル（`components/ui/Modal.tsx`・2026-10-03 土台③）**: 画面ごとの `fixed inset-0 … bg-white rounded-xl p-6` は書かない。`<Modal open onClose title size footer dirty>` を使う。
見出し行（title ＋ ×）・本文（中だけスクロール）・下のボタン列（`footer`: 左に `CancelButton`「やめる」、右に `SaveButton` か `PrimaryButton`）。`dirty` を渡すと未保存ガード（右パネルと同じ窓）。
旧 `lib/styles.ts` の `modalOverlayCls` / `modalContentCls` は使わない。検出は `npm run lint:dialog`（`modal-ok` で例外）。
見るだけの一覧は右パネル（SidePanel）、入力して保存するものはモーダル、どちらも「やめる」が左・主役が右。

**文字の大きさ（標準／大きい＝1.125倍）**: PC はサイドバー下の切替、スマホは右上の DEDURA＋ マークを押す（`components/StaffHeader.tsx`）。`lib/theme.ts` で端末ごとに覚える

## 管理者画面
- PCレイアウト優先
- サイドバー幅: w-56（224px）。白地・右に細線・メニュー14px・線のアイコン（2026-09-30）
- 画面の見出し（H1）: `text-2xl font-bold text-gray-900`（紺でなく黒。紺はボタンと選択中に絞る）
- ヘッダーバーなし（サイドバーにロゴ・通知・ユーザー情報を集約）
- モバイル時: 左上のフローティングハンバーガーメニュー
- サイドメニューの中身・並びは `lib/menu.ts`（誰に見せるかは `lib/permissions.ts`）。**仕事のまとまりごと**に分ける
  （2026-09-28: ホーム／出面・勤怠／給与・締め／請求・原価／人・書類／賃金・評価／マスタ・管理）。
  旧「毎日・毎月（頻度）」と「経営・人・賃金（業務）」の軸が混ざり、置き場所の理屈が見えなかった
- 選択中のメニューは常に1つ（`activeMenuItem`）。画面の中でタブを切り替えて `?tab=` が変わるときは
  `history.replaceState` のあと `window.dispatchEvent(new Event('hibi:urlchange'))` を投げてメニューの選択を合わせる
- 画面の見出し（H1）はメニューの名前とそろえる（例: 請求書・支払／原価・収益／月次集計・締め）

## スタッフ画面（案1 UDホワイト・2026-09-30 から。旧 案C フィールド・コントラスト）
- スマホ最適化・ページ背景 `bg-hibi-bg`
- ヘッダー: `components/StaffHeader.tsx`（白地・頭文字の紺丸・名前・ベトナム語名・DEDURA＋マーク）
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

## 月次集計・締め（2026-10-01 改善・代表依頼「休暇管理と同じように見やすく使いやすく」）
- 開くと前月（締める月）。前月が両社とも締め済みで、月を指定せずに開いたときだけ今月へ
- 会社ごとのカード（components: monthly/MonthlyOverview の CloseCard）: 人数・支給額の合計・チェック3つ（出面の承認は締めるときに自動確認／本人確認／自動検算）・締める／締めを解除
- 「見やすい一覧」（既定）: 1人1行・0円でない内訳だけを札で・要確認を上に・絞り込み（要確認だけ／本人確認まだ）・行を押すと計算根拠。「全項目の表」に切り替えると従来の19列の表（Excel 突き合わせ用）
- 金額はサーバ値をそのまま出す（画面で再計算しない）

