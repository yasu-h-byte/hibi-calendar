# ゴールデンマスター（給与計算の凍結スナップショット）

2026-08-26 時点の本番データ（demmen/main・att_202606〜08・siteCalendar・homeLongLeave）を
そのまま固定したもの。`goldenMaster.test.ts` が本番APIと同じ引数で `computeMonthly` を実行し、
`expected/` の結果と1円単位で突き合わせる。

- **目的**: リファクタリングや機能追加で給与計算が「静かに」変わるのを機械的に検出する
- 意図して計算を変えたときだけ `UPDATE_GOLDEN=1 npm test -- goldenMaster` で更新し、
  差分をコミットメッセージで説明すること
- 個人の賃金を含むため、このリポジトリの公開範囲を変えないこと
