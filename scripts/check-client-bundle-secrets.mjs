#!/usr/bin/env node
/**
 * ビルド後のクライアント JS（.next/static）に、サーバー専用ファイルの中身（個人の賃金予定・実名と日額など）が
 * 載っていないかを調べる（2026-10-02）。
 *
 * /_next/static のチャンクはログインなしで取れる。以前は lib/wage-curve.ts・lib/wage-analysis.ts に
 * 予定時給（205→1585円 など）と個別事情の注記を書いていたため、/wage-analysis と /evaluation の
 * 共有チャンクに全員分が載っていた。
 *
 * 2026-10-02 総合点検: 検査対象を lib/wage-plan.server.ts 1本から **lib/ 配下の *.server.ts すべて** に広げた
 * （lib/jp-wage-migration.server.ts＝日本人の実名＋移行前日額＋個別事情 を含む）。個人データを持つファイルは
 * `*.server.ts` ＋ `import 'server-only'` にすれば、自動でここの検査対象になる。
 *
 * 探すもの（各 *.server.ts の文字面から自動で拾う）:
 *   - `workerId: 時給,` の組（圧縮後は `205:1585` の形になる）
 *   - reason / detail / note の文章（12文字以上の断片）
 *   - `name: '姓 名'` の実名（姓と名の間に空白があるもの）
 *   日本語は圧縮後に \uXXXX に変換されることがあるので、その形でも探す。
 *
 * 使い方: npm run build のあと自動で走る（package.json postbuild）。単独なら npm run check:bundle
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 互換（旧テスト用）。検査対象の一覧は serverOnlyFiles() */
export const PLAN_FILE = join(ROOT, 'lib/wage-plan.server.ts')
const STATIC_DIR = join(ROOT, '.next/static')

/** 検査対象: lib/ 配下の *.server.ts（サーバー専用の目印つき）すべて */
export function serverOnlyFiles(root = ROOT) {
  const out = []
  for (const f of walk(join(root, 'lib'), /\.server\.ts$/)) out.push(f)
  return out.sort()
}

/** 日本語を \uXXXX に直した形（圧縮後のチャンクに載る形の一つ） */
export function unicodeEscaped(str) {
  return str.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** 1つの *.server.ts の中身から、チャンクに出てはいけない文字列を拾う */
export function extractNeedles(src) {
  const needles = new Set()
  // targets の `205: 1585, // 名前` 行
  for (const m of src.matchAll(/^\s*(\d{3}):\s*(\d{3,6}),/gm)) needles.add(`${m[1]}:${m[2]}`)
  // reason: '...' / detail: '...' / note: '...' と、その続きの + '...'
  for (const m of src.matchAll(/(?:reason|detail|note):\s*'([^']+)'((?:\s*\+\s*'[^']+')*)/g)) {
    const pieces = [m[1], ...[...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])]
    for (const p of pieces) if (p.length >= 12) needles.add(p.slice(0, 40))
  }
  // name: '姓 名'（実名。姓と名の間に空白）
  for (const m of src.matchAll(/name:\s*'([^'\s]{1,10}[ \u3000][^'\s]{1,10})'/g)) needles.add(m[1])
  return [...needles]
}

/** 検査対象ファイルすべての文字列（ファイル名つき） */
export function collectNeedles(root = ROOT) {
  const out = []
  for (const f of serverOnlyFiles(root)) {
    for (const n of extractNeedles(readFileSync(f, 'utf8'))) out.push([relative(root, f), n])
  }
  return out
}

function* walk(dir, pattern = /\.(js|mjs|json|html|txt)$/) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p, pattern)
    else if (pattern.test(name)) yield p
  }
}

/** 見つかった [ファイル, 文字列] の一覧（日本語は \uXXXX の形でも探す） */
export function scanStatic(dir, needles) {
  const hits = []
  for (const f of walk(dir)) {
    const body = readFileSync(f, 'utf8')
    for (const n of needles) {
      if (body.includes(n) || (/[^\x00-\x7f]/.test(n) && body.includes(unicodeEscaped(n)))) hits.push([relative(ROOT, f), n])
    }
  }
  return hits
}

function main() {
  if (!existsSync(STATIC_DIR)) {
    console.error('check-client-bundle-secrets: .next/static がありません。先に next build してください')
    process.exit(1)
  }
  const files = serverOnlyFiles()
  const pairs = collectNeedles()
  const needles = [...new Set(pairs.map(([, n]) => n))]
  if (files.length < 2 || needles.length < 5) {
    // 拾えていない＝ファイルの書き方が変わって検査が空振りしている。黙って通さない
    console.error(`check-client-bundle-secrets: 検査対象 ${files.length} ファイル・文字列 ${needles.length} 個しか拾えませんでした（lib/**/*.server.ts の書式を確認）`)
    process.exit(1)
  }
  const hits = scanStatic(STATIC_DIR, needles)
  if (hits.length) {
    console.error('❌ クライアントの JS にサーバー専用ファイルの中身（個人の賃金・実名）が載っています（ログインなしで取れます）:')
    for (const [f, n] of hits) {
      const from = pairs.filter(([, x]) => x === n).map(([src]) => src).join(', ')
      console.error(`   ${f}  ←  ${n}（${from}）`)
    }
    console.error('   lib/**/*.server.ts を画面側（use client）から import していないか確認してください')
    process.exit(1)
  }
  console.log(`✅ check-client-bundle-secrets: ${files.length} ファイル・${needles.length} 個の文字列は .next/static にありません`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
