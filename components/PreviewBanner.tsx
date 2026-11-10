'use client'
/**
 * お試しサイト（Vercel の Preview）であることを知らせる帯（2026-11-10 全体点検・lib/preview-guard.ts）。
 * 本番では何も出さない。お試しサイトは本番と同じデータを見ているので、
 *   - 保存を止めているとき: 「保存できません」と先に伝える（押してから失敗させない）
 *   - 保存を許しているとき: 「本番のデータが変わります」と赤で注意する
 */
export default function PreviewBanner() {
  const mode = process.env.NEXT_PUBLIC_PREVIEW_MODE
  if (mode !== 'readonly' && mode !== 'write') return null
  if (mode === 'write') {
    return (
      <div role="alert" className="print:hidden bg-red-600 text-white text-sm font-bold text-center px-3 py-1.5">
        お試しサイトです。ここでの保存・削除は<span className="underline">本番のデータ</span>を書き換えます
      </div>
    )
  }
  return (
    <div role="status" className="print:hidden bg-amber-100 text-amber-900 text-sm text-center px-3 py-1.5 border-b border-amber-300">
      お試しサイトです（見るだけ）。保存・削除はできません。本番のデータは変わりません
    </div>
  )
}
