#!/usr/bin/env node
/**
 * retired フラグの誤判定パターン検出
 *
 * 2026-06-XX 追加。退職予定者を扱うコードで以下のバグが頻発した:
 *
 *   ❌ `if (w.retired) continue`            ← 未来日退職予定の人も即除外される
 *   ❌ `.filter(w => !w.retired)`           ← 同上
 *   ❌ `main.workers.find(w => w.id === wid && !w.retired)` ← 同上
 *
 * 正しい判定:
 *   - 当該月の集計対象か      → isStillActiveForMonth(retired, ym)
 *   - 今日時点で退職済みか    → isAlreadyRetired(retired, todayIso)
 *
 * 使い方:
 *   node scripts/lint-retired-flag.mjs
 *   → 違反があれば標準エラーに一覧出力（終了コードは 0 — warn-only）
 *
 *   package.json:
 *     "lint:retired": "node scripts/lint-retired-flag.mjs"
 *
 * 注意: 既存コードに多数の違反が残っているため warn-only。
 *      新規追加コードのレビューで個別に修正していく方針。
 *      将来的に全件修正後、終了コードを 1 に切り替えること。
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ALLOWLIST = new Set([
  'lib/workers.ts',                  // ヘルパー実装本体
  'scripts/lint-retired-flag.mjs',
])

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build'])
const TARGET_EXTS = new Set(['.ts', '.tsx'])

/**
 * 違反パターン:
 *   1. `!w.retired` または `!worker.retired` 等  (boolean 否定)
 *   2. `if (w.retired) continue`                  (boolean 検査)
 *   3. `.filter(... && !.+\.retired ...)`         (filter内の同パターン)
 *
 * retired フィールドは string (YYYY-MM-DD) なので、boolean 検査は
 *   「フィールドの存在チェック」になっているだけで「未来日退職予定」も
 *   除外してしまう。
 */
const VIOLATIONS = [
  {
    re: /![\w.]+\.retired\b/,
    msg: '`!*.retired` パターン。isStillActiveForMonth(retired, ym) or !isAlreadyRetired(retired, today) を使ってください',
  },
  {
    re: /\bif\s*\(\s*[\w.]+\.retired\s*\)/,
    msg: '`if (*.retired)` パターン。isAlreadyRetired(retired, today) を使ってください',
  },
]

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (TARGET_EXTS.has(path.extname(e.name))) out.push(full)
  }
  return out
}

async function main() {
  const files = await walk(ROOT)
  const violations = []

  for (const file of files) {
    const rel = path.relative(ROOT, file)
    if (ALLOWLIST.has(rel)) continue

    const content = await fs.readFile(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // コメント行はスキップ
      if (/^\s*(\/\/|\*)/.test(line)) continue
      // type/interface定義の中の retired フィールドは無視
      if (/retired\s*[?:]\s*(string|boolean)/.test(line)) continue
      // optional chain `?.retired ?? ''` のような表現は許容
      if (/\?\.retired\b/.test(line) && !/!\s*[\w.]+\?\.retired/.test(line)) continue

      for (const v of VIOLATIONS) {
        if (v.re.test(line)) {
          // false positive: optional `retired?: string` 型定義
          if (/retired\?\s*:/.test(line)) continue
          violations.push({ file: rel, line: i + 1, code: line.trim(), msg: v.msg })
        }
      }
    }
  }

  if (violations.length > 0) {
    console.warn('\n⚠️  retired フラグの誤判定パターンを検出（warn-only）：\n')
    for (const v of violations) {
      console.warn(`  ${v.file}:${v.line}`)
      console.warn(`    ${v.code}`)
      console.warn(`    → ${v.msg}\n`)
    }
    console.warn(`合計 ${violations.length} 件の違反。`)
    console.warn('lib/workers.ts の isStillActiveForMonth() / isAlreadyRetired() を使ってください。')
    console.warn('(新規追加コードでは必ず修正、既存コードは個別レビューで段階的に解消)')
    return  // 終了コード 0
  }

  console.log('✓ retired フラグの誤判定パターンはありません')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
