/**
 * ブラウザから Storage へのアップロード（2026-10-20）。
 *
 * ふだんは署名つきURLへ直接 PUT する（Vercel の API は本文 4.5MB までなので、大きな写真は直接）。
 * ただし置き場の CORS は本番の URL からの PUT しか許可していないので、Vercel の Preview からは
 * ブラウザが PUT を止める（fetch が TypeError で落ちる・画面は「通信がとぎれました」）。
 * そのときは 4MB までのファイルに限り、API（/api/storage-relay）に送ってサーバーから置く。
 * 4MB を超えるファイルは本番で入れてもらう（理由を出す）。
 */
import { fetchWithAuth } from './api-client'

/** API 経由で送れる上限（Vercel の API の本文 4.5MB に余裕を見て） */
export const RELAY_MAX_BYTES = 4 * 1024 * 1024

export interface PreparedUpload { url: string; path: string; contentType: string }

/** 直接 PUT → だめなら API 経由。どちらも失敗したら Error（文面はそのまま notify.failed に渡せる） */
export async function uploadToStorage(u: PreparedUpload, file: File): Promise<void> {
  let direct: Response | null = null
  try {
    direct = await fetch(u.url, { method: 'PUT', headers: { 'Content-Type': u.contentType }, body: file })
  } catch {
    direct = null   // ネットワーク（CORS で止められた・圏外）
  }
  if (direct?.ok) return
  if (direct && direct.status >= 400 && direct.status !== 403) {
    throw new Error(`アップロードに失敗しました: ${file.name}（${direct.status}）`)
  }
  // 直接送れない環境（Preview など）。小さいファイルは API 経由で
  if (file.size > RELAY_MAX_BYTES) {
    throw new Error(`この環境からは ${file.name} を直接送れません（4MB を超えるファイルは本番の画面から入れてください）`)
  }
  const fd = new FormData()
  fd.set('path', u.path)
  fd.append('file', file, file.name)
  const res = await fetchWithAuth('/api/storage-relay', { method: 'POST', body: fd })
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    throw new Error(j?.error || `アップロードに失敗しました: ${file.name}（${res.status}）`)
  }
}
