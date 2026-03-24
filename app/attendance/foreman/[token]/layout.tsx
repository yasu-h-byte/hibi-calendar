import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 職長確認',
  description: '出面確認・承認',
  openGraph: {
    title: 'HIBI CONSTRUCTION - 職長確認',
    description: '出面確認・承認',
    siteName: 'HIBI CONSTRUCTION',
  },
}

export default function ForemanLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
