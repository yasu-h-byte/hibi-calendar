import type { Metadata } from 'next'
import { getSiteById } from '@/lib/sites'
import { getNextMonth } from '@/lib/calendar'

type Props = {
  params: { siteId: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = await getSiteById(params.siteId)
  const { year, month } = getNextMonth()

  const siteName = site?.name || '現場'
  const title = `${year}年${month}月 就業カレンダー - ${siteName}`
  const description = `${siteName}の${year}年${month}月就業カレンダーです。名前を選んで署名してください。\nLịch làm việc tháng ${month}/${year} - ${siteName}. Vui lòng chọn tên và ký xác nhận.`

  return {
    title,
    description,
    openGraph: {
      title: `📅 ${month}月 就業カレンダー / Lịch làm việc`,
      description: `${siteName}\n名前を選んで署名 → Chọn tên và ký xác nhận`,
      siteName: 'HIBI CONSTRUCTION',
      type: 'website',
    },
  }
}

export default function SiteCalendarLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
