#!/usr/bin/env node
/**
 * サーバ側の「今日・今月」判定が UTC になっていないかを検出する
 *
 * 2026-10-01 事故: Vercel のサーバは UTC のため、new Date() の getFullYear/getMonth/getDate で
 * 「今月」を決めていた /api/leave が、10/1 の 0〜9時（JST）に「まだ9月」と判定し、
 * 日本人全員を前の期の有給残数で表示した。同じ型が app/api と lib に約45か所あった。
 *
 * 検出するもの（app/api と lib の .ts/.tsx）:
 *  ❌ new Date().getFullYear() / getMonth() / getDate() / getDay()
 *  ❌ const now = new Date()  →  now.getFullYear() など（同じファイル内の同名変数）
 *  ❌ new Date().toISOString().slice(0, 7|10)（UTC の年月・日付）
 *
 * 代わりに lib/date-utils.ts の jstToday()（JST の今日 0:00 の Date）/ todayJstIso() を使う。
 *
 * 例外:
 *  - 行末に `// jst-ok` を付けた行（時刻の差分計算など、暦日を決めていないもの）
 *  - ALLOWLIST のファイル（ブラウザ専用で、端末の時刻＝JST で動くもの）
 *
 * 使い方: node scripts/lint-jst-today.mjs（エラーがあれば終了コード 1）
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const TARGET_DIRS = ['app/api', 'lib']

// ブラウザ専用（クライアントの画面からだけ import される）ファイル
const ALLOWLIST = new Set([
  'lib/attendance-grid.ts', // 出面入力グリッド（app/(app)/attendance の画面専用）
  'lib/calendar.ts',        // 就業カレンダー編集画面専用（getNextMonth）
])

const GETTERS = '(?:getFullYear|getMonth|getDate|getDay)'

async function walk(dir, out) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      await walk(p, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
}

const files = []
for (const d of TARGET_DIRS) await walk(path.join(ROOT, d), files)

const errors = []
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  if (ALLOWLIST.has(rel)) continue
  const src = await fs.readFile(abs, 'utf8')
  const lines = src.split('\n')

  // 引数なしの new Date() を代入された変数名
  const nowVars = new Set()
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::\s*Date\s*)?=\s*new Date\(\)\s*(?:[;\n]|$)/g)) {
    nowVars.add(m[1])
  }
  const varRe = nowVars.size
    ? new RegExp(`\\b(?:${[...nowVars].join('|')})\\.${GETTERS}\\(\\)`)
    : null
  const directRe = new RegExp(`new Date\\(\\)\\.${GETTERS}\\(\\)`)
  const isoRe = /new Date\(\)\.toISOString\(\)\.(?:slice|substring)\(0,\s*(?:7|10)\)/

  lines.forEach((line, i) => {
    if (/\/\/\s*jst-ok/.test(line)) return
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (directRe.test(line) || isoRe.test(line) || (varRe && varRe.test(line))) {
      errors.push(`${rel}:${i + 1}: ${trimmed}`)
    }
  })
}

if (errors.length) {
  console.error('❌ サーバ側で UTC の暦日（今日・今月）を使っている箇所があります。')
  console.error('   lib/date-utils.ts の jstToday() / todayJstIso() に置き換えてください')
  console.error('   （暦日を決めていない行なら行末に // jst-ok）\n')
  for (const e of errors) console.error('  ' + e)
  console.error(`\n計 ${errors.length} 件`)
  process.exit(1)
}
console.log(`✅ lint-jst-today: ${files.length} ファイル、問題なし`)
