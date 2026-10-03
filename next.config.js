/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * セキュリティヘッダ（2026-10-02 総合点検）。
   * - Referrer-Policy: 個人のリンク（/attendance/<合言葉>・/mypage/<合言葉>）から外のサイトへ飛んだとき、URL の合言葉を
   *   相手に送らない（同じサイト内の遷移には影響しない）
   * - X-Content-Type-Options: 種類を偽った読み込みを防ぐ
   * - X-Frame-Options: ほかのサイトの iframe に埋め込ませない（同じサイト内＝資料一覧の HTML・印刷は SAMEORIGIN で動く。
   *   PWA（manifest・ホーム画面）にも影響しない）
   */
  /**
   * 転送だけの旧ページ（2026-10-03 UI/UX 磨き込み）。以前は app/(app)/ 配下に「開いたら別の画面へ飛ぶだけ」のページを
   * 5つ置いていた（leave-requests・users・home-leave・export・evaluation/raise-history）。古いリンク・ブックマークの互換は
   * この設定で保ち、ページそのものは削除した。
   */
  async redirects() {
    return [
      { source: '/leave-requests', destination: '/leave?tab=requests', permanent: true },
      { source: '/home-leave', destination: '/leave?tab=homeleave', permanent: true },
      { source: '/users', destination: '/settings?tab=users', permanent: true },
      { source: '/export', destination: '/monthly?tab=export', permanent: true },
      { source: '/evaluation/raise-history', has: [{ type: 'query', key: 'worker', value: '(?<wid>.*)' }], destination: '/workers?tab=raise-history&worker=:wid', permanent: true },
      { source: '/evaluation/raise-history', destination: '/workers?tab=raise-history', permanent: true },
    ]
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }]
  },
  experimental: {
    // 【サーバ側】firebase-admin（Node 専用・ネイティブ依存多数）を外部パッケージ扱いに。
    // サーバ関数バンドルには含めず、node_modules ごと依存トレースして同梱する。
    // これが無いと require('firebase-admin') が Vercel 上で "Cannot find module" になる。
    serverComponentsExternalPackages: ['firebase-admin'],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 【クライアント側】firebase-admin は絶対にクライアントバンドルへ入れない。
      // lib/attendance.ts 等の共有モジュール経由で fsdb→firebase-admin が
      // クライアントの依存グラフに乗ってしまうため、空モジュールへエイリアスする。
      // 実行時は lib/firebase-admin.ts の `typeof window !== 'undefined'` ガードで
      // require 自体に到達しないので、空モジュールでも問題ない。
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        'firebase-admin': false,
        'firebase-admin/app': false,
        'firebase-admin/firestore': false,
        'firebase-admin/storage': false,
      }
    }
    return config
  },
}

module.exports = nextConfig
