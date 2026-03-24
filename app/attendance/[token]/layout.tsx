import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'HIBI CONSTRUCTION - 出面入力',
  description: '出勤状況を入力してください',
  openGraph: {
    title: 'HIBI CONSTRUCTION - 出面入力',
    description: '出勤状況を入力してください',
    siteName: 'HIBI CONSTRUCTION',
  },
}

export default function AttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
