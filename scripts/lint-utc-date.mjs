#!/usr/bin/env node
/**
 * 「今日・今月・今年」を UTC で取ってしまうパターンの検出（2026-10-01 追加）
 *
 * サーバ（Vercel）は UTC で動くため、日本時間 0〜9時は UTC ではまだ前日。
 * 2026-10-01 に約40か所をまとめて直した（職長画面で今日が開けない・月初に前月の配置で判定 等）。
 *
 *   ❌ new Date().toISOString().slice(0, 10)       ← UTC の日付（ブラウザでも前日になる）
 *   ❌ new Date().getFullYear() / getMonth() ...    ← サーバでは UTC の年月日（app/api・lib のみ検出）
 *   ❌ const now = new Date(); ... now.getMonth()  ← 同上
 *
 * 正しい書き方（lib/date-utils.ts）:
 *   - 今日の 'YYYY-MM-DD'  → todayJstIso()
 *   - 今月の 'YYYYMM'      → currentYmJst()
 *   - 今年                 → currentYearJst()
 *   - 今日の Date（ローカル0時・getDate/getDay/setDate 用）→ todayJstDate()
 *   - 日付の加減           → addDaysIso() / addMonthsSafe()
 *
 * 意図して UTC を使う行には `// utc-ok` を付ける。
 * 使い方: npm run lint:utc（違反があれば終了コード 1）
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', '__tests__'])
const TARGET_EXTS = new Set(['.ts', '.tsx'])
/** サーバでも動くコード（ローカル getter が UTC になる場所） */
const SERVER_DIRS = ['app/api/', 'lib/']

const ANYWHERE = [
  { re: /new Date\(\)\.toISOString\(\)\.(slice|split|substring)\(/, msg: 'UTC の日付。todayJstIso() / currentYmJst() を使う' },
]
const SERVER_ONLY = [
  { re: /new Date\(\)\.(getFullYear|getMonth|getDate|getDay)\(\)/, msg: 'サーバでは UTC。currentYmJst() / currentYearJst() / todayJstDate() を使う' },
]

async function walk(dir, out = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) await walk(p, out)
    else if (TARGET_EXTS.has(path.extname(ent.name)) && !ent.name.includes('.test.')) out.push(p)
  }
  return out
}

const violations = []
for (const sub of ['app', 'components', 'lib']) {
  const files = await walk(path.join(ROOT, sub))
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (rel === 'lib/date-utils.ts') continue // ヘルパー本体
    const server = SERVER_DIRS.some(d => rel.startsWith(d))
    const lines = (await fs.readFile(file, 'utf8')).split('\n')
    // `const now = new Date()` のように「今」を入れた変数（数行以内にその変数のローカル getter があれば違反）
    const nowVars = new Map() // name -> 宣言行
    lines.forEach((line, i) => {
      if (line.includes('utc-ok')) return
      for (const r of ANYWHERE) if (r.re.test(line)) violations.push(`${rel}:${i + 1}  ${r.msg}\n    ${line.trim()}`)
      if (!server) return
      for (const r of SERVER_ONLY) if (r.re.test(line)) violations.push(`${rel}:${i + 1}  ${r.msg}\n    ${line.trim()}`)
      const decl = line.match(/(?:const|let)\s+(\w+)\s*=\s*new Date\(\)\s*$/)
      if (decl) { nowVars.set(decl[1], i); return }
      for (const [name, at] of nowVars) {
        if (i - at > 8) { nowVars.delete(name); continue }
        if (new RegExp(`\\b${name}\\.(getFullYear|getMonth|getDate|getDay)\\(\\)`).test(line)) {
          violations.push(`${rel}:${i + 1}  「今」の Date のローカル getter（サーバでは UTC）。todayJstDate() / currentYmJst() を使う\n    ${line.trim()}`)
          nowVars.delete(name)
        }
      }
    })
  }
}

if (violations.length > 0) {
  console.error(`❌ UTC の「今日・今月」の取り方が ${violations.length} 件あります（lib/date-utils.ts の JST ヘルパーを使う）\n`)
  for (const v of violations) console.error(v)
  process.exit(1)
}
console.log('✅ UTC の「今日・今月」の取り方は検出されませんでした')
