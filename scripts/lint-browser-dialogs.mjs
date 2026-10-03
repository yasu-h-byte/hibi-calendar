#!/usr/bin/env node
/**
 * ブラウザ標準の confirm() / alert() / prompt() の検出（UI/UX 磨き込み 土台②・2026-10-03）
 *
 * 置き換え先（見本 https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh）:
 *   confirm(...)  → lib/confirm-dialog.ts の confirmDialog() / confirmDanger() / confirmWithReason()（await する）
 *   alert(失敗)   → lib/notify.ts の notify.failed('保存', err) / notify.error(見出し, 理由と次の手)
 *   alert(成功)   → notify.success('保存しました')
 *   alert(不備)   → 欄のすぐ下に <FieldError>（components/ui/PageParts.tsx）
 *
 * 2026-10-03 に全画面（179か所）の置き換えが終わり、以後は app/・components/・lib/ のどこでも違反にする。
 * 落ちる先として意図して使う行には `dialog-ok` と書く（lib/confirm-dialog.ts・lib/notify.ts 等）。
 * 使い方: npm run lint:dialog（違反があれば終了コード 1）。全体の残りの数も最後に出す
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', '__tests__'])
const TARGET_DIRS = ['app', 'components', 'lib']
const TARGET_EXTS = new Set(['.ts', '.tsx'])

/** 2026-10-03 に全画面の置き換えが終わった。以後はどこでも違反にする */
const CONVERTED = ['app/', 'components/', 'lib/']

const RE = /(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/

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
let remaining = 0
for (const file of files) {
  const rel = path.relative(ROOT, file)
  const converted = CONVERTED.some(c => rel.startsWith(c))
  const lines = (await fs.readFile(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    if (line.includes('dialog-ok')) return
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    if (!RE.test(line)) return
    // 自前の関数名（confirmDialog / confirmDiscard 等）は対象外: 直後が "(" の素の confirm( だけ拾う
    remaining++
    if (converted) violations.push({ file: rel, line: i + 1, text: t.slice(0, 120) })
  })
}

console.log(`ブラウザ標準の confirm/alert/prompt の残り: ${remaining} 件（置き換え済みの場所: ${CONVERTED.length}）`)
if (violations.length === 0) {
  console.log('✅ lint:dialog OK（置き換え済みの場所にブラウザ標準の窓はありません）')
  process.exit(0)
}
console.error(`❌ 置き換え済みの場所にブラウザ標準の窓が ${violations.length} 件あります\n`)
for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
process.exit(1)
