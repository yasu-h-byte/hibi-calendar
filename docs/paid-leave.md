# 有給休暇管理

## 法定付与日数（労働基準法第39条）
| 勤続 | 0.5年 | 1.5年 | 2.5年 | 3.5年 | 4.5年 | 5.5年 | 6.5年〜 |
|------|-------|-------|-------|-------|-------|-------|---------|
| 日数 | 10日  | 11日  | 12日  | 14日  | 16日  | 18日  | 20日    |

- 勤続年数は月数ベースで計算（浮動小数点誤差を回避）
- 入社6ヶ月後に初回付与、以降は毎年付与

## ロール別付与ルール

| 区分 | visa | 付与サイクル | 繰越 | 期末買取 |
|------|------|------------|------|---------|
| 役員（yakuin） | - | 有給管理対象外 | - | - |
| 事務（jimu） | - | 有給管理対象外 | - | - |
| 職長（日本人） | none | **10/1 起点（一律）** | なし（強制0） | あり（9/30残を給与に反映） |
| 一般・とび（日本人） | none | **10/1 起点（一律）** | なし（強制0） | あり |
| 実習生 | jisshu1/2 | 入社6ヶ月後起点（個別） | あり（上限20日） | なし |
| 特定技能 | tokutei1/2 | 入社6ヶ月後起点（個別） | あり（上限20日） | なし |

## データ構造（PLRecord）

`demmen/main` の `plData[workerId]` に配列で格納。

```typescript
{
  // コア
  fy: string                    // 付与年度 (例: "2025")
  grantDate: string             // ISO date (例: "2025-10-01")
  grantDays: number             // 当期付与日数
  carryOver: number             // 前期繰越（外国人のみ、上限20日）
  adjustment: number            // 調整（過去分の手動補正）
  used: number                  // 常に0（periodUsedが動的計算）

  // 監査情報（Phase 2で追加）
  grantedAt?: string            // ISO datetime
  grantedBy?: number | string   // workerId | 'admin' | 'super-admin'
  method?: string               // 'manual' | 'auto-pending' | 'migration' | 'legacy'
  lastEditedAt?: string
  lastEditedBy?: number | string
  adjustmentHistory?: Array<{
    at: string
    by: number | string
    field: string
    before: string
    after: string
  }>

  // 時効処理（Phase 3で追加）
  expiredDays?: number
  expiredAt?: string
  expiredBy?: number | string
  _archived?: boolean
}
```

## 付与フロー（3系統）

### 1. 手動付与（+ 有給付与ボタン）
- 管理画面右上の緑「+ 有給付与」→ ワーカー選択 → 付与日・日数入力 → 付与
- `method: 'manual'` で記録
- **繰越は自動計算**（外国人のみ）

### 2. 半自動付与（バナー経由）
- ページ上部のバナー「🌴 N名に有給付与の時期が来ています」をクリック
- モーダルで各スタッフの付与日・日数を確認・調整可能
- 対象検知ロジック:
  - 日本人: 当期（10/1起点）FYレコードが未作成
  - 外国人: 最新grantDate + 1年 が今日以前、かつ同期間の記録なし
  - 入社日未登録の場合は「⚠️ 要確認」フラグ＋デフォルトチェック外し
- `method: 'auto-pending'` で記録
- **繰越は自動計算**

### 3. 手動編集（編集モーダル）
- 一覧から各ワーカーをクリック → 編集モーダル
- `grantDate` / `grantDays` / `carryOver` / `adjustment` を個別編集可能
- 変更時に `adjustmentHistory` に記録

## 消化の管理

- **2025年2月以前**: 「調整」欄にスプレッドシート集計分を入力（移行期）
- **2025年3月以降**: 出面入力画面で有給日に「P」入力 → `periodUsed` で自動集計
- スマホから直接「P」は入力できず、**必ず有給申請フローを経由**

## 消化計算式

```
periodUsed = [grantDate, grantDate+1年) のPエントリ数
used = adjustment + periodUsed
total = grantDays + carryOver
remaining = max(0, total - used)
```

## 繰越計算（外国人のみ）

付与時に自動実行（共通ヘルパー `calcCarryOverForWorker`）:

```
前期レコード = 新付与日より前で最新のgrantDateを持つレコード
前期期間 = [前期grantDate, +1年)
periodUsed = 前期期間内のPエントリ数
残日数 = grantDays + carryOver - adjustment - periodUsed
新FYのcarryOver = min(20, max(0, 残日数))
```

- **日本人**: 期末買取制のため常に `carryOver = 0`
- **外国人**: 自動計算結果をセット

「繰越再計算」ボタンは旧データ修復用（通常は付与時に自動実行されるため不要）。

## 有給申請フロー

1. スタッフがスマホ出面画面「🌴 ゆうきゅうしんせい」ボタン → 申請モーダル
2. 残日数0の場合は申請不可
3. 職長が承認（第1段階）
4. 管理者（政仁）が最終承認 → 出面に「P」自動入力
5. 却下可能（職長または管理者）

### 申請ステータス

| status | 意味 | 備考 |
|--------|------|------|
| pending | 申請中（未承認） | スタッフが取り消し可能 |
| approved | 承認済み | 出面にP反映済み |
| rejected | 却下 | 同じ日付で再申請可能（status上書き） |
| cancelled | 取り消し | 同じ日付で再申請可能（status上書き） |

### スタッフによる取り消し（2026-04-30 追加）

- スマホ画面の申請履歴から、status=pending の申請のみ「取り消し / Hủy」ボタンで取り消し可能
- 取り消し後は status=cancelled になり、出面のPは反映されない（そもそも未承認のため反映されていない）
- 同じ日付で再度申請する場合、status=cancelled / rejected のレコードは上書きされる
- 重複チェック: `status !== 'rejected' && status !== 'cancelled'` の既存申請があるときのみ「Already requested / 既に申請済み」エラー

帰国申請（`homeLongLeave`）にも同様の `cancelled` ステータスと取り消し機能が実装済み。

## 年5日取得義務（2019年法改正）

- 年10日以上付与された**外国人労働者**が対象
- 有効期限まで残り3ヶ月以内で未達の場合にアラート表示
- 日本人は対象外（期末買取制で補填）
- **TODO**: 未達時の時季指定UIは未実装（Phase 5候補）

## 有効期限・時効

- 付与日から2年間有効
- 期限切れ: `remaining = 0` として表示
- **時効処理（Phase 3）**: Vercel Cron で月1回、期限切れレコードに以下を自動記録
  - `expiredDays`: 失効した日数
  - `expiredAt`: 失効処理日時
  - `expiredBy`: 'system' or actor
  - `_archived: true` で以後の表示から除外
- 手動でも「⏳ 時効処理」ボタンで即時実行可能

## 監査機能（Phase 2）

労基法施行規則24条の7準拠の有給管理簿作成に対応:

- 付与時に `grantedAt`, `grantedBy`, `method` を自動記録
- 編集時に `adjustmentHistory` に変更前後を記録
- `getApiAuthUser()` で操作者を識別:
  - `SUPER_ADMIN_PASSWORD` → `'super-admin'`（日比靖仁）
  - `ADMIN_PASSWORD` → `'admin'`（共通）
  - 個人パスワード → `workerId`
- 編集モーダル内で「📋 監査情報」を参照可能

## データ正規化（Phase 1）

「🔧 データ正規化」ボタンで以下を冪等実行:

1. 旧フィールド（`grant`/`carry`/`adj`）→ 新フィールドに昇格＆削除
2. `fy` を string型に統一
3. grantDate欠落レコードを補完（日本人: `${fy}-10-01`、外国人: 同fy他レコード参照）
4. 同一fy重複レコードを「最新grantDate優先」で集約
5. fy/grantDate年ズレを警告記録（「🔧 自動修正」ボタンで自動修正も可能）
6. 期限切れレコードに `_archived: true`
7. `method` 未設定レコードに `'legacy'` を付与

## 月別消化テーブル

休暇管理画面の「月別」タブでスタッフごとの各月の取得日数を表示。

### 表示仕様（2026-04-30 改修）

- **会社別に分割表示**: 「日比建設」「HFU」の2テーブルに分けて表示
- **集計範囲**: 月別消化（`monthlyUsage`）は **全期間集計**（2025年3月〜現在まで全P入力をカウント）
  - 残日数計算で使う `periodUsed` は引き続き「当期 [grantDate, +1年)」のみで集計
  - 月別タブの目的（履歴俯瞰）と残日数計算（期内消化）の役割を分離
- **出向中スタッフは除外**: `dispatchTo` が設定されており、現在月が `dispatchFrom` 以降のスタッフは有給管理ページから除外（出向先で管理されるため）
- **付与済みスタッフは消化0でも表示**: PLRecord が1件でもあるスタッフは行が空でも表示（残日数のみ確認できるよう、行は消えない）

## 有給管理台帳（Excel出力） — Phase 7 候補

- シート1「管理簿」: 基準日・付与日数・繰越・取得日数・残日数・**失効日数**・**買取日数**・有効期限
- シート2「取得日一覧」: スタッフごとの有給取得日を日付順で表示
- Phase 2+3の監査情報がすべて素材として揃っている

## 帰国期間中の有給事後計上（案B 機能）

「帰国期間(hk)マーカー」と「有給(p)」が競合するイレギュラー対応機能。

### 発生ケース
1. スタッフが帰国予定日以降の有給を事前申請
2. 管理者が出面入力で先に帰国期間(✈️ hk:1)を設定してしまう
3. その後、元の申請に基づいて P を計上したくても、PC出面入力画面では帰国期間中の編集がブロック
4. Firestore の `merge:true` も再帰マージのため、単に P を書き込むだけでは `hk` が残ってしまう

### 解決策（管理者手動P入力機能）
- 編集モーダル内「🗓 有給日を直接入力」ボタン → 時季指定モーダルを再利用
- チェックボックス「帰国期間(✈️)を上書きする」を ON にすると:
  - API: `designateLeaves` action に `overwriteHomeLeave: true` パラメータ
  - 内部: `setAttendanceEntry(... , { deleteFields: ['hk'] })` で `hk` を Firestore `deleteField()` で削除しつつ `{w:0, p:1}` を書き込み
- 記録される履歴: `designatedLeaves` 配列に `{ kind: 'manual-entry', overwroteHomeLeave: true, note }` として保存

### 運用方針
- **原則**: スタッフは帰国前に事前申請を徹底（これが一次防御）
- **例外対応**: 申請漏れ・管理者による帰国入力が先行したケースで、この機能を使う
- **ログ**: すべての手動P入力は監査ログに残るため、誰がいつ何日分を追加したか追跡可能

## Phase 実装履歴

- **Phase 1（完了）**: データ正規化マイグレーション実装
- **Phase 2（完了）**: 監査ログ基盤（grantedAt/By, method, adjustmentHistory）
- **Phase 2+（完了）**: 自動修正オプション（fy/grantDate年ズレ修正）
- **Phase 3（完了）**: 時効処理自動化（processExpiry + Vercel Cron）
- **Phase 4（完了）**: 繰越ボタンの整理、スマホP入力禁止の確認
- **Phase 5（完了）**: 年5日取得義務の時季指定UI
- **Phase 6（完了）**: 退職時清算・期末買取記録UI
- **Phase 7（完了）**: 有給管理簿Excel出力
- **案B（完了）**: 帰国期間中の有給事後計上機能（手動P入力 + 帰国マーカー上書き）

## 旧フィールドフォールバック（2026-04-30 修正）

`GET /api/leave` で返却するレコードは、新フィールドが優先・無ければ旧フィールドにフォールバックするよう統一済み。

```typescript
grantDays: r.grantDays ?? r.grant ?? 0
carryOver: r.carryOver ?? r.carry ?? 0
adjustment: r.adjustment ?? r.adj ?? 0
```

**経緯**: 旧フィールド `grant`/`carry`/`adj` が残っているレコードで、新フィールド `carryOver` が無条件に 0 で上書きされ、繰越が画面上で 0 表示されるバグがあった（commit 0adb25b）。データ正規化（Phase 1）で旧フィールドは削除されるが、未正規化レコードでも正しい値を返すよう、API 層でフォールバックを徹底した。

## 変更履歴

### 2026-04-30
- 申請ステータスに `cancelled` を追加。スタッフは pending のみ取り消し可能
- 取り消し済み・却下済みの申請は同じ日付で再申請可能に
- 月別タブを会社別（日比建設 / HFU）に分割。`monthlyUsage` を全期間集計に変更
- 出向中スタッフ（dispatchTo + dispatchFrom 以降）を有給管理ページから除外
- 付与済みスタッフは消化0でも表示（行が消えないよう改修）
- `GET /api/leave` の旧フィールド残留時の `carryOver = 0` 上書きバグを修正（新優先・旧フォールバック）
