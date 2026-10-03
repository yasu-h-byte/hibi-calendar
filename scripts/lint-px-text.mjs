#!/usr/bin/env node
/**
 * 文字の大きさを px で指定しているクラスの検出（2026-10-03 追加）
 *
 * `text-[10px]` のような px 指定は、ブラウザ・OS の「文字を大きく」設定が効かない。
 * 2026-10-03 に 650か所を rem 系へまとめて直した（見た目は同じ）。
 *
 *   ❌ text-[10px] / text-[13px] / md:text-[15px]
 *   ✅ text-3xs(10px相当) / text-2xs(11) / text-xs(12) / text-sm(14) / text-base(16) / text-lg(18) / text-xl(20)
 *   ✅ 中間の大きさは rem で: text-[0.8125rem](13) / text-[0.9375rem](15) / text-[1.0625rem](17)
 *   ❌ 10px 相当より小さい字（text-[0.5rem] 等）は使わない（サイドバーの社名行だけ例外・// px-ok）
 *
 * 印刷用の <style> の font-size: 7px のような CSS は対象外（Tailwind クラスだけ見る）。
 * 意図して px を使う行（またはその直前の行）に `px-ok` と書く。
 * 使い方: npm run lint:px（違反があれば終了コード 1）
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', '__tests__'])
const TARGET_DIRS = ['app', 'components', 'lib']
const TARGET_EXTS = new Set(['.ts', '.tsx'])

const RULES = [
  { re: /text-\[\d+(\.\d+)?px\]/, msg: '文字の大きさは px でなく rem 系（text-3xs/2xs/xs/sm/base… か text-[0.8125rem] など）' },
  { re: /text-\[0\.(5\d*|[0-4]\d*)rem\]/, msg: '10px 相当（0.625rem）より小さい字は使わない（text-3xs 以上）' },
]

async function walk(dir, out = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) await walk(p, out)
    else if (TARGET_EXTS.has(path.extname(ent.name))) out.push(p)
  }
  return out
}

const files = (await Promise.all(TARGET_DIRS.map(d => walk(path.join(ROOT, d))))).flat()
const violations = []
for (const file of files) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    if (line.includes('px-ok') || (i > 0 && lines[i - 1].includes('px-ok'))) return
    for (const r of RULES) {
      if (r.re.test(line)) violations.push({ file: path.relative(ROOT, file), line: i + 1, msg: r.msg, text: line.trim().slice(0, 120) })
    }
  })
}

if (violations.length === 0) {
  console.log(`✅ lint:px OK（${files.length} ファイル・px の文字サイズ指定なし）`)
  process.exit(0)
}
console.error(`❌ 文字の大きさの px 指定が ${violations.length} 件あります\n`)
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.msg}\n    ${v.text}`)
process.exit(1)
