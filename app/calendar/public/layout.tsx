import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DEDURA＋ - 就業カレンダー',
  description: '就業カレンダーを確認して署名してください / Xác nhận lịch làm việc',
  openGraph: {
    title: 'DEDURA＋ - 就業カレンダー',
    description: '就業カレンダーを確認して署名してください / Xác nhận lịch làm việc',
    siteName: 'DEDURA＋',
  },
}

export default function PublicCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
