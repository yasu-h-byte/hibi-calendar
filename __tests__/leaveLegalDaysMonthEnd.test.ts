import { describe, test, expect } from 'vitest'
import { calcLegalPL, serviceMonthsAt, legalDaysForServiceMonths, validateGrantInput, jpDeemedDate } from '@/lib/leave-compute'
import { calcLegalPL as calcLegalPLClient } from '@/lib/leave-utils'
import { addMonthsSafe, addDaysIso } from '@/lib/date-utils'

/**
 * 法定付与日数 × 付与日（2026-10-02 総合点検）
 *
 * 付与日は addMonthsSafe（応当日が無い月は末日）で決めるのに、勤続月数は「付与日の日 ≥ 入社日の日」で数えていたため、
 * 月末（29〜31日）入社の人は初回付与日（例: 8/31 入社 → 2/28）が5か月扱いで法定0日になり付与を拒否され、
 * 以後も毎年1段階少なかった。入社日 1〜31日 × 全月の総当たりで、付与日当日は表どおり・前日は1段階前になることを固定する。
 */
const TABLE = [10, 11, 12, 14, 16, 18, 20, 20]

function* allHireDates(): Generator<string> {
  for (const y of [2023, 2024]) {           // 2024 はうるう年（2/29 入社を含む）
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(y, m, 0).getDate()
      for (let d = 1; d <= dim; d++) yield `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }
}

describe('calcLegalPL: 入社日 1〜31日 × 全月の総当たり', () => {
  test('付与日当日は勤続の表どおり、前日は1段階前。画面版（leave-utils）も同じ。付与の検証も通る', () => {
    let checked = 0
    for (const hire of allHireDates()) {
      for (let k = 0; k < TABLE.length; k++) {
        const grant = addMonthsSafe(hire, 6 + 12 * k)
        expect(calcLegalPL(hire, grant), `${hire} → ${grant}`).toBe(TABLE[k])
        expect(calcLegalPLClient(hire, grant).days, `${hire} → ${grant} (client)`).toBe(TABLE[k])
        expect(serviceMonthsAt(hire, grant), `${hire} → ${grant} months`).toBe(6 + 12 * k)
        // 前日はまだ前の段階（初回の前日は 0 日）
        const prevDay = addDaysIso(grant, -1)
        expect(calcLegalPL(hire, prevDay), `${hire} → ${prevDay}`).toBe(k === 0 ? 0 : TABLE[k - 1])
        // 付与の検証（表どおりの日数）は通る
        expect(validateGrantInput({ grantDays: TABLE[k], hireDate: hire, grantDate: grant }).ok, `${hire} → ${grant} validate`).toBe(true)
        checked++
      }
    }
    expect(checked).toBe(731 * TABLE.length)
  })

  test('旧実装で落ちていた例: 入社 2025-08-31 → 2026-02-28 は10日、翌年 2027-02-28 は11日', () => {
    expect(calcLegalPL('2025-08-31', '2026-02-28')).toBe(10)
    expect(calcLegalPL('2025-08-31', '2027-02-28')).toBe(11)
    expect(calcLegalPL('2025-08-31', '2026-02-27')).toBe(0)
    expect(validateGrantInput({ grantDays: 11, hireDate: '2025-08-31', grantDate: '2027-02-28' }).ok).toBe(true)
  })

  test('10/1 へ前倒しした日本人（入社 2024-03-31・付与 2026-10-01）はみなし日 2027-09-30 の勤続で14日', () => {
    const deemed = jpDeemedDate('2024-03-31', '2026-10-01')
    expect(deemed).toBe('2027-09-30')
    expect(calcLegalPL('2024-03-31', deemed)).toBe(14)
  })

  test('うるう年 2/29 入社: 初回 8/29、翌年 2/28（6か月後の応当日）', () => {
    expect(calcLegalPL('2024-02-29', '2024-08-29')).toBe(10)
    expect(calcLegalPL('2024-02-29', '2025-08-29')).toBe(11)
    expect(calcLegalPL('2024-02-29', '2025-08-28')).toBe(10)
  })

  test('不正な日付は 0・null', () => {
    expect(calcLegalPL('', '2026-01-01')).toBe(0)
    expect(calcLegalPL('2025-13-01', '2026-01-01')).toBe(0)
    expect(serviceMonthsAt('abc', '2026-01-01')).toBeNull()
    expect(legalDaysForServiceMonths(5)).toBe(0)
    expect(legalDaysForServiceMonths(78)).toBe(20)
  })
})
