import type { Metadata } from 'next'
import StaffShell from '@/components/StaffShell'
import { staffManifestMetadata } from '@/lib/staff-manifest'

// ホーム画面に追加したアイコンから、この人のページが開くように（ログイン画面に飛ばさない・2026-10-02）
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params   // Next 15: params は Promise
  return {
    title: 'DEDURA＋ - 職長確認',
    description: '出面確認・承認',
    openGraph: {
      title: 'DEDURA＋ - 職長確認',
      description: '出面確認・承認',
      siteName: 'DEDURA＋',
    },
    ...staffManifestMetadata('foreman', token),
  }
}

export default function ForemanLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <StaffShell>{children}</StaffShell>
}
