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
