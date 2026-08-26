/**
 * ベース年収の推移（2016年度〜2026年度）。
 *
 * 給料表（とび事業部給料表）の右側に載っている履歴。システムに過去の改定記録が
 * 無いため、2025年10月改定版の実物から転記した。以後の改定は年次改定の確定時に
 * 自動で積み上がるので、**手で足すのはこの初期データだけ**。
 *
 * 年は**年度**（10月始まり）。2025年10月改定 → 2026年度。
 *
 * ## 転記の検算
 * 給料表の「確定日給 × 310」が最終年度、「改訂前 × 310」が前年度と一致するはず。
 * 7名×2年 = 14点すべてで一致することを `__tests__/jpWageHistory.test.ts` で確認している。
 * 数字を読み違えていれば、この検算で落ちる。
 */

export interface AnnualPoint {
  /** 年度（10月始まり） */
  year: number
  /** ベース年収 = 確定日給 × 310 */
  baseAnnual: number
}

/** workerId → 年度ごとのベース年収。空白の年は行ごと持たない。 */
export const WAGE_HISTORY_SEED: Record<number, AnnualPoint[]> = {
  // 大川 愛志（5G 36号 / 確定日給 23,550）
  3: [
    { year: 2016, baseAnnual: 5351467 },
    { year: 2017, baseAnnual: 5537067 },
    { year: 2018, baseAnnual: 5735000 },
    { year: 2019, baseAnnual: 6002840 },
    { year: 2020, baseAnnual: 6181400 },
    { year: 2021, baseAnnual: 6417000 },
    { year: 2022, baseAnnual: 6556500 },
    { year: 2023, baseAnnual: 6603000 },
    { year: 2024, baseAnnual: 6649500 },
    { year: 2025, baseAnnual: 7021500 },
    { year: 2026, baseAnnual: 7300500 },
  ],
  // 白戸 寛之（5G 21号 / 確定日給 21,300）
  2: [
    { year: 2016, baseAnnual: 5351467 },
    { year: 2017, baseAnnual: 5537067 },
    { year: 2018, baseAnnual: 5735000 },
    { year: 2019, baseAnnual: 5805990 },
    { year: 2020, baseAnnual: 5958200 },
    { year: 2021, baseAnnual: 6144200 },
    { year: 2022, baseAnnual: 6255800 },
    { year: 2023, baseAnnual: 6255800 },
    { year: 2024, baseAnnual: 6255800 },
    { year: 2025, baseAnnual: 6441800 },
    { year: 2026, baseAnnual: 6603000 },
  ],
  // 入江 隆太（4G 41号 / 確定日給 19,700）2016・2017年度は空欄
  7: [
    { year: 2018, baseAnnual: 5100000 },
    { year: 2019, baseAnnual: 5181414 },
    { year: 2020, baseAnnual: 5224600 },
    { year: 2021, baseAnnual: 5441600 },
    { year: 2022, baseAnnual: 5624280 },
    { year: 2023, baseAnnual: 5698000 },
    { year: 2024, baseAnnual: 5809400 },
    { year: 2025, baseAnnual: 5958200 },
    { year: 2026, baseAnnual: 6107000 },
  ],
  // 倉本 隆次（4G 36号 / 確定日給 19,100）
  5: [
    { year: 2016, baseAnnual: 4495000 },
    { year: 2017, baseAnnual: 4674800 },
    { year: 2018, baseAnnual: 4816000 },
    { year: 2019, baseAnnual: 5011086 },
    { year: 2020, baseAnnual: 5222720 },
    { year: 2021, baseAnnual: 5367240 },
    { year: 2022, baseAnnual: 5513200 },
    { year: 2023, baseAnnual: 5586200 },
    { year: 2024, baseAnnual: 5623400 },
    { year: 2025, baseAnnual: 5772200 },
    { year: 2026, baseAnnual: 5921000 },
  ],
  // 日比 大介（4G 25号 / 確定日給 17,780）
  6: [
    { year: 2016, baseAnnual: 3543000 },
    { year: 2017, baseAnnual: 3811760 },
    { year: 2018, baseAnnual: 4092000 },
    { year: 2019, baseAnnual: 4284510 },
    { year: 2020, baseAnnual: 4442300 },
    { year: 2021, baseAnnual: 4589550 },
    { year: 2022, baseAnnual: 4736800 },
    { year: 2023, baseAnnual: 4825150 },
    { year: 2024, baseAnnual: 4942950 },
    { year: 2025, baseAnnual: 5251400 },
    { year: 2026, baseAnnual: 5511800 },
  ],
  // 本田 文人（3G 50号 / 確定日給 17,655）
  4: [
    { year: 2016, baseAnnual: 4794667 },
    { year: 2017, baseAnnual: 4856533 },
    { year: 2018, baseAnnual: 4898000 },
    { year: 2019, baseAnnual: 4946670 },
    { year: 2020, baseAnnual: 5090200 },
    { year: 2021, baseAnnual: 5178550 },
    { year: 2022, baseAnnual: 5266900 },
    { year: 2023, baseAnnual: 5296350 },
    { year: 2024, baseAnnual: 5325800 },
    { year: 2025, baseAnnual: 5414150 },
    { year: 2026, baseAnnual: 5473050 },
  ],
  // 新山 正昭（3G 12号 / 確定日給 12,300）2016・2017年度は空欄
  11: [
    { year: 2018, baseAnnual: 3410000 },
    { year: 2019, baseAnnual: 3487500 },
    { year: 2020, baseAnnual: 3551050 },
    { year: 2021, baseAnnual: 3575850 },
    { year: 2022, baseAnnual: 3600650 },
    { year: 2023, baseAnnual: 3625760 },
    { year: 2024, baseAnnual: 3625760 },
    { year: 2025, baseAnnual: 3760300 },
    { year: 2026, baseAnnual: 3813000 },
  ],
}

/**
 * 2025年10月改定版の給料表に載っていた日給。転記の検算に使う。
 * [workerId, 確定日給, 改訂前]
 */
export const SHEET_2025_10: Array<[number, number, number]> = [
  [3, 23550, 22650],
  [2, 21300, 20780],
  [7, 19700, 19220],
  [5, 19100, 18620],
  [6, 17780, 16940],
  [4, 17655, 17465],
  [11, 12300, 12130],
]
