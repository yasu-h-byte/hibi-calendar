# Firebase Admin SDK 移行手順（セキュリティ根治）

> 最終更新: 2026-06-13
> 対象読者: パートA = 靖仁さん（非エンジニア）/ パートB = エンジニア
> 関連: `lib/firebase-admin.ts`（土台・実装済み）、`firestore.rules.locked`（切替用 rules 雛形）

---

## 0. これは何のための作業か（背景）

現状、Firestore のセキュリティルールは「誰でも読み書きできる（`allow read, write: if true`）」状態の箇所が多く、
**Firebase の API キーは公開情報のため、理論上は未認証の第三者がブラウザから
`demmen/main` を直接読み書きできてしまう**（個人パスワードの平文・全スタッフの単価・
給与額の閲覧、単価改竄、月締め解除など）。これは基幹システムとして最大の穴です。

これを根治する唯一の方法が **Firebase Admin SDK 移行**です:

1. サーバ（API）からの Firestore アクセスを「サービスアカウント権限」で行う（= Admin SDK）。
   Admin SDK は rules を**バイパス**する特権を持つ。
2. その上で `firestore.rules` を **deny-by-default（全拒否）** に切り替える。
   → クライアント（ブラウザ）からの直接アクセスが一切できなくなる。
   → サーバは Admin SDK なので影響を受けず、画面機能は従来どおり動く。

本システムは**全データアクセスが API（サーバ）経由**であることを確認済み（2026-06-13 監査）。
クライアントが Firestore を直接読む箇所は無いため、deny 化しても画面は壊れません。

### 現状の安全装置（移行前でも壊れない仕組み）

`lib/firebase-admin.ts` は**デュアルモード**です:
- サービスアカウントが**未設定なら従来どおり Web SDK** を使う（挙動ゼロ変化）。
- サービスアカウントを設定したときだけ Admin SDK が有効になる。

つまり、env を設定するまでこのコードは休眠しており、本番に影響しません。

---

## パートA. 靖仁さんがやること（鍵の発行と設定）

> ⚠️ ここで扱う「サービスアカウント秘密鍵」は**システムの全権限を持つ最重要機密**です。
> チャット・メール・Slack 等に貼らない／他人に渡さないでください。
> ターミナル操作に不安があれば、この作業はエンジニア同席で行うことを推奨します。

### A-1. サービスアカウント秘密鍵を発行する（クリックのみ）

1. https://console.firebase.google.com/ を開き、プロジェクト **dedura-kanri** を選ぶ
2. 左上の歯車アイコン ⚙️ →「**プロジェクトの設定**」
3. 上部タブの「**サービス アカウント**」を開く
4. 「**新しい秘密鍵を生成**」ボタンを押す → 確認ダイアログで「**キーを生成**」
5. JSON ファイルが**ダウンロード**される（例: `dedura-kanri-xxxxx.json`）

このファイルが秘密鍵です。デスクトップなど分かる場所に置いておきます。

### A-2. 秘密鍵を base64 という形式に変換する（ターミナルに1行）

Vercel に安全に渡すため、鍵を1行のテキスト（base64）に変換します。

Mac の「ターミナル」アプリを開き、次の1行を貼り付けて実行します
（`~/Downloads/dedura-kanri-xxxxx.json` の部分は、ダウンロードした実際のファイル名に置き換え。
ファイルをターミナルにドラッグ&ドロップするとパスが入力されます）:

```bash
base64 -i ~/Downloads/dedura-kanri-xxxxx.json | pbcopy
```

これで変換結果が**クリップボードにコピー**されます（画面には何も出ませんが成功です）。

### A-3. Vercel に環境変数として貼る（コピペ）

1. https://vercel.com/ にログインし、このプロジェクトを開く
2. 「**Settings**」→「**Environment Variables**」
3. 次の1個を追加:
   - **Name**: `FIREBASE_SERVICE_ACCOUNT_B64`
   - **Value**: A-2 でコピーした内容を貼り付け（Cmd+V）
   - **Environments**: Production と Preview の両方にチェック
4. 「**Save**」

### A-4. 再デプロイ

Vercel の「**Deployments**」→ 最新デプロイの「…」メニュー →「**Redeploy**」。
（または GitHub に何かコミットされれば自動で再デプロイされます）

### A-5. 後始末（重要）

- A-1 でダウンロードした JSON ファイルは、設定が終わったら**ゴミ箱に入れて削除**してください
  （Vercel に入った値が本番で使われるので、ローカルの鍵ファイルは不要）。
- 鍵を再発行したくなったら A-1 からやり直し、Vercel の値を差し替えます。

> ここまでで「サーバが Admin SDK で動く準備」が整います。ただし、実際に
> Admin SDK 経由に切り替える&rules を deny にするのはパートB（エンジニア作業）です。
> **A だけ済ませても、B が未実施なら従来どおり Web SDK のまま**動きます（安全）。

---

## パートB. エンジニアがやること（移行の実装と切替）

### B-1. firebase-admin を依存に追加

```bash
npm install firebase-admin
git add package.json package-lock.json && git commit -m "deps: firebase-admin"
```

`lib/firebase-admin.ts` は eval-require で読むため未インストールでもビルドは通るが、
実際に Admin モードを使うにはインストールが必要。

### B-2. `lib/fsdb.ts`（Web SDK 互換シム）を実装

サーバ各所が使う Firestore 関数を、Admin 有効時は Admin、無効時は Web SDK に振り分ける
アダプタを作る。**Web SDK と同じ関数シグネチャ**を提供し、各ファイルは import 元を
`firebase/firestore` → `@/lib/fsdb` に差し替えるだけで移行できる設計にする。

実装が必要な API（監査時点の使用実績）:
`doc / collection / getDoc / getDocs / setDoc / updateDoc / deleteDoc / addDoc /
query / where / orderBy / limit / deleteField / runTransaction`

要注意の差異（Admin SDK ⇄ Web SDK）:
- snapshot: Web は `snap.exists()`（メソッド）、Admin は `snap.exists`（プロパティ）。
  → アダプタで Web 形式（`exists()` メソッド + `data()`）にラップして返す。
- `getDocs` の戻り: `forEach` / `docs` / `size` / `empty` を Web 互換で提供。
- `setDoc(ref, data, { merge: true })`: Admin は `ref.set(data, { merge: true })`。
- `updateDoc(ref, { 'a.b.c': v })`: dot-path 更新は Admin もドット記法対応。
- `deleteField()`: Admin は `admin.firestore.FieldValue.delete()`。
- `runTransaction(db, fn)`: Admin は `db.runTransaction(fn)`、tx の get/set/update/delete を
  Web 互換でラップ。
- `serverTimestamp` 等は本リポジトリでは未使用。

> 実装は必ず **Firebase エミュレータ or プレビュー環境で全 API を実行検証**してから本番へ。
> 検証できない状態で本番投入しない（基幹システム）。

### B-3. サーバ側 import を一括差し替え（Sprint3-2）

`app/api/**` と サーバ専用 lib（auth/attendance/workers/worker-crud/compute/
firestore-safe/locks/activity/leave-auto/calendar-matrix/sites/repositories/* 等）の
`from 'firebase/firestore'` を `from '@/lib/fsdb'` に変更。

`lib/firebase.ts`（Web SDK の `db`）はクライアント用に残す。

### B-4. ステージング検証

プレビュー環境（FIREBASE_SERVICE_ACCOUNT_B64 設定済み）で以下を全て確認:
- 出面入力（スタッフ/職長/管理者）・職長承認・最終承認
- 月次集計の表示・Excel 出力・締め/解除・締め後の差分検知
- 有給申請/承認/却下/日付変更/時季指定、帰国申請/承認
- カレンダー作成/承認/公開ページ（ログイン不要ページ）
- バックアップ スナップショット/復元、設定（単価・パスワード）

### B-5. rules を deny-by-default に切替

全機能の動作確認後:

```bash
cp firestore.rules firestore.rules.permissive.bak   # 念のため現行を退避
cp firestore.rules.locked firestore.rules
firebase deploy --only firestore:rules --project dedura-kanri
```

切替後、もう一度 B-4 の全機能を確認（特に公開カレンダーページ）。

### ロールバック

問題が出たら:
- **rules だけ戻す**: `firestore.rules.permissive.bak` を `firestore.rules` に戻して deploy。
- **Admin モードごと戻す**: Vercel の `FIREBASE_SERVICE_ACCOUNT_B64` を削除して再デプロイ
  （Web SDK にフォールバック）。rules が deny のままだと Web SDK では動かないので、
  rules も許可版に戻すこと。

---

## チェックリスト（移行完了の定義）

- [ ] A: サービスアカウント鍵を Vercel に設定済み
- [ ] B-1: firebase-admin 依存追加
- [ ] B-2: lib/fsdb.ts 実装 + エミュレータ検証
- [ ] B-3: サーバ import を fsdb に差し替え
- [ ] B-4: プレビューで全機能確認
- [ ] B-5: rules を locked 版に切替 + 本番確認
- [ ] 旧 permissive rules をバックアップ保持

---

# 運用の要点・障害履歴（CLAUDE.md から移設 2026-07-03）

## セキュリティ根治（Admin SDK 移行）— ✅ 完了（2026-06-29）

**かつての穴**: `firestore.rules` が多くのコレクションで `allow read, write: if true` だったため、
Firebase API キーが公開情報であることと相まって**未認証の第三者がブラウザから直接 Firestore を
読み書きできた**（個人パスワード平文・単価・給与額の閲覧、改竄、月締め解除等）。

**根治済み**: サーバの Firestore アクセスを全て Firebase Admin SDK（rules バイパス特権）に移行し、
`firestore.rules` を **deny-by-default**（`match /{document=**} { allow read, write: if false }`）に切替。
本番で「未認証の直アクセス→`permission-denied`」「アプリ（Admin経由）→正常」の両方を実機確認済み。

- **稼働モード確認**: `GET /api/health` が `{adminMode, status, hasRawEnv, errorHint}` を返す（秘密なし）。
  本番は `adminMode:true / status:"active"`。`false` なら鍵未設定 or 初期化失敗（errorHint で診断）。
- **鍵**: Vercel env `FIREBASE_SERVICE_ACCOUNT`（JSON直貼り。`_B64` も可）を Production+Preview に設定済。
  `lib/firebase-admin.ts` がデュアルモード（鍵が無ければ Web SDK へ完全パススルー）。
- **重要な実装上の罠**（再発防止）:
  - `firebase-admin` は `next.config.js` の `experimental.serverComponentsExternalPackages` で
    サーバ外部化＋トレース、`webpack` の `resolve.alias` でクライアント側は空モジュール化。
    （eval-require だと Next の依存トレーサからも隠れて Vercel で "Cannot find module" になる）
  - firebase-admin **v14 はモジュラーAPI**（`firebase-admin/app` の initializeApp/getApps/cert、
    `firebase-admin/firestore` の getFirestore/FieldValue）。旧 `admin.apps`/`admin.firestore()` は無い。
  - サーバの Firestore アクセスは**静的・動的 import とも** `@/lib/fsdb` に統一（`firebase/firestore`
    を直接 import しない。`lib/firebase.ts` の Web SDK 初期化のみ例外）。
  - **`preferRest: true` 必須**（2026-06-30 障害で判明）。Vercel サーバレスでは firebase-admin の
    既定 gRPC 接続が warm 関数の idle で切れ、**読み取りが断続的に 500**（再デプロイで一時回復）。
    `lib/firebase-admin.ts` で `getFirestore().settings({ preferRest: true })` を適用し REST に固定。
    症状が再発したら `/api/health` は adminMode:true のまま読取系だけ 500 になるのが目印。

## Firestore 読み取りコスト／クォータ（2026-07-02 障害で判明）

**事象**: 本番で全ページが「データ取得に失敗」（恒常 500）。`/api/health` が `adminMode:true` かつ
`readError.code:8/429 RESOURCE_EXHAUSTED "Quota exceeded"`＝**Firestore の読み取りクォータ超過**。
gRPC/REST どちらでも同じ（通信方式は無関係）。原因は **Admin SDK 移行で全読み取りがサーバ集約され
ブラウザキャッシュが消え、読み取り回数が急増**して Spark(無料)の日次上限(5万reads/日)に到達したこと。

- **診断**: `GET /api/health` に `readOk`/`readError`（実 getDoc プローブ）を実装済。adminMode:true かつ
  readOk:false／readError.code が 8 or 429 なら**クォータ超過**（コードのバグではない）。
- **恒久対策**: Firebase を **Blaze（従量課金）** に。14人規模なら月数十〜数百円。無料枠5万/日は実運用に狭い。
- **読み取り削減（実装済・低コスト化）**: `getMainData` 30秒キャッシュ（`invalidateMainCache()`／worker編集で無効化）、
  `loadCalendarMatrix` 20秒キャッシュ（`invalidateCalendarMatrixCache()`）、保守ポーリング 30秒→5分。
  **新しい高頻度エンドポイントを足すときは getMainData/loadCalendarMatrix のキャッシュ経由を使い、
  ポーリング間隔を短くしすぎない**こと。
- 一時的には太平洋時間の深夜（JST 昼ごろ）にクォータが自動リセットされ復旧するが、Blaze化しないと再発する。
- **⚠️ 副作用**: Admin SDK は rules を完全バイパスするため、`notWipingMap()` 等の**ルールレベルの
  誤消去ガードは無効化**された。誤消去対策はコード層（`lib/firestore-safe.ts`）＋ `npm run lint:firestore`
  ＋日次バックアップ（`backups`）で担保する。
- **ロールバック**: 問題時は (1) Vercel の `FIREBASE_SERVICE_ACCOUNT` を削除（→ Web SDK に戻る）
  **かつ** (2) `firestore.rules` を許可版（`firestore.rules.permissive-rollback`）に戻して deploy。
  rules の deploy は Firebase MCP（temp/worktree を project_dir に → `firebase_deploy --only firestore`）。
- 手順詳細: **[docs/admin-sdk-migration.md](docs/admin-sdk-migration.md)**。
