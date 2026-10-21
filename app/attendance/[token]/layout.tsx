import type { Metadata } from 'next'
import StaffShell from '@/components/StaffShell'
import { staffManifestMetadata } from '@/lib/staff-manifest'

// ホーム画面に追加したアイコンから、この人のページが開くように（ログイン画面に飛ばさない・2026-10-02）
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params   // Next 15: params は Promise
  return {
    title: 'DEDURA＋ - 出面入力',
    description: '出勤状況を入力してください',
    openGraph: {
      title: 'DEDURA＋ - 出面入力',
      description: '出勤状況を入力してください',
      siteName: 'DEDURA＋',
    },
    ...staffManifestMetadata('attendance', token),
  }
}

export default function AttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <StaffShell>{children}</StaffShell>
}
