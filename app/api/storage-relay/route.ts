/**
 * ブラウザが Storage へ直接 PUT できないとき（Vercel の Preview・CORS）の中継（2026-10-20・lib/upload-client.ts）。
 *
 * POST multipart/form-data { path, file } → サーバー（Admin SDK）が同じパスに置く。
 * - path は各 API の prepare が出した置き場（prefix/{docId}/…）だけ。prefix ごとに必要な権限を確かめる
 *   （paper-invoices → invoice.paper、subcon-invoices → invoice.subcon、staff-docs → staffDocs.edit、prime-invoices → invoice.request）
 * - 1ファイル 4MB まで（Vercel の API の本文の上限）。種類は各画面と同じ（PDF・JPEG・PNG・WebP・HEIC/HEIF）
 * - 置いたあとの登録（commit）は各 API がこれまでどおり fileMeta で大きさ・種類を確かめる
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireCap } from '@/lib/auth'
import type { Capability } from '@/lib/permissions'
import { uploadBuffer, getStaffDocsBucket } from '@/lib/storage-admin'
import { RELAY_MAX_BYTES } from '@/lib/upload-client'

export const dynamic = 'force-dynamic'

const PREFIX_CAP: { prefix: string; cap: Capability; re: RegExp }[] = [
  { prefix: 'paper-invoices', cap: 'invoice.paper', re: /^paper-invoices\/[0-9a-f-]{36}\/[^/]+$/ },
  { prefix: 'subcon-invoices', cap: 'invoice.subcon', re: /^subcon-invoices\/[0-9a-f-]{36}\/[^/]+$/ },
  { prefix: 'prime-invoices', cap: 'invoice.request', re: /^prime-invoices\/[0-9a-f-]{36}\/[^/]+$/ },
  { prefix: 'staff-docs', cap: 'staffDocs.edit', re: /^staff-docs\/\d+\/[0-9a-f-]{36}\/[^/]+$/ },
]
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']

export async function POST(request: NextRequest) {
  let fd: FormData
  try { fd = await request.formData() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const path = String(fd.get('path') || '')
  const file = fd.get('file')
  if (!path || path.includes('..')) return NextResponse.json({ error: '置き場の指定が不正です' }, { status: 400 })
  const rule = PREFIX_CAP.find(r => path.startsWith(`${r.prefix}/`))
  if (!rule || !rule.re.test(path)) return NextResponse.json({ error: '置き場の指定が不正です' }, { status: 400 })
  // auth: 置き場の種類ごとに、その画面と同じ権限
  const denied = await requireCap(request, rule.cap)
  if (denied) return denied
  if (!(file instanceof File)) return NextResponse.json({ error: 'ファイルがありません' }, { status: 400 })
  if (!(file.size > 0) || file.size > RELAY_MAX_BYTES) return NextResponse.json({ error: 'この経路で送れるのは 4MB までです（大きいファイルは本番の画面から入れてください）' }, { status: 400 })
  const type = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '')
  if (!ALLOWED_TYPES.includes(type)) return NextResponse.json({ error: `この形式は入れられません: ${file.name}` }, { status: 400 })
  if (!getStaffDocsBucket()) return NextResponse.json({ error: 'ファイルの置き場に接続できません（サーバー設定を確認してください）' }, { status: 503 })
  try {
    await uploadBuffer(path, Buffer.from(await file.arrayBuffer()), type)
  } catch (e) {
    console.error('[storage-relay] upload failed', path, e)
    return NextResponse.json({ error: 'ファイルを置けませんでした' }, { status: 503 })
  }
  return NextResponse.json({ ok: true })
}
