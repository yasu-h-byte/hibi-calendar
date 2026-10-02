/**
 * 賃金予定がクライアントの JS に載らないことの検査（scripts/check-client-bundle-secrets.mjs）が
 * 空振りしていないかのテスト（2026-10-02）。
 *
 * 検査スクリプトは lib/wage-plan.server.ts の文字面から探す文字列を拾う。書き方が変わって
 * 拾えなくなると「何も見つからない＝合格」になってしまうので、実データの全員分を拾えているか確かめる。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SCHEDULED_WAGE_CHANGES, WAGE_CONTEXT } from '@/lib/wage-plan.server'
import { MIGRATION_2026 } from '@/lib/jp-wage-migration.server'
import { extractNeedles, PLAN_FILE, serverOnlyFiles, collectNeedles, scanStatic, unicodeEscaped } from '../scripts/check-client-bundle-secrets.mjs'

const ROOT = join(__dirname, '..')

describe('check-client-bundle-secrets の検査対象', () => {
  const needles: string[] = extractNeedles(readFileSync(PLAN_FILE, 'utf8'))

  it('予定のすべての「workerId:時給」を拾う', () => {
    for (const c of SCHEDULED_WAGE_CHANGES) {
      for (const [id, yen] of Object.entries(c.targets)) expect(needles).toContain(`${id}:${yen}`)
    }
  })

  it('改定の理由・個別事情の文章を拾う', () => {
    for (const c of SCHEDULED_WAGE_CHANGES) {
      expect(needles.some(n => c.reason.includes(n))).toBe(true)
    }
    for (const ctx of Object.values(WAGE_CONTEXT)) {
      expect(needles.some(n => ctx.detail.includes(n))).toBe(true)
    }
  })
})

describe('画面側のモジュールに予定表を書かない', () => {
  it('lib/wage-curve.ts・lib/wage-analysis.ts に予定の金額が無い', () => {
    const client = ['lib/wage-curve.ts', 'lib/wage-analysis.ts', 'app/(app)/wage-analysis/page.tsx']
      .map(f => readFileSync(f, 'utf8')).join('\n')
    for (const c of SCHEDULED_WAGE_CHANGES) {
      for (const [id, yen] of Object.entries(c.targets)) {
        expect(client).not.toMatch(new RegExp(`\\b${id}:\\s*${yen}\\b`))
      }
    }
  })
})

/*
 * 2026-10-02 総合点検: 検査対象を lib/**\/*.server.ts すべてに広げた。
 * - 実名＋日額を持つ lib/jp-wage-migration.server.ts の氏名を拾う
 * - *.server.ts は `import 'server-only'` を書く（画面から import するとビルドが止まる）
 * - *.server.ts を import してよいのは app/api・lib/*.server.ts・テスト・scripts だけ
 * - 圧縮後に日本語が \uXXXX になっていても見つける
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name === '.git') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('サーバー専用ファイル（*.server.ts）', () => {
  it('検査対象に wage-plan と jp-wage-migration の両方が入る', () => {
    const names = serverOnlyFiles().map((f: string) => relative(ROOT, f))
    expect(names).toContain('lib/wage-plan.server.ts')
    expect(names).toContain('lib/jp-wage-migration.server.ts')
  })
  it('日本人の実名（姓 名）を全員分拾う', () => {
    const needles = (collectNeedles() as string[][]).map(pair => pair[1])
    for (const m of MIGRATION_2026) expect(needles).toContain(m.name)
  })
  it("すべての *.server.ts が import 'server-only' を書いている", () => {
    for (const f of serverOnlyFiles()) {
      expect(readFileSync(f, 'utf8'), relative(ROOT, f)).toMatch(/^import 'server-only'/m)
    }
  })
  it('*.server.ts を画面側（app/api 以外の app・components・lib）から import していない', () => {
    const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
    const bad = files
      .map(f => relative(ROOT, f))
      .filter(f => !f.startsWith('app/api/') && !/\.server\.ts$/.test(f))
      .filter(f => /from ['"][^'"]*\.server['"]/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(bad).toEqual([])
  })
  it('圧縮後のチャンクで日本語が \\uXXXX になっていても見つける', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    writeFileSync(join(dir, 'a.js'), `x="${unicodeEscaped('梶原 祥雄')}"`)   // 圧縮後の形: "\u68b6\u539f \u7965\u96c4"
    writeFileSync(join(dir, 'b.js'), 'y="205:1585"')
    writeFileSync(join(dir, 'c.js'), 'z="なにもない"')
    const hits = (scanStatic(dir, ['梶原 祥雄', '205:1585', '載っていない文字列']) as string[][]).map(pair => [pair[0].split('/').pop(), pair[1]])
    expect(hits).toEqual([['a.js', '梶原 祥雄'], ['b.js', '205:1585']])
  })
})
