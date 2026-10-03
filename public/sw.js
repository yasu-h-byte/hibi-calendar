/*
 * DEDURA＋ の service worker（2026-10-03 UI/UX 磨き込み・スマホ）。
 *
 * 役割は1つだけ: 現場で電波が無いときに、真っ白なエラーでなく「電波がありません / Không có sóng」の画面を出す。
 *   - 画面を開く通信（navigate）だけを見る。ふだんは必ずネットワークから取る（古い画面を出さない）
 *   - 取れなかったときだけ、あらかじめ入れておいた /offline.html を返す
 *   - API・JS・画像は一切さわらない（出面の保存を勝手にためたりしない）
 * 登録は components/ServiceWorkerRegister.tsx（スタッフ・職長・マイページの画面だけ）。
 */
const CACHE = 'dedura-offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL).then(r => r || Response.error())),
  )
})
