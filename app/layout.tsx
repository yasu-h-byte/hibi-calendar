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
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="text-base">{children}</body>
    </html>
  )
}
