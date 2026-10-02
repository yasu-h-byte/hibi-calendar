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
  return window.confirm(message)
}
