import { confirmDialog } from '@/lib/confirm-dialog'

/**
 * 「未保存の変更があるときだけ、閉じる前に確かめる」（2026-10-02 総合点検）
 *
 * 右パネル（components/ui/PageParts.tsx の SidePanel）の Esc・背景クリックと、画面側の「閉じる」「×」の
 * 全部がこの1つの関数を通す。旧: 人員マスタ・現場マスタ・取引先マスタの編集フォームが、Esc や背景クリックで
 * 入れかけの内容ごと確認なしで消えていた。
 * React に依存しない純関数なので、画面の部品（.tsx）から分けてここに置き、テストから直接読む。
 */
export const DISCARD_MESSAGE = '保存していない変更があります。閉じると消えます。閉じますか？'

/** 戻り値 true = 閉じてよい */
export function confirmDiscard(dirty: boolean | undefined, message: string = DISCARD_MESSAGE): boolean {
  if (!dirty) return true
  if (typeof window === 'undefined') return true
  return window.confirm(message) // dialog-ok
}

/**
 * 同じ確認を本体の見た目の窓で出す版（UI/UX 磨き込み 土台②・2026-10-03）。
 * SidePanel と画面側の「閉じる」「×」はこちらを await する。文言は見本どおり
 * 「保存していない変更があります／閉じると消えます」＋「閉じずに戻る」「保存せずに閉じる」（赤）。
 */
export async function confirmDiscardDialog(dirty: boolean | undefined): Promise<boolean> {
  if (!dirty) return true
  return confirmDialog({
    title: '保存していない変更があります',
    description: '閉じると消えます。',
    confirmLabel: '保存せずに閉じる',
    cancelLabel: '閉じずに戻る',
    tone: 'danger',
  })
}
