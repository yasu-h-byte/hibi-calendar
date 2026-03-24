import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 就業カレンダー',
  description: '就業カレンダー確認・署名 / Lịch làm việc',
  openGraph: {
    title: 'HIBI CONSTRUCTION - 就業カレンダー',
    description: '就業カレンダー確認・署名 / Lịch làm việc',
    siteName: 'HIBI CONSTRUCTION',
  },
}

export default function SiteCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
