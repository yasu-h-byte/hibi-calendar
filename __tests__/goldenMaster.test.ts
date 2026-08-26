/**
 * ゴールデンマスター: 給与計算の凍結スナップショット。
 *
 * 2026-08-26 時点の本番データ3ヶ月分（fixtures/golden/）に対して、
 * 本番API（/api/monthly）と**同じ引数**で computeMonthly を実行し、
 * expected/ に凍結した結果と1円単位で突き合わせる。
 *
 * これが落ちたら「給与計算の挙動が変わった」ということ。
 * - 意図しない変更 → 直す（このテストが仕事をした）
 * - 意図した変更 → `UPDATE_GOLDEN=1 npm test -- goldenMaster` で更新し、
 *   何がなぜ変わったのかをコミットメッセージに書く
 *
 * ⚠️ スナップショットの一括更新を「テストを通すための作業」にしないこと。
 *    差分の中身を1件ずつ説明できないなら、それは意図しない変更が混ざっている。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

const DIR = join(__dirname, 'fixtures', 'golden')
const EXPECTED_DIR = join(DIR, 'expected')
const UPDATE = process.env.UPDATE_GOLDEN === '1'
const MONTHS = ['202606', '202607', '202608'] as const

const loadJson = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as T

/**
 * 結果を安定した形に落とす。
 * - Map（_lhDayHours 等の内部キャッシュ）はスナップショット対象にしない
 * - workers/sites は id 順に並べ替え（Map の挿入順に依存しない）
 * - 小数の浮動誤差で偽の差分が出ないよう、数値は小数6桁に丸める
 */
function sanitize(value: unknown): unknown {
  if (value instanceof Map) return undefined
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number(value.toFixed(6))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue
      const s = sanitize(v)
      if (s !== undefined) out[k] = s
    }
    return out
  }
  return value
}

function runMonth(ym: string) {
  const main = loadJson<MainData>('main.json')
  const att = loadJson<{ d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>(`att_${ym}.json`)
  const calendars = loadJson<Record<string, Record<string, Record<string, string>>>>('calendars.json')
  const homeLeaves = loadJson<{ workerId: number; startDate: string; endDate: string }[]>('homeLeaves.json')

  // /api/monthly と同じ組み立て
  const prescribedDays = main.workDays[ym] || 0
  const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
  const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
  const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
  const calendarDaysMap = calendars[ym] || {}

  const result = computeMonthly(
    main, att.d, att.sd, ym, prescribedDays,
    hasCalendarData ? siteWorkDaysMap : undefined,
    baseDays, calendarDaysMap, homeLeaves,
  )
  return sanitize({
    workers: [...result.workers].sort((a, b) => a.id - b.id),
    subcons: [...result.subcons].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    sites: [...result.sites].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    totals: result.totals,
  })
}

describe('ゴールデンマスター（給与計算・本番データ3ヶ月）', () => {
  for (const ym of MONTHS) {
    it(`${ym} の計算結果が凍結時と一致する`, () => {
      const actual = runMonth(ym)
      const file = join(EXPECTED_DIR, `${ym}.json`)

      if (UPDATE || !existsSync(file)) {
        mkdirSync(EXPECTED_DIR, { recursive: true })
        writeFileSync(file, JSON.stringify(actual, null, 1))
        return
      }
      const expected = JSON.parse(readFileSync(file, 'utf-8'))
      expect(actual).toEqual(expected)
    })
  }

  it('決定性: 2回実行して同じ結果になる（隠れた時刻依存が無い）', () => {
    expect(runMonth('202607')).toEqual(runMonth('202607'))
  })
})
