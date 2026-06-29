/** @type {import('next').NextConfig} */
const nextConfig = {
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
      }
    }
    return config
  },
}

module.exports = nextConfig
