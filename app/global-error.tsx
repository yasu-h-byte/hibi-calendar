'use client'
/**
 * いちばん外側（app/layout.tsx）でエラーが起きたときの表示（2026-11-10 全体点検）。
 * ここは layout の代わりに出るので、<html>・<body> を自分で持つ。CSS が読めていない場合もあるため、色・大きさは style で書く
 * （字の大きさは rem。px では指定しない）。
 */
import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[全体のエラー]', error) }, [error])
  return (
    <html lang="ja">
      <body style={{ margin: 0, fontFamily: 'sans-serif', background: '#F4F6F9', color: '#1F2937' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
          <div style={{ maxWidth: '28rem', width: '100%', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '0.625rem', padding: '1.5rem', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.125rem', margin: 0 }}>画面を表示できませんでした</h1>
            <p lang="vi" style={{ fontSize: '0.875rem', color: '#5B6475', margin: '0.25rem 0 0' }}>Không hiển thị được màn hình</p>
            <button
              type="button"
              onClick={() => reset()}
              style={{ width: '100%', height: '3rem', marginTop: '1.25rem', background: '#1B2A4A', color: '#fff', border: 0, borderRadius: '0.625rem', fontWeight: 700, fontSize: '1rem' }}
            >
              もう一度 / Thử lại
            </button>
            <p style={{ fontSize: '0.75rem', color: '#5B6475', marginTop: '1rem' }}>
              何度も出るときは、事務所に知らせてください。
              {error.digest ? <span style={{ display: 'block', marginTop: '0.25rem' }}>番号: {error.digest}</span> : null}
            </p>
          </div>
        </main>
      </body>
    </html>
  )
}
