/**
 * 退職「予定」の扱い（2026-10-02 総合点検）
 *
 * 退職日は 'YYYY-MM-DD' の文字列で、先の日付＝退職予定（在籍中）がある。
 * `!w.retired` のような真偽値の検査は「退職日が入っているか」でしかなく、退職予定の在籍者まで
 * 退職済みとして一覧・候補・ログインから外していた（人員マスタ・書類庫・評価・賞与・年次改定・名前リスト）。
 * 直した画面と API が、同じ書き方に戻らないことをソースの走査で落とす。
 * 判断して残す行は、同じ行の末尾に `// retired-ok: 理由` を書く（scripts/lint-retired-flag.mjs と同じ印）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const FILES = [
  'app/(app)/workers/page.tsx',
  'app/(app)/workers/RaiseHistoryTab.tsx',
  'app/(app)/staff-docs/page.tsx',
  'app/(app)/evaluation/page.tsx',
  'app/(app)/compensation/page.tsx',
  'app/(app)/wage/page.tsx',
  'app/(app)/wage/components/PromotionPanel.tsx',
  'app/api/jp-wage/revision/route.ts',
  'app/api/jp-wage/seed/route.ts',
]
// `w.retired ? 退職予定 : null` のような「退職日が入っているか」の表示は、retiredNow を先に見ていれば正しいので対象にしない
const BAD = [/![\w.]+\.retired\b/, /\bif\s*\(\s*[\w.]+\.retired\s*\)/]

describe('退職予定の在籍者を退職済みとして扱わない', () => {
  for (const rel of FILES) {
    it(`${rel} に真偽値の retired 判定が無い`, () => {
      const lines = readFileSync(join(ROOT, rel), 'utf-8').split('\n')
      const hits: string[] = []
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\{\/\*)/.test(line)) return
        if (/retired-ok/.test(line)) return
        if (/retired\s*[?:]\s*(string|boolean)/.test(line)) return
        if (BAD.some(re => re.test(line))) hits.push(`${i + 1}: ${line.trim()}`)
      })
      expect(hits, hits.join('\n')).toEqual([])
    })
  }
  it('人員マスタと書類庫は isAlreadyRetired で判定している', () => {
    for (const rel of ['app/(app)/workers/page.tsx', 'app/(app)/staff-docs/page.tsx']) {
      expect(readFileSync(join(ROOT, rel), 'utf-8')).toMatch(/isAlreadyRetired\(/)
    }
  })
})
