/**
 * サーバ（Node 側）起動時の処理の本体。instrumentation.ts から Node ランタイムのときだけ読み込まれる
 * （Edge 用のビルドに Node 専用モジュールが混ざらないよう、ファイルを分けるのが Next の作法）。
 *
 * eMudhra（emSign）認証局の中間証明書 8 枚の鍵漏えい（2026-10-17 発覚）への守り（2026-10-23）。
 * 偽の証明書を弾く修正は Node 22.23.4 / 24.22.1 / 26.12.1 に入ったが、Vercel が配る Node が
 * まだ 24.21.0 のあいだは、サーバからの通信（Firestore・Storage など）が偽の証明書を信じてしまう。
 * そこで起動時に、Node が内蔵する信頼ルートから次の 2 つを外す（Mozilla・curl の最新バンドルも外した 2 つ）。
 *   - emSign ECC Root CA - G3 … 漏えいした中間証明書の親
 *   - AAA Certificate Services（Sectigo）… 同じ中間証明書に別経路（クロス署名）で信頼を与えていた
 * Vercel の Node が修正版になれば内蔵一覧にもう無いので、この処理は何もしない（外した数 0）。
 * 外した数は /api/health の caRootsRemoved で見られる。
 */
import * as tlsModule from 'tls'
import { X509Certificate } from 'crypto'

// Node 22.19 / 24.5 で足された API。手元の @types/node がまだ知らないので型だけここで書く
type TlsCaApi = { getCACertificates?: (type: 'bundled') => string[]; setDefaultCACertificates?: (certs: string[]) => void }

const DISTRUST = [/CN=emSign ECC Root CA - G3/, /CN=AAA Certificate Services/]

export function distrustCompromisedRoots(): number | null {
  const tls = tlsModule as unknown as TlsCaApi
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return null
  const bundled = tls.getCACertificates('bundled')
  const keep = bundled.filter((pem) => {
    const subject = new X509Certificate(pem).subject.replace(/\n/g, ',')
    return !DISTRUST.some((re) => re.test(subject))
  })
  const removed = bundled.length - keep.length
  if (removed > 0) tls.setDefaultCACertificates(keep)
  ;(globalThis as { __caRootsRemoved?: number }).__caRootsRemoved = removed
  console.log(`[instrumentation] Node ${process.version}: 内蔵の信頼ルート ${bundled.length} 件から ${removed} 件を外した（eMudhra 対応）`)
  return removed
}
