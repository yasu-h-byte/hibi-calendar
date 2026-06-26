/**
 * POST /api/calendar/sign  — 【廃止】2026-06 に無効化
 *
 * 旧フロー: workerId をクライアントから受け取って署名する、名前選択式の公開ページ
 * (/calendar/public) 用のエンドポイント。workerId を直接受け取るため **誰でも他人の名前で
 * 署名できる（なりすまし可能）** という根本的な穴があった。
 *
 * 本人トークン認証の /api/calendar/sign-self（＋氏名入力による同意セレモニー）へ
 * 一本化したため、本エンドポイントは恒久的に 410 を返して無効化する。
 * （直叩きでのなりすましも遮断する。旧実装は git 履歴を参照）
 */
import { NextRequest, NextResponse } from 'next/server'

export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      error: 'この承認方法は廃止されました。各自の個人リンク（出面と同じQR/リンク）から承認してください。 / Phương thức này đã ngừng. Vui lòng ký từ link cá nhân của bạn.',
      deprecated: true,
    },
    { status: 410 },
  )
}
