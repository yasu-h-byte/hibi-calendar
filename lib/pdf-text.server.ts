/**
 * PDF から文字を取り出す（サーバー専用・2026-10-20）。
 *
 * 大林組の請求書（控え）と山岡の控除計算書は、どちらも文字情報を持つ PDF（スキャン画像ではない）なので、
 * pdfjs（pdfjs-dist）で文字と座標を取り出し、同じ高さ（y）の文字を1行にまとめ、左から右（x）の順に並べる。
 * 返り値は「行ごとの文字の塊の配列」（lib/prime-invoice.ts の読み取りはこの形を前提にしている）。
 *
 * - 大林組の控えは MS 明朝が埋め込まれていない（CMap で日本語を引く）ので、cMapUrl に pdfjs 同梱の cmaps を渡す。
 *   Vercel では next.config.js の outputFileTracingIncludes で cmaps/ を同梱する
 * - pdfjs-dist は ESM。Next のサーバーバンドルに入れず（serverComponentsExternalPackages）、実行時に読む
 * - 画像だけの PDF（スキャン）は文字が取れないので空になる → 呼び出し側で「読めない」として手入力へ
 */
import 'server-only'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import path from 'path'

/** webpack に束ねられた中から本物の Node の require を使う（Vercel の関数）。無ければ undefined */
declare const __non_webpack_require__: NodeRequire | undefined

type TextItem = { str: string; transform: number[] }

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null

function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/**
 * pdfjs-dist の置き場（cmaps/・standard_fonts/・pdf.worker.mjs を引くため）。
 * Vercel の関数の中では webpack が `createRequire` を潰す（2026-10-20 Preview: 「Cannot read properties of undefined (reading 'resolve')」）ので、
 * まず作業ディレクトリ（Vercel は /var/task・手元はリポジトリの根）の node_modules を直接見る。
 * 見つからなければ本物の require（__non_webpack_require__）→ createRequire の順に試す。
 */
function pdfjsRoot(): string {
  const tried: string[] = []
  // 1. 作業ディレクトリから上へ（node_modules/pdfjs-dist/package.json があるところ）
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'node_modules', 'pdfjs-dist')
    tried.push(cand)
    if (existsSync(path.join(cand, 'package.json'))) return `${cand}${path.sep}`
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  // 2. 本物の require / createRequire
  const resolvers: (() => string)[] = [
    () => (typeof __non_webpack_require__ === 'function' ? __non_webpack_require__.resolve('pdfjs-dist/package.json') : ''),
    () => (typeof createRequire === 'function' ? createRequire(path.join(process.cwd(), 'package.json')).resolve('pdfjs-dist/package.json') : ''),
  ]
  let lastErr = ''
  for (const r of resolvers) {
    try { const p = r(); if (p) return p.replace(/package\.json$/, '') } catch (e) { lastErr = e instanceof Error ? e.message : String(e) }
  }
  throw new Error(`pdfjs-dist が見つかりません（cwd=${process.cwd()}・探した: ${tried.join(', ')}${lastErr ? `・${lastErr}` : ''}）`)
}

/**
 * 1ページ目から最大 maxPages ページの文字を行ごとに返す。
 * 同じ行の判定は y 座標 ±2pt。1つの塊（str）は pdfjs が区切った単位のまま（「¥13,123,000」や「取引件名」など）。
 */
export async function extractPdfLines(data: Uint8Array | Buffer, opts?: { maxPages?: number }): Promise<string[][]> {
  const pdfjs = await loadPdfjs()
  const root = pdfjsRoot()
  // Node では「偽のワーカー」として pdf.worker.mjs を読み込む。相対の探し方に頼らず絶対パスで指す
  //（Vercel の関数には next.config.js の outputFileTracingIncludes で同梱する）
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `${root}legacy/build/pdf.worker.mjs`
  const doc = await pdfjs.getDocument({
    // Buffer は Uint8Array の派生だが pdfjs は受け付けないので、素の Uint8Array に写す
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    cMapUrl: `${root}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}standard_fonts/`,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise
  try {
    const out: string[][] = []
    const pages = Math.min(doc.numPages, opts?.maxPages ?? 3)
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      const rows = new Map<number, { x: number; s: string }[]>()
      for (const it of tc.items as TextItem[]) {
        if (!('str' in it) || !it.str || !it.str.trim()) continue
        const y = Math.round(it.transform[5])
        let key: number | undefined
        for (const k of rows.keys()) if (Math.abs(k - y) <= 2) { key = k; break }
        if (key === undefined) { key = y; rows.set(key, []) }
        rows.get(key)!.push({ x: it.transform[4], s: it.str.trim() })
      }
      const lines = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, xs]) => xs.sort((a, b) => a.x - b.x).map(v => v.s))
      out.push(...lines)
      page.cleanup()
    }
    return out
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}
