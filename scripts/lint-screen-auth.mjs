#!/usr/bin/env node
/**
 * 画面側（app/api 以外の app・components）で、通行証のヘッダ 'x-admin-password' を手書きしていないかを調べる（2026-10-21 総点検）。
 *
 * 2026-10-21 まで 150 か所の fetch が `headers: { 'x-admin-password': password }` を手書きしていた。
 * 画面の API 呼び出しは lib/api-client.ts（fetchWithAuth / postJson / getJson）を通す。通行証は localStorage から自動で付く。
 *
 * 使い方: npm run lint:auth（違反があれば終了コード 1）
 */
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'api'])

async function walk(dir, out = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) await walk(p, out)
    else if (/\.tsx?$/.test(ent.name) && !ent.name.includes('.test.')) out.push(p)
  }
  return out
}

const bad = []
for (const sub of ['app', 'components']) {
  for (const file of await walk(path.join(ROOT, sub))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const lines = (await fs.readFile(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (line.includes("'x-admin-password'") && !line.includes('auth-ok')) bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`)
    })
  }
}
if (bad.length) {
  console.error('❌ 画面側で通行証のヘッダを手書きしています。lib/api-client.ts の fetchWithAuth / postJson を使ってください:')
  for (const b of bad) console.error('  ' + b)
  console.error(`合計 ${bad.length} 件。意図して書く行は同じ行に \`// auth-ok: 理由\` を書いてください。`)
  process.exit(1)
}
console.log('✅ lint:auth OK（画面側に通行証ヘッダの手書きはありません）')
