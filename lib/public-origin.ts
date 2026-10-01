/**
 * スタッフに配るURL（マイページ・出面入力の個人リンク）の頭の部分（2026-10-01）。
 *
 * 旧: 画面を開いているドメイン（window.location.origin）をそのまま使っていた。
 *     お試しサイト（Vercel の Preview・…-git-…-yasu-h-bytes-projects.vercel.app）で
 *     URLをコピーすると、Vercel のログインが要る＝スタッフが開けないURLを配ってしまう。
 * 新: お試しサイトや手元（localhost）で開いているときも、配るURLは本番のドメインにする。
 */
export const PRODUCTION_ORIGIN = 'https://hibi-calendar.vercel.app'

/** 今の画面のドメインが本番以外（お試しサイト・手元）か */
export function isNonProductionOrigin(origin: string): boolean {
  if (!origin) return true
  if (origin === PRODUCTION_ORIGIN) return false
  return /-git-|-yasu-h-bytes-projects\.vercel\.app$|^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)
}

/** スタッフに配るURLの頭（本番のドメイン。独自ドメインで開いているときはそのドメイン） */
export function staffLinkOrigin(): string {
  if (typeof window === 'undefined') return PRODUCTION_ORIGIN
  const o = window.location.origin
  return isNonProductionOrigin(o) ? PRODUCTION_ORIGIN : o
}
