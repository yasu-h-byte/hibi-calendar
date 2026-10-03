#!/usr/bin/env node
/**
 * ブラウザ標準の confirm() / alert() / prompt() と、独自モーダルの枠の検出（UI/UX 磨き込み 土台②③・2026-10-03）
 *
 * 置き換え先（見本 https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh）:
 *   confirm(...)  → lib/confirm-dialog.ts の confirmDialog() / confirmDanger() / confirmWithReason()（await する）
 *   alert(失敗)   → lib/notify.ts の notify.failed('保存', err) / notify.error(見出し, 理由と次の手)
 *   alert(成功)   → notify.success('保存しました')
 *   alert(不備)   → 欄のすぐ下に <FieldError>（components/ui/PageParts.tsx）
 *   fixed inset-0 の自前の枠 → components/ui/Modal.tsx の <Modal>（見出し・×・ボタン列・未保存ガードが付く）
 *
 * 2026-10-03 に全画面（268か所）の置き換えが終わり、以後は app/・components/・lib/ のどこでも違反にする。
 * 落ちる先として意図して使う行には `dialog-ok`（lib/confirm-dialog.ts・lib/notify.ts 等）、
 * モーダルでない背景（スマホメニューの黒幕など）には `modal-ok` と書く（その行か直前の行）。
 * 使い方: npm run lint:dialog（違反があれば終了コード 1）
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', '__tests__'])
const TARGET_DIRS = ['app', 'components', 'lib']
const TARGET_EXTS = new Set(['.ts', '.tsx'])

/** 素の confirm( / alert( / prompt( だけ拾う（confirmDialog( などの自前の関数名は対象外） */
const RE_DIALOG = /(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/
/** 独自モーダルの枠（土台③で <Modal> に統一）。components/ui/ の部品そのものは対象外 */
const RE_MODAL = /fixed inset-0/

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
const dialogViolations = []
const modalViolations = []
for (const file of files) {
  const rel = path.relative(ROOT, file)
  const lines = (await fs.readFile(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    const prev = i > 0 ? lines[i - 1] : ''
    if (RE_MODAL.test(line) && !rel.startsWith('components/ui/') && !line.includes('modal-ok') && !prev.includes('modal-ok')) {
      modalViolations.push({ file: rel, line: i + 1, text: t.slice(0, 120) })
    }
    if (RE_DIALOG.test(line) && !line.includes('dialog-ok') && !prev.includes('dialog-ok')) {
      dialogViolations.push({ file: rel, line: i + 1, text: t.slice(0, 120) })
    }
  })
}

if (dialogViolations.length > 0) {
  console.error(`❌ ブラウザ標準の confirm/alert/prompt が ${dialogViolations.length} 件あります（confirmDialog / notify / FieldError に置き換える）\n`)
  for (const v of dialogViolations) console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
}
if (modalViolations.length > 0) {
  console.error(`❌ 独自モーダルの枠（fixed inset-0）が ${modalViolations.length} 件あります（components/ui/Modal.tsx の <Modal> を使う。意図した行は modal-ok）\n`)
  for (const v of modalViolations) console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
}
if (dialogViolations.length === 0 && modalViolations.length === 0) {
  console.log(`✅ lint:dialog OK（${files.length} ファイル・ブラウザ標準の窓も独自モーダルの枠もありません）`)
  process.exit(0)
}
process.exit(1)
