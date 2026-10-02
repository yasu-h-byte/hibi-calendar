#!/usr/bin/env node
/**
 * 公開資料に個人の給与が載っていないかの検査（2026-10-02 代表「資料についても絶対に安易に載せない」）。
 *
 * public/ のファイルはログインなしで誰でも開ける。2026-10-02 に、給与計算マニュアル（奥寺さん用）・
 * チェックリスト・最低20日保証のお知らせに、政仁さんの月給などの実名と金額が載っていたことが分かった。
 * 二度と載せないよう、実名（◯◯さん・◯◯君）の近くに金額（1,000円以上）がある行を検出して止める。
 *
 * - 例に使う架空の人は「Aさん」「Bさん」のように英字1文字にする（検出しない）
 * - 金額は「日給20,000円の人」のように名前を付けずに書く
 * - どうしても必要な行は、同じ行に <!-- pay-ok: 理由 --> を書く（代表の確認を取ってから）
 *
 * 使い方: npm run lint:pay（__tests__/payInDocs.test.ts からも呼ぶ）
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = process.cwd()
const TARGET_DIRS = ['public']
const EXT = /\.(html?|md|txt|json|csv)$/i

// 金額: 1,000 以上（カンマ区切り）＋円 / ¥つき / 「万円」
//   2026-10-02 総合点検で追加: カンマの無い4桁以上＋円（396105円）・¥＋4桁以上・「時給/日給/日額/月給/年収/賞与 ＋ 3桁以上」
//   （時給1585 のように円が無い書き方）・口座番号（口座 … 6〜8桁）
const AMOUNT = String.raw`(?:¥\s?[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?:,[0-9]{3})+\s?円|[0-9]+(?:\.[0-9]+)?\s?万円|[0-9]{4,}\s?円|¥\s?[0-9]{4,}|(?:時給|日給|日額|月給|基本給|年収|賞与)\s*[:：]?\s*¥?[0-9][0-9,]{2,}|口座(?:番号)?[^0-9\n]{0,12}[0-9]{6,8})`
// 実名: 漢字・カタカナ2文字以上＋さん/君（英字1文字の架空の人は除く）
const NAME = String.raw`[一-龥ァ-ヶー]{2,}(?:さん|君)`
const NEAR = 40
const PATTERNS = [
  new RegExp(`${NAME}[^。\\n]{0,${NEAR}}?${AMOUNT}`),
  new RegExp(`${AMOUNT}[^。\\n]{0,${NEAR}}?${NAME}`),
]
const AMOUNT_RE = new RegExp(AMOUNT)
// 給与でない「さん」（社労士さん・お客さん等）は除く
const NOT_PERSON = /(社労士|皆|お客|業者|職人|大家|管理人|キャシュモ|事務|職長|みな)さん/g

/**
 * 人員マスタの実名（2026-10-02 総合点検）。「さん」の付かない書き方・名前と金額が別の行（HTML の表）・
 * カンマや円の無い金額をすり抜けないよう、実名の一覧を**既にある**サーバー専用ファイルから作る
 * （実名の一覧をコードに増やさない）:
 *   - lib/jp-wage-migration.server.ts の `name: '姓 名'` → 姓と名（「日比」は社名なので除く）
 *   - lib/wage-plan.server.ts の `205: 1585, // ホー チョン ゴック` → カタカナの各語（2文字以上）
 * カタカナの名前は前後がカタカナでないときだけ一致させる（「ボタン」の「タン」や「サンプル」の「サン」は拾わない）。
 * 実名が金額・口座番号の前後2行以内にあれば検出する。
 */
const NAME_SOURCES = ['lib/jp-wage-migration.server.ts', 'lib/wage-plan.server.ts']
const COMPANY_WORDS = new Set(['日比'])
export function knownNames(root = ROOT) {
  const names = new Set()
  for (const f of NAME_SOURCES) {
    let src = ''
    try { src = readFileSync(join(root, f), 'utf8') } catch { continue }
    for (const m of src.matchAll(/name:\s*'([^'\s]{1,10})[ \u3000]([^'\s]{1,10})'/g)) {
      for (const part of [m[1], m[2]]) if (part.length >= 2 && !COMPANY_WORDS.has(part)) names.add(part)
    }
    for (const m of src.matchAll(/^\s*\d{3}:\s*\d{3,6},\s*\/\/\s*([^\n(（]+)/gm)) {
      for (const part of m[1].trim().split(/[ \u3000]+/)) if (/^[ァ-ヶー]{2,}$/.test(part)) names.add(part)
    }
  }
  return [...names]
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function knownNameRegExp(names) {
  if (names.length === 0) return null
  const kana = names.filter(n => /^[ァ-ヶー]+$/.test(n)).map(esc)
  const kanji = names.filter(n => !/^[ァ-ヶー]+$/.test(n)).map(esc)
  const parts = []
  if (kanji.length) parts.push(`(?:${kanji.join('|')})`)
  if (kana.length) parts.push(`(?<![ァ-ヶー])(?:${kana.join('|')})(?![ァ-ヶー])`)
  return new RegExp(parts.join('|'))
}
const NAME_WINDOW = 2

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXT.test(name)) out.push(p)
  }
  return out
}

export function findPayInDocs(root = ROOT) {
  const hits = []
  const nameRe = knownNameRegExp(knownNames(root))
  for (const d of TARGET_DIRS) {
    let files = []
    try { files = walk(join(root, d)) } catch { continue }
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      const texts = lines.map(line => line.replace(/<[^>]+>/g, '').replace(NOT_PERSON, ''))
      const okLine = lines.map(line => line.includes('pay-ok:'))
      lines.forEach((line, i) => {
        if (okLine[i]) return
        const text = texts[i]
        if (PATTERNS.some(re => re.test(text))) {
          hits.push({ file: relative(root, f), line: i + 1, text: text.trim().slice(0, 140) })
          return
        }
        // 実名の一覧: 金額のある行の前後 NAME_WINDOW 行に実名があれば検出（表の別セル・「さん」なしの書き方）
        if (nameRe && AMOUNT_RE.test(text)) {
          for (let j = Math.max(0, i - NAME_WINDOW); j <= Math.min(lines.length - 1, i + NAME_WINDOW); j++) {
            if (okLine[j]) continue
            if (nameRe.test(texts[j])) {
              hits.push({ file: relative(root, f), line: i + 1, text: `${text.trim().slice(0, 100)}（${j + 1}行目: ${texts[j].trim().slice(0, 40)}）` })
              break
            }
          }
        }
      })
    }
  }
  return hits
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = findPayInDocs()
  if (hits.length === 0) {
    console.log('✅ 公開資料に個人の給与（実名＋金額）は見つかりませんでした')
  } else {
    console.error('❌ 公開資料に個人の給与（実名＋金額）らしい行があります。名前を消すか「Aさん」などの架空の例にしてください')
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`)
    process.exit(1)
  }
}
