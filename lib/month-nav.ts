/**
 * 月の前後移動（'YYYYMM'）。画面（クライアント）からも使うので Firestore などサーバー専用の依存を持たせない。
 *
 * 2026-10-02 総合点検: 同じ shiftYm が peer-invoice・peer-statement・paper-invoice の3画面に別々に書かれていた
 * （1つ直しても他が残る）ので、ここに1つにした。
 */
export function shiftYm(ym: string, delta: number): string {
  let y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10) + delta
  while (m < 1) { m += 12; y-- }
  while (m > 12) { m -= 12; y++ }
  return `${y}${String(m).padStart(2, '0')}`
}
