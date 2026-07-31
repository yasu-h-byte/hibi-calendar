import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DEDURA＋ - 出面入力',
  description: '出勤状況を入力してください',
  openGraph: {
    title: 'DEDURA＋ - 出面入力',
    description: '出勤状況を入力してください',
    siteName: 'DEDURA＋',
  },
}

export default function AttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
