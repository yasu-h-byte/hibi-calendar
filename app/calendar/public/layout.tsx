import type { Metadata } from 'next'
import { getNextMonth } from '@/lib/calendar'

export async function generateMetadata(): Promise<Metadata> {
  const { year, month } = getNextMonth()

  return {
    title: `${year}年${month}月 就業カレンダー - HIBI CONSTRUCTION`,
    description: `HIBI CONSTRUCTION ${year}年${month}月の就業カレンダーです。現場を選んで署名してください。\nLịch làm việc tháng ${month}/${year} - HIBI CONSTRUCTION. Vui lòng chọn công trường và ký xác nhận.`,
    openGraph: {
      title: `📅 ${month}月 就業カレンダー / Lịch làm việc tháng ${month}`,
      description: `HIBI CONSTRUCTION\n現場を選んで署名 → Chọn công trường và ký xác nhận`,
      siteName: 'HIBI CONSTRUCTION',
      type: 'website',
    },
  }
}

export default function PublicCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
