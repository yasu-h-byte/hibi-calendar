# HIBI CONSTRUCTION 就業カレンダーシステム - 開発ルール

各仕様の詳細は `docs/` ディレクトリを参照。仕様変更時は該当ドキュメントを更新すること。

## 仕様ドキュメント

| ファイル | 内容 |
|---------|------|
| [docs/company.md](docs/company.md) | 会社概要・組織構成・従業員構成 |
| [docs/labor-rules.md](docs/labor-rules.md) | 労働時間・変形労働時間制・運用サイクル |
| **[docs/payroll-manual.md](docs/payroll-manual.md)** | **給与計算 実務マニュアル（運用者向け・最重要）** |
| **[docs/payroll-manual-okutera.md](docs/payroll-manual-okutera.md)** | **奥寺さん向け給与計算マニュアル（日比建設専用・実務担当者向け）** |
| [docs/manual-syaroshi.md](docs/manual-syaroshi.md) | 社労士提出用資料マニュアル（HFU分・キャシュモ向け） |
| [docs/salary-calculation.md](docs/salary-calculation.md) | 給与計算の技術仕様（開発者向け） |
| [docs/calc-examples.md](docs/calc-examples.md) | 給与計算例集（社労士確認用・8パターン） |
| [docs/labor-agreements.md](docs/labor-agreements.md) | 労使協定・36協定・就業規則対応表（社労士向け） |
| [docs/historical-changes.md](docs/historical-changes.md) | 給与計算ルール変更履歴（労基法115条対応） |
| [docs/paid-leave.md](docs/paid-leave.md) | 有給休暇管理・法定付与・申請フロー・年5日義務 |
| [docs/attendance.md](docs/attendance.md) | 出面入力・PC/スマホ画面・フッター合計ルール |
| [docs/ui-design.md](docs/ui-design.md) | UI・デザイン・色分け・言語表示ルール |
| [docs/firestore.md](docs/firestore.md) | Firestoreデータ構造・コレクション定義 |
| [docs/roles-auth.md](docs/roles-auth.md) | ロール・認証・権限管理 |

## 開発の基本ルール

### 技術スタック
- Next.js 14（App Router）+ TypeScript + Tailwind CSS
- Firebase Firestore（プロジェクト: dedura-kanri）
- Vercel にデプロイ

### Tailwind クラス文字列の置き場所ルール

Tailwind は `tailwind.config.ts` の `content` に列挙したディレクトリの**ファイルを
文字列として grep** し、そこに現れたクラス名だけ CSS を生成する。したがって
**クラス文字列を返すヘルパーを `content` 対象外のディレクトリに置くと、
そのクラスの CSS が生成されず UI が無色（透明）になる**。

- `content` 対象: `app/`, `components/`, `lib/`
- クラス文字列を返すヘルパーは上記のいずれかに置く。新しいディレクトリ
  （`utils/`, `src/` 等）を作ってそこに置く場合は、**同時に `content` へ追加する**
- 動的なクラス組み立て（`` `bg-${color}-500` ``）は grep に引っかからないので常に禁止。
  必ず完全なクラス名を文字列リテラルで書く

**2026-07 有給消化バー障害の記録**

有給管理画面（`app/(app)/leave/`）の消化率バーが無色になった。原因は
コミット `15fa98d` のリファクタリングで `rateBarColor()` を
`app/(app)/leave/page.tsx` から `lib/leave-utils.ts` へ移動したこと。当時の
`content` は `app/` と `components/` しかスキャンしておらず、
`from-green-400` 等のグラデーションクラスがどのスキャン対象ファイルにも
現れなくなったため CSS が生成されず、バーが透明になった。
対処として `content` に `./lib/**/*.{js,ts,jsx,tsx}` を追加。
**ロジックの移動だけでも見た目が壊れる**ため、クラス文字列を含む関数を
別ファイルへ動かしたときは移動先が `content` 対象か必ず確認すること。

### 旧アプリとの関係
- 旧アプリ（dedura-kanri）の保存機能は**完全無効化済み**
- Firestoreは共有だが、旧アプリからの書き込みは発生しない
- 新システムに完全移行済み（2026年4月〜）

### コミットルール
- Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com> を付与
- 日本語でコミットメッセージを記述

### マニュアル改訂ルール（必読）

業務マニュアル（`docs/manual-*.md`、`public/manual-*.html`）を改訂したら、
**必ず以下 3 箇所の更新日を同時に変更する** こと。1つでも忘れると古い日付が
残り、利用者（奥寺さん等）が「これは最新か？」と判断できなくなる。

| 場所 | 更新する箇所 |
|---|---|
| `docs/manual-*.md` (原本) | フロントマター「最終更新」+ 改訂履歴の表に新エントリ |
| `public/manual-*.html` (公開HTML) | 冒頭の「最終更新: YYYY年MM月」+ 改訂履歴の表に新エントリ |
| `app/(app)/docs/page.tsx` (資料一覧) | 該当エントリの `updated: 'YYYY-MM-DD'` |

改訂履歴の表には「何を変更したか」を 1-2 行で記載。空のエントリは作らない。

例: 給与計算マニュアル (奥寺さん用) の場合
- `docs/payroll-manual-okutera.md`
- `public/manual-payroll-okudera.html`
- `app/(app)/docs/page.tsx` の `'/manual-payroll-okudera.html'` 行

### 関係者の役割

このアプリには「事業責任者」と「アプリ開発・管理者」という2つの異なる役割が存在する。混同しないこと。

| 役割 | 担当 | 業務 |
|---|---|---|
| **アプリ開発・管理者** | **グループ代表 靖仁さん** | このアプリの仕様策定・開発依頼・運用管理。Claude に話しかけているのはこの人。日々の改善要望・バグ指摘もここから来る |
| **事業責任者**         | **政仁さん**             | 就業カレンダー・出面・給与計算等の業務上の最終承認権限を持つ |

- Claude が会話相手として向き合うのは原則 **靖仁さん**（メール: y.hibi@kwj.jp）
- アプリ内の承認フローで「最終承認者」として登場するのは **政仁さん**
- 両者は別人。コミットメッセージ・コメント・ドキュメントで言及するときは混同しないこと

### 承認フローの原則
**現場レベルの作業は職長、最終承認は事業責任者（政仁さん）。この原則はすべての機能に適用する。**

- **就業カレンダー**: 職長が作成・提出 → 政仁さんが最終承認
- **出面（出退勤）**: スタッフが入力 → 職長が確認・ロック → 政仁さんが最終承認
- **有給申請**: スタッフが申請 → 管理者が承認
- 新機能を追加する際も、この承認フローの原則に従うこと
- 職長が直接「最終承認」する機能は作らない（職長は「提出」「確認」まで）

### 問題解決の原則（最重要）

**目先の対処ではなく、根本原因をしっかり直す。これがデフォルトの方針。**

問題が見つかった時の標準フロー：

1. **症状が起きる仕組みを最後まで追う**
   - 表面（UI誤表示）→ 集計層（合計が違う）→ 算出層（残業計算ロジック）→
     データ層（Firestore のフィールド残骸）まで段階的に下る
   - 「なぜ?」を 3〜5 回繰り返して根本にたどり着く

2. **下流で防御 + 上流で根治、両方やる**
   - 下流の防御（集計時のフィルタ等）= 即時の応急処置
   - 上流の根治（データを正しく書き込む / そもそも残骸を作らない）= 本来の解決
   - 両方やることで「二度と同じ問題が起きない」状態を作る

3. **横展開で類似箇所をすべて修正**
   - 1箇所修正したら、同種パターンが他にないか必ずgrepする
   - 「ここはまだいい、後で」は技術的負債を増やすだけ

4. **共通ヘルパーで一元化**
   - 同じロジックを何箇所にも書かない
   - 例: `isWorkingDay()`, `computeAttendanceDeleteFields()`, `ensureDocExists()`
   - 一箇所直せば全てに反映される構造を作る

5. **修正後の検証**
   - 「この修正で同種の問題が二度と起きないか」を検証
   - 必要なら lint / test / 検算スクリプトを追加して再発を機械的に防ぐ
   - 例: `scripts/lint-firestore-safety.mjs`, `scripts/diagnose-merge-empty-map.mjs`,
     `scripts/cleanup-attendance-residue.mjs`

6. **根本原因を CLAUDE.md / memory に記録**
   - 同じ罠を別の人が踏まないように、原因と対処を文書化
   - 例: 下記「Firestore 書き込みの安全ルール」

### Firestore 書き込みの安全ルール（必読）

**2026-05-07 に att_202605 の出面データが全消失する事故が発生した。** 同種の事故を絶対に二度と起こさないため、以下のルールを厳守すること。

#### 禁止パターン

```ts
// ❌ 絶対禁止 — 既存の d フィールド全体が空マップに置換される
await setDoc(ref, { d: {} }, { merge: true })

// ❌ 同上 — 子値に空マップ {} を渡す書き込みは全て危険
await setDoc(ref, { d: {}, sd: existing }, { merge: true })
```

`setDoc(ref, data, { merge: true })` の `merge:true` は **「言及されていない他の top-level field」だけ** を保護する。`data` 内で明示された field の VALUE は **置換** される。子値に `{}` を渡すと、その field の中身が空になる。

#### 推奨パターン

```ts
// ✅ ドキュメント存在保証だけ
import { ensureDocExists } from '@/lib/firestore-safe'
await ensureDocExists(ref)

// ✅ 単一エントリの追加・更新（既存キーは保持）
await setDoc(ref, { d: { [key]: entry } }, { merge: true })  // 子値が非空なら安全

// ✅ 特定フィールドの削除
await updateDoc(ref, { [`d.${key}.${field}`]: deleteField() })

// ✅ 特定 worker の plData だけ更新
await updateDoc(ref, { [`plData.${workerId}`]: records })
```

#### 検証

- コミット前に `npm run lint:firestore` を実行（危険パターンを検出）
- 実機検証は `npm run diagnose:firestore` で `demmen/att_900001` テスト doc を使った挙動確認

#### 多層防御

1. **コードレベル**: `lib/firestore-safe.ts` の helper 経由で書き込む
2. **lint レベル**: `scripts/lint-firestore-safety.mjs` が危険パターンを検出
3. **サーバレベル**: `firestore.rules` の `notWipingMap()` が「非空マップ→空マップ」書き込みを拒否
4. **バックアップ**: `app/api/backup/snapshot` が日次で `backups` コレクションへスナップショット保存（PITR 代替）

復元: `/api/backup/restore` (admin only)。

### Firestore 運用の必須ルール（Admin SDK 移行済み）

セキュリティ根治（サーバを Admin SDK 化 + rules を deny-by-default 化）は **2026-06-29 完了**。
経緯・移行手順・障害履歴（2026-06-30 preferRest / 2026-07-02 クォータ超過）・ロールバック手順は
**[docs/admin-sdk-migration.md](docs/admin-sdk-migration.md)** を参照。コードを書くときの必須ルールのみ以下に残す:

- サーバの Firestore アクセスは**静的・動的 import とも `@/lib/fsdb` に統一**
  （`firebase/firestore` を直接 import しない。`lib/firebase.ts` の Web SDK 初期化のみ例外）
- firebase-admin は **v14 モジュラーAPI**。`next.config.js` の serverComponentsExternalPackages /
  webpack alias 設定を壊さない（eval-require 化すると Vercel で "Cannot find module" になる）
- **`preferRest: true` 必須**（`lib/firebase-admin.ts` で適用済み。外すと Vercel で読み取りが断続500）
- **読み取り回数を増やさない**: 高頻度アクセスは `getMainData`(30秒キャッシュ) /
  `loadCalendarMatrix`(20秒キャッシュ) 経由で。ポーリング間隔を短くしない
  （クォータ超過で全画面500になった障害歴あり。恒久対策は Blaze 化）
- **Admin SDK は rules をバイパスする** → 誤消去ガードは rules でなくコード層
  （`lib/firestore-safe.ts`）+ `npm run lint:firestore` + 日次バックアップで担保
- 診断: `GET /api/health`（adminMode / readOk / readError）。readError.code 8/429 は
  クォータ超過（コードのバグではない）
