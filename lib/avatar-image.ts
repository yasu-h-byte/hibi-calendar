/**
 * 顔写真をアバター用に縮小する（ブラウザ内で完結・2026-08-03 追加）
 *
 * 方針:
 *   - 元の大きな写真は保存しない。容量だけでなく、必要以上の解像度の顔写真を
 *     持たないほうがプライバシー上も安全なため、アップロード前にここで潰す。
 *   - 正方形に中央トリミング → 一辺 AVATAR_SIZE px → WebP で圧縮。
 *     目標サイズに収まるまで品質を段階的に落とす。
 *   - Safari 15 以前は canvas の WebP エンコードに未対応で、toDataURL('image/webp')
 *     がエラーにならず PNG を返す。戻り値の接頭辞を見て JPEG にフォールバックする。
 */

/** 保存する一辺のピクセル数。一覧は24px、編集画面は48px表示なので Retina でも足りる */
export const AVATAR_SIZE = 160

/** データURIの上限。これを超えたら品質を落として作り直す（目安 12〜25KB） */
export const AVATAR_MAX_BYTES = 40_000

export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif'

function centerCropSquare(img: CanvasImageSource, w: number, h: number) {
  const side = Math.min(w, h)
  return { sx: (w - side) / 2, sy: (h - side) / 2, side }
}

/**
 * 画像ファイルをアバター用データURIに変換する。
 * @throws 画像として読めなかった場合
 */
export async function fileToAvatarDataUri(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('画像として読み込めませんでした。JPEG / PNG / WebP を選んでください。')
  })

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画像の変換に失敗しました')

  const { sx, sy, side } = centerCropSquare(bitmap, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
  bitmap.close()

  // WebP が使えるか実測する（Safari 15 以前は黙って PNG を返す）
  const probe = canvas.toDataURL('image/webp', 0.8)
  const mime = probe.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'

  for (const quality of [0.8, 0.7, 0.6, 0.5, 0.4]) {
    const uri = canvas.toDataURL(mime, quality)
    if (uri.length <= AVATAR_MAX_BYTES) return uri
  }
  // ここまで来る写真はほぼ無いが、最低品質でも返す（サーバ側が上限で弾く）
  return canvas.toDataURL(mime, 0.35)
}

/** 表示用: 名前の先頭1文字（写真が無い人のフォールバック） */
export function avatarInitial(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return '?'
  // 「グエン タイン フウ」のような姓名分割でも先頭1文字で十分区別がつく
  return Array.from(trimmed)[0]
}
