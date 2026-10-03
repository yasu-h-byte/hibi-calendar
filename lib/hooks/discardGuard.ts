import { confirmDialog } from '@/lib/confirm-dialog'

/**
 * 「未保存の変更があるときだけ、閉じる前に確かめる」（2026-10-02 総合点検）
 *
 * 右パネル（components/ui/PageParts.tsx の SidePanel）・モーダル（components/ui/Modal.tsx）の Esc・背景クリックと、
 * 画面側の「閉じる」「×」の全部がこの1つの関数を通す。旧: 人員マスタ・現場マスタ・取引先マスタの編集フォームが、
 * Esc や背景クリックで入れかけの内容ごと確認なしで消えていた。
 * React に依存しない純関数なので、画面の部品（.tsx）から分けてここに置き、テストから直接読む。
 */
export const DISCARD_MESSAGE = '保存していない変更があります。閉じると消えます。閉じますか？'

/** 戻り値 true = 閉じてよい（ブラウザ標準の窓を使う旧版。テストと互換のために残す） */
export function confirmDiscard(dirty: boolean | undefined, message: string = DISCARD_MESSAGE): boolean {
  if (!dirty) return true
  if (typeof window === 'undefined') return true
  return window.confirm(message) // dialog-ok
}

/**
 * 同じ確認を本体の見た目の窓で出す版（UI/UX 磨き込み 土台②・2026-10-03）。
 * SidePanel・Modal と画面側の「閉じる」「×」はこちらを await する。文言は見本どおり
 * 「保存していない変更があります／閉じると消えます」＋「閉じずに戻る」「保存せずに閉じる」（赤）。
 * スタッフ画面（日越）は bilingual: true で並記・大きいボタンにする。
 */
export async function confirmDiscardDialog(
  dirty: boolean | undefined,
  opts?: { bilingual?: boolean },
): Promise<boolean> {
  if (!dirty) return true
  return confirmDialog({
    title: '保存していない変更があります',
    description: '閉じると消えます。',
    confirmLabel: '保存せずに閉じる',
    cancelLabel: '閉じずに戻る',
    tone: 'danger',
    ...(opts?.bilingual
      ? { vi: { title: 'Có thay đổi chưa lưu', description: 'Đóng lại sẽ mất nội dung đã nhập.', confirmLabel: 'Đóng, không lưu', cancelLabel: 'Quay lại' } }
      : {}),
  })
}
