/**
 * 2026年度の新体系への移行データ（現員10名）。
 *
 * docs/wage-system.md 第12節の移行表。移行方式は「現在の日額に近い号へ
 * 読み替える（日額は下げない）」。現員の jpGrade / jpStep を初期投入する
 * ためのシード。移行前日額から stepForDaily() で読み替えた結果と一致する。
 *
 * ⚠️ workerId は本番の人員マスタに合わせて確定させること（下記は氏名ベースの暫定）。
 *    投入スクリプトで氏名→id を解決してから jpGrade/jpStep をセットする。
 */
import type { JpGrade } from './jp-wage'

export interface MigrationSeed {
  name: string
  grade: JpGrade
  /** 移行前日額（読み替えの入力）。 */
  fromDaily: number
  /** 読み替え後の号（fromDaily を stepForDaily で読み替えた値と一致する）。 */
  step: number
}

export const MIGRATION_2026: MigrationSeed[] = [
  { name: '大川 愛志', grade: '6G', fromDaily: 23550, step: 22 },
  { name: '白戸 寛之', grade: '6G', fromDaily: 21300, step: 13 },
  { name: '日比 大介', grade: '5G', fromDaily: 17780, step: 7 },
  { name: '入江 隆太', grade: '4G', fromDaily: 19700, step: 29 },
  { name: '倉本 隆次', grade: '4G', fromDaily: 19100, step: 25 },
  { name: '藤野 伸一', grade: '4G', fromDaily: 18620, step: 22 },
  { name: '本田 文人', grade: '3G', fromDaily: 17655, step: 33 },
  { name: '山崎 春奈', grade: '2G', fromDaily: 12225, step: 6 },
  { name: '濱上 祥太郎', grade: '1G', fromDaily: 11235, step: 6 },
  { name: '新山 正昭', grade: 'doko', fromDaily: 12300, step: 5 },
]
