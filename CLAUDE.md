# HIBI CONSTRUCTION 就業カレンダーシステム - 開発ルール

各仕様の詳細は `docs/` ディレクトリを参照。仕様変更時は該当ドキュメントを更新すること。

## 仕様ドキュメント

| ファイル | 内容 |
|---------|------|
| [docs/company.md](docs/company.md) | 会社概要・組織構成・従業員構成 |
| [docs/labor-rules.md](docs/labor-rules.md) | 労働時間・変形労働時間制・運用サイクル |
| [docs/salary-calculation.md](docs/salary-calculation.md) | 給与計算（日給月給制・時給制）・鳶土工合計ルール |
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

### 旧アプリとの関係
- 旧アプリ（dedura-kanri）の保存機能は**完全無効化済み**
- Firestoreは共有だが、旧アプリからの書き込みは発生しない
- 新システムに完全移行済み（2026年4月〜）

### コミットルール
- Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com> を付与
- 日本語でコミットメッセージを記述

### 承認フローの原則
**現場レベルの作業は職長、最終承認は事業責任者（政仁さん）。この原則はすべての機能に適用する。**

- **就業カレンダー**: 職長が作成・提出 → 政仁さんが最終承認
- **出面（出退勤）**: スタッフが入力 → 職長が確認・ロック → 政仁さんが最終承認
- **有給申請**: スタッフが申請 → 管理者が承認
- 新機能を追加する際も、この承認フローの原則に従うこと
- 職長が直接「最終承認」する機能は作らない（職長は「提出」「確認」まで）

### 問題解決の原則
**表面的な症状を直すだけでなく、必ず本質的な原因まで遡って解決すること。**

- バグ修正時は「なぜこの問題が起きたのか」を根本原因まで掘り下げる
- 同じ種類の問題が他の箇所にもないか横展開で確認する
- 一時的な回避策（ワークアラウンド）ではなく、構造的な解決を優先する
- データ構造やロジックの設計に問題がある場合は、パッチではなく設計を見直す
- 修正後は「この修正で同種の問題が二度と起きないか」を検証する

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
