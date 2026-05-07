#!/usr/bin/env node
/**
 * Firestore 危険書き込みパターン検出
 *
 * 2026-05-07 事故を踏まえて導入。以下のパターンをコードベースから検出してエラーにする：
 *
 *  ❌ setDoc(ref, { フィールド: {} }, { merge: true })
 *      → Firebase JS SDK v11 の挙動: 既存のフィールド全体が空マップに置換される
 *      → 代わりに lib/firestore-safe.ts の ensureDocExists() などを使うこと
 *
 *  ❌ setDoc(ref, { フィールド: {}, ... }, { merge: true })
 *      → 上と同じ理由で、子値に空マップを渡す書き込みは全て危険
 *
 * 使い方:
 *   node scripts/lint-firestore-safety.mjs
 *   → エラーがあれば終了コード 1
 *
 *   package.json:
 *     "lint:firestore": "node scripts/lint-firestore-safety.mjs"
 *
 * 例外:
 *   - lib/firestore-safe.ts: ヘルパー実装本体（コメントで言及するため）
 *   - scripts/diagnose-merge-empty-map.mjs: 罠を実証するための故意の使用
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ALLOWLIST = new Set([
  'lib/firestore-safe.ts',
  'scripts/diagnose-merge-empty-map.mjs',
  'scripts/lint-firestore-safety.mjs',
])

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build'])

const TARGET_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs'])

/**
 * パターン検出ロジック
 *
 * 検出したい:
 *   setDoc(任意, { 任意の名前: {} ... }, { ...merge: true... })
 *   setDoc(任意, { 任意の名前: {} ... }, { ...merge:true... })
 *
 * 偽陽性を避けるため、行ベースで簡素にチェック：
 *   - 行内に `setDoc(` がある
 *   - かつ同じ行（または続く2行）に `: {}` または `:{}` がある
 *   - かつ同じ行（または続く5行）に `merge: true` または `merge:true` がある
 */
function stripCommentsFromLine(line) {
  // 単純な // コメント除去（文字列リテラル内の // は誤検知するが、十分実用的）
  const idx = line.indexOf('//')
  return idx >= 0 ? line.slice(0, idx) : line
}

function detectDangerousPatterns(content, file) {
  // ブロックコメント /* ... */ を除去
  const noBlockComment = content.replace(/\/\*[\s\S]*?\*\//g, '')
  const rawLines = noBlockComment.split('\n')
  // 各行から行コメント // を除去
  const lines = rawLines.map(stripCommentsFromLine)
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('setDoc(')) continue
    // 続く5行までを連結して判定（複数行に跨る引数対応）
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join('\n')
    // 子フィールドに空マップを渡しているか
    const hasEmptyMapValue = /[a-zA-Z_$][a-zA-Z0-9_$]*\s*:\s*\{\s*\}/.test(window)
    // merge: true があるか
    const hasMergeTrue = /merge\s*:\s*true/.test(window)
    if (hasEmptyMapValue && hasMergeTrue) {
      errors.push({
        file,
        line: i + 1,
        snippet: rawLines.slice(i, Math.min(i + 3, rawLines.length)).join('\n').trim(),
      })
    }
  }
  return errors
}

async function* walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walkFiles(full)
    } else if (e.isFile()) {
      const ext = path.extname(e.name)
      if (TARGET_EXTS.has(ext)) yield full
    }
  }
}

async function main() {
  const allErrors = []
  for await (const file of walkFiles(ROOT)) {
    const rel = path.relative(ROOT, file)
    if (ALLOWLIST.has(rel)) continue
    const content = await fs.readFile(file, 'utf8')
    const errors = detectDangerousPatterns(content, rel)
    allErrors.push(...errors)
  }

  if (allErrors.length === 0) {
    console.log('✅ Firestore 危険書き込みパターンは検出されませんでした')
    process.exit(0)
  }

  console.error(`🚨 ${allErrors.length} 件の危険な書き込みパターンを検出しました：\n`)
  for (const err of allErrors) {
    console.error(`  ${err.file}:${err.line}`)
    console.error(`    ${err.snippet.replace(/\n/g, '\n    ')}\n`)
  }
  console.error('\n対処方法:')
  console.error('  - ドキュメント存在保証だけ: `setDoc(ref, {}, { merge: true })` または lib/firestore-safe.ts の ensureDocExists()')
  console.error('  - 新規フィールド初期化: lib/firestore-safe.ts の ensureFieldsInitialized()')
  console.error('  - 子値に必ず非空のマップを渡すか、updateDoc + dot-notation を使う\n')
  console.error('意図的に使う場合は scripts/lint-firestore-safety.mjs の ALLOWLIST にファイルパスを追加してください。')
  process.exit(1)
}

main().catch(e => {
  console.error('lint script error:', e)
  process.exit(2)
})
