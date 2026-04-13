import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 管理システム',
  description: 'HIBI CONSTRUCTION 鳶事業部 管理システム',
  openGraph: {
    title: 'HIBI CONSTRUCTION',
    description: '鳶事業部 管理システム',
    siteName: 'HIBI CONSTRUCTION',
    type: 'website',
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
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/logo.png" />
      </head>
      <body className="text-base">{children}</body>
    </html>
  )
}
