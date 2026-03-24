import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 就業カレンダー',
  description: '就業カレンダーを確認して署名してください / Xác nhận lịch làm việc',
  openGraph: {
    title: 'HIBI CONSTRUCTION - 就業カレンダー',
    description: '就業カレンダーを確認して署名してください / Xác nhận lịch làm việc',
    siteName: 'HIBI CONSTRUCTION',
  },
}

export default function PublicCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
