import { ToastProvider } from '@/components/Toast'
import { ConfirmHost } from '@/components/ui/Confirm'

/**
 * スタッフ・職長・マイページ（個人リンクで開く画面）の共通の土台（2026-10-03 UI/UX 磨き込み）。
 * 管理画面の app/(app)/layout.tsx と同じく、お知らせの帯（notify）と確認の窓（confirmDialog）を出せるようにする。
 * 各 layout.tsx の children をこれで包む。
 */
export default function StaffShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmHost />
      {children}
    </ToastProvider>
  )
}
