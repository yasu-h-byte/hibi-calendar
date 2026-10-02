import type { Metadata } from 'next'
import { staffManifestMetadata } from '@/lib/staff-manifest'

// ホーム画面に追加したアイコンから、この人のページが開くように（ログイン画面に飛ばさない・2026-10-02）
export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  return {
    title: 'DEDURA＋ - 職長確認',
    description: '出面確認・承認',
    openGraph: {
      title: 'DEDURA＋ - 職長確認',
      description: '出面確認・承認',
      siteName: 'DEDURA＋',
    },
    ...staffManifestMetadata('foreman', params.token),
  }
}

export default function ForemanLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
