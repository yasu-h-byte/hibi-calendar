import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DEDURA＋ - 職長確認',
  description: '出面確認・承認',
  openGraph: {
    title: 'DEDURA＋ - 職長確認',
    description: '出面確認・承認',
    siteName: 'DEDURA＋',
  },
}

export default function ForemanLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
