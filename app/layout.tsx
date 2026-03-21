import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 就業カレンダー',
  description: '就業カレンダー確認・署名システム',
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
