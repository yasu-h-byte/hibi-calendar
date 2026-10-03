import type { Metadata } from 'next'
import StaffShell from '@/components/StaffShell'
import { staffManifestMetadata } from '@/lib/staff-manifest'

// ホーム画面に追加したアイコンから、このマイページが開くように（ログイン画面に飛ばさない・2026-10-02）
export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  return {
    title: 'DEDURA＋ - マイページ',
    ...staffManifestMetadata('mypage', params.token),
  }
}

export default function MyPageLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell>{children}</StaffShell>
}
