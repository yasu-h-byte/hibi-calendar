import type { Metadata } from 'next'
import './globals.css'

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
    <html lang="ja">
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
