'use client'

import { avatarInitial } from '@/lib/avatar-image'

/**
 * スタッフの顔写真アバター（2026-08-03 追加）
 *
 * 名前と顔が一致しない問題への対応。写真が無い人は名前の先頭1文字を丸で表示するので、
 * 全員分そろっていなくてもレイアウトが崩れない。
 *
 * 画像は data URI（lib/avatar-image.ts で 160px に圧縮済み）を直接渡す。
 * 公開URLは作らない方針のため next/image は使わず素の img を使う。
 */
export default function WorkerAvatar({
  name,
  src,
  size = 24,
  className = '',
}: {
  name: string
  /** データURI。undefined ならイニシャル表示にフォールバック */
  src?: string
  size?: number
  className?: string
}) {
  const style = { width: size, height: size }

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        title={name}
        style={style}
        // inline-block を必ず付けること。Tailwind の preflight が img を display:block に
        // するため、付け忘れると表のセル内で名前が次の行へ押し出される（2026-08-03 の不具合）
        className={`rounded-full object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0 inline-block align-middle ${className}`}
      />
    )
  }

  return (
    <span
      style={{ ...style, fontSize: Math.round(size * 0.45) }}
      title={name}
      // inline-flex にすること。flex（block級）だと表のセル内で名前が下の行へ折れる
      className={`rounded-full bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-300 font-bold inline-flex items-center justify-center flex-shrink-0 select-none align-middle ${className}`}
    >
      {avatarInitial(name)}
    </span>
  )
}
