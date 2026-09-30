import type { Metadata } from 'next'
import { BIZ_UDPGothic } from 'next/font/google'
import './globals.css'

// 全画面の字（2026-09-30 第2次デザイン刷新「案1 UDホワイト」）。
//   数字の 1/l/I・3/8 や、濁点・半濁点を読み間違えにくい UD 書体。事務の数字確認とスタッフのスマホの両方に効く。
//   Tailwind の font-sans が var(--font-ud) を先頭に持つ（tailwind.config.ts）
const udFont = BIZ_UDPGothic({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-ud',
})

// タブ・PWA はシステム名（DEDURA＋）、画面内の見出し・帳票は会社名（HIBI CONSTRUCTION）。
// 使い分けの基準は components/Brand.tsx を参照。
export const metadata: Metadata = {
  title: 'DEDURA＋ - 出面管理システム',
  description: 'DEDURA＋ | HIBI CONSTRUCTION 鳶事業部 出面管理システム',
  openGraph: {
    title: 'DEDURA＋',
    description: 'HIBI CONSTRUCTION 鳶事業部 出面管理システム',
    siteName: 'DEDURA＋',
    type: 'website',
  },
  icons: {
    icon: [
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/brand/apple-touch-icon.png',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" className={udFont.variable}>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#1B2A4A" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
      </head>
      <body className="text-base">{children}</body>
    </html>
  )
}
