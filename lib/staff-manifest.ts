/**
 * スタッフ用リンク（個人の URL）を「ホーム画面に追加」したとき、その人のページが開くようにする（2026-10-02）。
 *
 * 旧: どのページも /manifest.json（start_url: "/"）を指していたので、マイページ等をホーム画面に追加すると
 * アイコンからはログイン画面（/）が開き、パスワードを求められた（日本人社員にマイページのリンクを渡した翌日に判明）。
 * iPhone・Android とも、ホーム画面のアイコンは manifest の start_url を開くため。
 * 新: 個人のページは /api/manifest?kind=…&token=… を指し、start_url をそのページ自身にする。
 */
import type { Metadata } from 'next'

export type StaffManifestKind = 'mypage' | 'attendance' | 'foreman'

const PATH_OF: Record<StaffManifestKind, (token: string) => string> = {
  mypage: t => `/mypage/${t}`,
  attendance: t => `/attendance/${t}`,
  foreman: t => `/attendance/foreman/${t}`,
}
const NAME_OF: Record<StaffManifestKind, string> = {
  mypage: 'マイページ',
  attendance: '出面入力',
  foreman: '職長確認',
}

/** 個人のリンクの token（英数字だけ） */
export const isStaffToken = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9]{4,64}$/.test(t)
export const isStaffManifestKind = (k: unknown): k is StaffManifestKind => typeof k === 'string' && k in PATH_OF

/** ホーム画面用の設定（manifest）の中身 */
export function buildStaffManifest(kind: StaffManifestKind, token: string) {
  const start = PATH_OF[kind](token)
  return {
    id: start,
    name: `DEDURA＋ ${NAME_OF[kind]}`,
    short_name: NAME_OF[kind],
    description: 'HIBI CONSTRUCTION 鳶事業部',
    start_url: start,
    // scope は / のまま（職長確認からマイページへのリンクなど、個人ページ同士の行き来をアプリ内で開く）
    scope: '/',
    display: 'standalone',
    background_color: '#1B2A4A',
    theme_color: '#1B2A4A',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }
}

/** 個人ページの layout の generateMetadata で使う */
export function staffManifestMetadata(kind: StaffManifestKind, token: string): Pick<Metadata, 'manifest'> {
  if (!isStaffToken(token)) return {}
  return { manifest: `/api/manifest?kind=${kind}&token=${encodeURIComponent(token)}` }
}
