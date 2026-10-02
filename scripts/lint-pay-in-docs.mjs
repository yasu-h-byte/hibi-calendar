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
const AMOUNT = String.raw`(?:¥\s?[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?:,[0-9]{3})+\s?円|[0-9]+(?:\.[0-9]+)?\s?万円)`
// 実名: 漢字・カタカナ2文字以上＋さん/君（英字1文字の架空の人は除く）
const NAME = String.raw`[一-龥ァ-ヶー]{2,}(?:さん|君)`
const NEAR = 40
const PATTERNS = [
  new RegExp(`${NAME}[^。\\n]{0,${NEAR}}?${AMOUNT}`),
  new RegExp(`${AMOUNT}[^。\\n]{0,${NEAR}}?${NAME}`),
]
// 給与でない「さん」（社労士さん・お客さん等）は除く
const NOT_PERSON = /(社労士|皆|お客|業者|職人|大家|管理人|キャシュモ|事務|職長|みな)さん/g

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
  for (const d of TARGET_DIRS) {
    let files = []
    try { files = walk(join(root, d)) } catch { continue }
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('pay-ok:')) return
        const text = line.replace(/<[^>]+>/g, '').replace(NOT_PERSON, '')
        if (PATTERNS.some(re => re.test(text))) {
          hits.push({ file: relative(root, f), line: i + 1, text: text.trim().slice(0, 140) })
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
