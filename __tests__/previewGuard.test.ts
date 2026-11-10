/**
 * お試しサイト（Vercel の Preview）から本番のデータを書き換えない（2026-11-10 全体点検・lib/preview-guard.ts）。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isPreviewReadOnly, isPreviewWriteBlocked, assertPreviewWritable, PreviewReadOnlyError, PREVIEW_WRITE_ALLOW_PREFIXES,
} from '@/lib/preview-guard'

const PREVIEW = { VERCEL_ENV: 'preview' }
const PREVIEW_WRITE = { VERCEL_ENV: 'preview', PREVIEW_ALLOW_WRITES: '1' }
const PROD = { VERCEL_ENV: 'production' }
const LOCAL = {}

describe('isPreviewReadOnly', () => {
  test('お試しサイトだけ。本番・手元では止めない', () => {
    expect(isPreviewReadOnly(PREVIEW)).toBe(true)
    expect(isPreviewReadOnly(PROD)).toBe(false)
    expect(isPreviewReadOnly(LOCAL)).toBe(false)
  })
  test('PREVIEW_ALLOW_WRITES=1 のときだけ外れる（ほかの値では外れない）', () => {
    expect(isPreviewReadOnly(PREVIEW_WRITE)).toBe(false)
    expect(isPreviewReadOnly({ VERCEL_ENV: 'preview', PREVIEW_ALLOW_WRITES: 'true' })).toBe(true)
    expect(isPreviewReadOnly({ VERCEL_ENV: 'preview', PREVIEW_ALLOW_WRITES: '' })).toBe(true)
  })
})

describe('isPreviewWriteBlocked', () => {
  test('業務のデータは既定で止める（あとから足したコレクションも止まる）', () => {
    for (const p of ['demmen/main', 'demmen/att_202611', 'leaveRequests/abc', 'primeInvoices/x', 'backups/main_20261110',
      'auditTrail/a', 'activityLog', 'これから足すコレクション/1', 'storage/staff-docs/1/uuid/a.pdf', '', undefined, null]) {
      expect(isPreviewWriteBlocked(p, PREVIEW), String(p)).toBe(true)
    }
  })
  test('外すのは、ログインの失敗回数とアクセス履歴だけ', () => {
    expect(isPreviewWriteBlocked('loginThrottle/ip_1', PREVIEW)).toBe(false)
    expect(isPreviewWriteBlocked('accessLog/2026-11-10_1', PREVIEW)).toBe(false)
    expect(isPreviewWriteBlocked('accessLog', PREVIEW)).toBe(false)   // addDoc はコレクションの参照で来る
    expect([...PREVIEW_WRITE_ALLOW_PREFIXES]).toEqual(['loginThrottle/', 'accessLog/'])
  })
  test('名前の頭が似ているだけの場所は通さない', () => {
    expect(isPreviewWriteBlocked('accessLogX/1', PREVIEW)).toBe(true)
    expect(isPreviewWriteBlocked('demmen/accessLog/1', PREVIEW)).toBe(true)
  })
  test('本番・手元・保存を許したお試しサイトでは何も止めない', () => {
    for (const env of [PROD, LOCAL, PREVIEW_WRITE]) expect(isPreviewWriteBlocked('demmen/main', env)).toBe(false)
  })
  test('assertPreviewWritable は止める場所で PreviewReadOnlyError を投げる', () => {
    expect(() => assertPreviewWritable('demmen/main', PREVIEW)).toThrow(PreviewReadOnlyError)
    expect(() => assertPreviewWritable('demmen/main', PROD)).not.toThrow()
  })
})

describe('書き込みの入口が全部、守りを通る', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
  test('lib/fsdb.ts: setDoc / updateDoc / deleteDoc / addDoc は最初に guardWrite を呼ぶ', () => {
    const src = read('lib/fsdb.ts')
    for (const fn of ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc']) {
      expect(src, fn).toMatch(new RegExp(`export async function ${fn}\\([^)]*\\): Promise<[^>]+> \\{\\n  guardWrite\\(`))
    }
    // トランザクションの set / update / delete は markIfMain を通り、markIfMain が guardWrite を呼ぶ
    expect(src).toMatch(/const markIfMain = \(ref: any\) => \{ guardWrite\(ref\);/)
    expect((src.match(/markIfMain\(ref\); return tx\.(set|update|delete)\(/g) || []).length).toBe(3)
  })
  test('lib/storage-admin.ts: 置く・消す・置くためのURL は全部 assertPreviewWritable を呼ぶ', () => {
    const src = read('lib/storage-admin.ts')
    for (const fn of ['signedUploadUrl', 'uploadBuffer', 'uploadBufferIfAbsent', 'deleteFile', 'deleteFilesWithPrefix']) {
      const i = src.indexOf(`export async function ${fn}(`)
      expect(i, fn).toBeGreaterThan(-1)
      expect(src.slice(i, i + 400), fn).toContain('assertPreviewWritable(')
    }
    // Storage に書く・消す呼び出しが、上の5つの関数の外に増えていない
    expect((src.match(/\.save\(|\.delete\(|action: 'write'/g) || []).length).toBe(5)
  })
})
