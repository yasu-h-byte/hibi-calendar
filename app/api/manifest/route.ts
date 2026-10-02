/**
 * 個人のリンク用のホーム画面の設定（manifest）。start_url をそのページ自身にする（lib/staff-manifest.ts）。
 * GET /api/manifest?kind=mypage|attendance|foreman&token=xxxx
 */
import { NextRequest, NextResponse } from 'next/server'
import { buildStaffManifest, isStaffManifestKind, isStaffToken } from '@/lib/staff-manifest'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // auth: 公開してよいホーム画面の設定（URL を組み立てるだけ・個人情報もデータベースの読み取りもない）
  const kind = request.nextUrl.searchParams.get('kind')
  const token = request.nextUrl.searchParams.get('token')
  if (!isStaffManifestKind(kind) || !isStaffToken(token)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 })
  }
  return new NextResponse(JSON.stringify(buildStaffManifest(kind, token)), {
    // 2026-10-02 総合点検: URL に本人の合言葉が入るので共有キャッシュ（CDN）には載せない（private）
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'private, max-age=3600' },
  })
}
