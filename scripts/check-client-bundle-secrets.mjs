#!/usr/bin/env node
/**
 * ビルド後のクライアント JS（.next/static）に個人の賃金予定が載っていないかを調べる（2026-10-02）。
 *
 * /_next/static のチャンクはログインなしで取れる。以前は lib/wage-curve.ts・lib/wage-analysis.ts に
 * 予定時給（205→1585円 など）と個別事情の注記を書いていたため、/wage-analysis と /evaluation の
 * 共有チャンクに全員分が載っていた。予定表は lib/wage-plan.server.ts（server-only）へ移したので、
 * ここではそのファイルの中身がチャンクに 1 つも出てこないことを確かめる。
 *
 * 探すもの（lib/wage-plan.server.ts から自動で拾う。予定を足せば自動で検査対象になる）:
 *   - `workerId: 時給` の組（圧縮後は `205:1585` の形になる）
 *   - reason / detail の文章（12文字以上の断片）
 *
 * 使い方: npm run build のあと自動で走る（package.json postbuild）。単独なら npm run check:bundle
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PLAN_FILE = join(ROOT, 'lib/wage-plan.server.ts')
const STATIC_DIR = join(ROOT, '.next/static')

/** lib/wage-plan.server.ts の中身から、チャンクに出てはいけない文字列を拾う */
export function extractNeedles(src) {
  const needles = new Set()
  // targets の `205: 1585, // 名前` 行
  for (const m of src.matchAll(/^\s*(\d{3}):\s*(\d{3,6}),/gm)) needles.add(`${m[1]}:${m[2]}`)
  // reason: '...' / detail: '...' と、その続きの + '...'
  for (const m of src.matchAll(/(?:reason|detail):\s*'([^']+)'((?:\s*\+\s*'[^']+')*)/g)) {
    const pieces = [m[1], ...[...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])]
    for (const p of pieces) if (p.length >= 12) needles.add(p.slice(0, 40))
  }
  return [...needles]
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(js|mjs|json|html|txt)$/.test(name)) yield p
  }
}

/** 見つかった [ファイル, 文字列] の一覧 */
export function scanStatic(dir, needles) {
  const hits = []
  for (const f of walk(dir)) {
    const body = readFileSync(f, 'utf8')
    for (const n of needles) if (body.includes(n)) hits.push([relative(ROOT, f), n])
  }
  return hits
}

function main() {
  if (!existsSync(STATIC_DIR)) {
    console.error('check-client-bundle-secrets: .next/static がありません。先に next build してください')
    process.exit(1)
  }
  const needles = extractNeedles(readFileSync(PLAN_FILE, 'utf8'))
  if (needles.length < 5) {
    // 拾えていない＝ファイルの書き方が変わって検査が空振りしている。黙って通さない
    console.error(`check-client-bundle-secrets: 検査する文字列を ${needles.length} 個しか拾えませんでした（${PLAN_FILE} の書式を確認）`)
    process.exit(1)
  }
  const hits = scanStatic(STATIC_DIR, needles)
  if (hits.length) {
    console.error('❌ クライアントの JS に個人の賃金予定が載っています（ログインなしで取れます）:')
    for (const [f, n] of hits) console.error(`   ${f}  ←  ${n}`)
    console.error('   lib/wage-plan.server.ts を画面側から import していないか確認してください')
    process.exit(1)
  }
  console.log(`✅ check-client-bundle-secrets: ${needles.length} 個の文字列は .next/static にありません`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
