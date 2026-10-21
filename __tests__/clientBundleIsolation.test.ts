/**
 * 画面（クライアント）から届く import の連鎖に、サーバー専用の重い部品が混ざっていないか（2026-10-21 総点検）。
 *
 * 2026-10-21 まで、lib/workers.ts・lib/attendance.ts・lib/locks.ts・lib/compute.ts が「純粋な計算」と
 * 「Firestore を読む関数」を同じファイルに持っていたため、画面がそのファイルを import するだけで
 * Firebase Web SDK（圧縮後 約100KB）が 14 画面のクライアント JS に載っていた（/attendance・/workers・/settings 等）。
 * 実際にクライアントで Firestore を読む所は一つも無い（サーバーは Admin SDK・画面は API 経由）。
 *
 * 決まり: Firestore を読む・書く関数は `lib/*.server.ts`（または app/api 配下）に置き、画面から届く lib には
 * 純粋な計算と型だけを置く。このテストは、画面の静的 import をたどって禁止モジュールに届いたら落ちる。
 * `import type` と動的 import（`await import()`）はたどらない。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'

const ROOT = join(__dirname, '..')

/** クライアント JS に載せてはいけないモジュール（サーバー専用・重い） */
const FORBIDDEN = ['firebase/app', 'firebase/firestore', 'firebase-admin', 'xlsx', 'xlsx-js-style', 'pdfjs-dist', 'server-only']

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, re, out)
    else if (re.test(p)) out.push(p)
  }
  return out
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = join(dirname(from), spec)
  else return null
  for (const e of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const p = base + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

const cache = new Map<string, string[]>()
/** 静的 import の行き先（ファイルパス、または 'npm:<名前>'）。`import type` と動的 import は含めない */
export function staticImports(file: string): string[] {
  const hit = cache.get(file)
  if (hit) return hit
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(import|export)(\s+type)?\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue // import type … / export type … from
    const spec = m[3]
    const r = resolveSpec(file, spec)
    if (r) out.push(r)
    else if (!spec.startsWith('.') && !spec.startsWith('@/')) out.push('npm:' + spec)
  }
  // 副作用だけの import（import 'server-only' など）
  for (const m of src.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) out.push('npm:' + m[1])
  cache.set(file, out)
  return out
}

/** start から禁止モジュールへ届く最短の経路（届かなければ null） */
export function pathToForbidden(start: string): string[] | null {
  const parent = new Map<string, string | null>([[start, null]])
  const queue = [start]
  while (queue.length) {
    const f = queue.shift()!
    for (const d of staticImports(f)) {
      if (parent.has(d)) continue
      parent.set(d, f)
      const npm = d.startsWith('npm:') ? d.slice(4) : null
      if (npm && FORBIDDEN.some(x => npm === x || npm.startsWith(x + '/'))) {
        const chain = [d]
        let c: string | null = f
        while (c) { chain.push(c); c = parent.get(c) ?? null }
        return chain.reverse().map(x => x.startsWith('npm:') ? x : relative(ROOT, x))
      }
      if (!npm) queue.push(d)
    }
  }
  return null
}

/** 画面の入口: app 配下の page/layout（api は除く）と components 配下すべて */
function clientEntries(): string[] {
  const pages = walk(join(ROOT, 'app'), /\/(page|layout|template|error|not-found)\.tsx$/).filter(p => !p.includes('/app/api/'))
  const comps = walk(join(ROOT, 'components'), /\.tsx?$/)
  return [...pages, ...comps].sort()
}

describe('クライアントの import 連鎖にサーバー専用モジュールが混ざらない', () => {
  const entries = clientEntries()
  it('画面と部品が見つかる', () => {
    expect(entries.length).toBeGreaterThan(30)
  })
  for (const entry of entries) {
    it(relative(ROOT, entry), () => {
      const chain = pathToForbidden(entry)
      expect(chain, chain ? `禁止モジュールへ届く経路:\n  ${chain.join('\n  → ')}` : undefined).toBeNull()
    })
  }
})
