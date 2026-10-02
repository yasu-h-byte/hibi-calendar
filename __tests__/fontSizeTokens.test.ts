/**
 * 文字の大きさは px 指定（text-[10px]）でなく rem の名前つきサイズ（tailwind.config.ts fontSize）を使う（2026-10-03 UI の磨き込み）。
 * 旧: px 指定が約650か所あり、「大きい文字」（html の font-size を 18px にする）が効かなかった。
 * 印刷用の画面（紙の見た目を変えない）だけ px を認める。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..')
/** px のまま残す印刷用の画面 */
const PRINT_ONLY = [
  'app/wage/notice/', 'app/(app)/monthly/audit-print/', 'app/evaluation/[id]/print/',
  'components/wage/', 'components/monthly/PayrollAuditContent.tsx', 'app/(app)/peer-invoice/page.tsx',
  'app/calendar/site/[siteId]/',
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

describe('文字の大きさの指定', () => {
  test('印刷用の画面以外で text-[Npx] を使っていない', () => {
    const bad: string[] = []
    for (const f of [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'components')), ...files(path.join(ROOT, 'lib'))]) {
      const rel = path.relative(ROOT, f)
      if (PRINT_ONLY.some(p => rel.startsWith(p) || rel === p)) continue
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        if (/text-\[\d+(\.\d+)?px\]/.test(line)) bad.push(`${rel}:${i + 1}`)
      })
    }
    expect(bad, 'text-2xs / text-xxs / text-xs / text-13 / text-sm / text-15 … を使ってください（tailwind.config.ts fontSize）').toEqual([])
  })
})
