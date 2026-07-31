import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DEDURA＋ - 就業カレンダー',
  description: '就業カレンダー確認・署名 / Lịch làm việc',
  openGraph: {
    title: 'DEDURA＋ - 就業カレンダー',
    description: '就業カレンダー確認・署名 / Lịch làm việc',
    siteName: 'DEDURA＋',
  },
}

export default function SiteCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
