#!/usr/bin/env node
/**
 * スタッフ向けマニュアル（日本語＋ベトナム語）から、ベトナム語を抜いた日本語版 HTML を生成する。
 *
 *   node scripts/build-staff-manual-ja.mjs [--jp] [出力先.html]
 *
 * 原本は public/staff-manual-vi.html の1本だけ。日本語版を別ファイルで手で持つと
 * 改訂のたびに2本直すことになり必ずズレるので、配布用（PDF化）のときにこのスクリプトで作る。
 * 生成物はリポジトリに置かない（既定の出力先はカレントの staff-manual-ja.html）。
 *
 * 抜くもの:
 *   1. class="vi" の要素
 *   2. ベトナム語だけの <span style="color:#555;">…</span>（赤いお知らせの節）と直前の <br>
 *   3. テキスト中の「 / ベトナム語」（見出し・ボタン・表・画面見本のラベル）
 * 最後にベトナム語の文字が残っていないか検査し、残っていれば失敗させる。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'public/staff-manual-vi.html')
const args = process.argv.slice(2)
// --jp: 日本人スタッフ向けの体裁にする（宛名・画面見本の名前をダミーの日本人に、
//       「日本語がわからない」の行を外す）。内容（章・手順）は変えない
const forJapanese = args.includes('--jp')
const out = resolve(args.find(a => !a.startsWith('--')) || 'staff-manual-ja.html')

// ベトナム語にしか出ない文字（声調つき母音と đ）
const VI_CHARS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]/i
const JA = 'ぁ-んァ-ヶ一-龥々ー'

let html = readFileSync(src, 'utf-8')

// <head> の表記
html = html.replace(/<html lang="[^"]*"/, '<html lang="ja"')
html = html.replace(/<title>[^<]*<\/title>/, '<title>スタッフ向けマニュアル - HIBI CONSTRUCTION</title>')

const headEnd = html.indexOf('</style>')
let head = html.slice(0, headEnd)
let body = html.slice(headEnd)

// 1. class="vi" の要素（直前の <br> と空白ごと）
body = body.replace(/(?:<br\s*\/?>)?\s*<(span|p|div)\b[^>]*class="vi"[^>]*>[\s\S]*?<\/\1>/g, '')

// 2. ベトナム語だけの灰色 span
body = body.replace(/(?:<br\s*\/?>)?\s*<span style="color:#555;">([\s\S]*?)<\/span>/g, (m, inner) =>
  VI_CHARS.test(inner) && !new RegExp(`[${JA}]`).test(inner) ? '' : m)

// 3. テキストノード中の「 / ベトナム語」。タグの中（href="/docs" など）は触らない
const stripInline = (text) => text
  // 「日本語 / Tiếng Việt」→「日本語」。日本語の文字か閉じ括弧が出たところで止める
  //   ベトナム語側が数字で始まることもある（「最近5日 / 5 ngày gần đây」）ので、先頭は数字も許し、
  //   （「8/26」のような日付はベトナム語の文字が無いので残る）
  //   コロンでも止める（「最終更新 / Cập nhật: 2026年…」の日付を巻き込まない）。
  //   消すのはベトナム語の文字を含むときだけ（「HIBI CONSTRUCTION / HFU」は残す）
  .replace(new RegExp(`\\s*/\\s*[0-9A-Za-zÀ-ỹĐđ"“][^」）:：${JA}]*`, 'g'), (m) => (VI_CHARS.test(m) ? '' : m))
  // 画面見本の名前行「Nguyễn Văn Nam ／ 7月3日」→ 日付だけ
  .replace(/[A-Za-zÀ-ỹĐđ ]+\s*／\s*/g, (m) => (VI_CHARS.test(m) ? '' : m))
body = body.split(/(<[^>]+>)/).map(part => (part.startsWith('<') ? part : stripInline(part))).join('')

if (forJapanese) {
  const must = (from, to) => {
    if (!body.includes(from)) { console.error(`❌ --jp: 置換対象が見つかりません: ${from}`); process.exit(1) }
    body = body.replace(from, to)
  }
  must('技能実習生・特定技能の皆さまへ', 'スタッフの皆さまへ')
  must('グエン ヴァン ナム さん', '山田 太郎 さん')
  // 「日本語がわからない → チイさんに相談」の行
  const before = body
  body = body.replace(/\s*<tr><td>日本語がわからない[\s\S]*?<\/tr>/, '')
  if (body === before) { console.error('❌ --jp: 「日本語がわからない」の行が見つかりません'); process.exit(1) }
}

// 末尾が <br> だけになった段落を整える（<br>\s*</p> → </p>）
body = body.replace(/<br\s*\/?>\s*(<\/(?:p|td|li|div)>)/g, '$1')

// 表紙の「日本語+ベトナム語」前提の余白はそのまま。CSS の .vi 定義は無害なので残す
html = head + body

const leftover = html.slice(headEnd).split('\n').filter(l => VI_CHARS.test(l))
if (leftover.length > 0) {
  console.error('❌ ベトナム語が残っています:')
  for (const l of leftover) console.error('   ' + l.trim().slice(0, 160))
  process.exit(1)
}

writeFileSync(out, html)
console.log(`✅ ${out}`)
