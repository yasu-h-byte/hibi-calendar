#!/usr/bin/env node
/**
 * 鳶グループ判定のハードコード検出
 *
 * 2026-06-XX 追加。以前 cost ページの DonutChart で
 *   `j === 'とび' || j === 'tobi' || j === '鳶'`
 * というハードコードがあり、鳶見習い (tobi_apprentice) / 職長 / 役員 が
 * 誤って土工に分類されるバグが発生した。
 *
 * 単一の真理ソースは lib/jobs.ts の TOBI_GROUP_JOBS / isTobiGroup() / isDokoGroup()。
 * ハードコードを禁止し、必ずヘルパー経由で判定するよう lint で強制する。
 *
 * 検出パターン:
 *   ❌ job === 'tobi' || job === 'tobi_apprentice'   (個別比較)
 *   ❌ ['tobi','tobi_apprentice','shokucho','yakuin'].includes(job)
 *   ❌ job === 'とび' || job === '鳶'  (UI文字列で分類)
 *
 * 使い方:
 *   node scripts/lint-tobi-group.mjs
 *   → 違反があれば終了コード 1
 *
 *   package.json:
 *     "lint:tobi": "node scripts/lint-tobi-group.mjs"
 *
 * 例外（allowlist）:
 *   - lib/jobs.ts: ヘルパー実装本体
 *   - components/monthly/PayrollAuditModal.tsx 等で「日本語ラベル」用途で
 *     'とび' を表示する場合は OK
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ALLOWLIST = new Set([
  'lib/jobs.ts',
  'scripts/lint-tobi-group.mjs',
])

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build'])
const TARGET_EXTS = new Set(['.ts', '.tsx'])

/**
 * 違反パターン:
 *   1. `=== 'tobi'` と同じ行に `'tobi_apprentice'` / `'shokucho'` / `'yakuin'` が
 *      || で並んでいる → ハードコード判定の典型
 *   2. `.includes(...)` で 'tobi' を含む配列リテラルが渡されている
 *   3. `'とび'` や `'鳶'` という UI 文字列で判定（== / === / includes）
 *
 * 偽陽性回避:
 *   - JOB_LABELS / JOB_SHORT_LABELS の定義行（ラベルマッピング）
 *   - <option value="tobi"> 等の HTML 値リテラル
 */
const VIOLATIONS = [
  // 個別比較を || で並べる (3つ以上の job コードが同じ行)
  {
    re: /===?\s*['"]tobi['"][\s\S]{0,80}(tobi_apprentice|shokucho|yakuin)/,
    msg: '鳶グループの個別比較。isTobiGroup(job) を使ってください',
  },
  // 'とび' / '鳶' のUI文字列で複数の鳶系職種コードと OR 判定（=分類の話）
  // ※ ラベル正規化 (`=== 'とび' || === '鳶') return '鳶'`) は分類ではないのでスキップ
  {
    re: /===?\s*['"](とび|鳶)['"][\s\S]{0,80}(tobi_apprentice|shokucho|yakuin)/,
    msg: 'UI文字列での職種分類。isTobiGroup(job) を使ってください',
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
      // JOB_LABELS / JOB_SHORT_LABELS のラベル定義は無視
      if (/JOB(_SHORT)?_LABELS/.test(line)) continue
      // <option value="..."> は無視
      if (/<option/.test(line)) continue
      // subcon type (外注業者の業種、別概念) は対象外
      if (/(sc|subcon)\.type/.test(line)) continue
      // 表示ラベル比較 (label === '鳶' 等) は分類ではなく表示の話なので OK
      if (/\blabel\s*===?/.test(line)) continue

      for (const v of VIOLATIONS) {
        if (v.re.test(line)) {
          violations.push({ file: rel, line: i + 1, code: line.trim(), msg: v.msg })
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ 鳶グループ判定のハードコードを検出しました：\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`)
      console.error(`    ${v.code}`)
      console.error(`    → ${v.msg}\n`)
    }
    console.error(`合計 ${violations.length} 件の違反。`)
    console.error('lib/jobs.ts の isTobiGroup(job) / isDokoGroup(job) を使ってください。')
    process.exit(1)
  }

  console.log('✓ 鳶グループ判定のハードコードはありません')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
