'use client'

import { useEffect } from 'react'

/**
 * 電波が無いときの画面（/offline.html）を出すための service worker（public/sw.js）を登録する。
 * スタッフ・職長・マイページの画面（components/StaffShell.tsx）だけで使う。
 * 画面を開く通信が失敗したときの差し替えだけで、API や保存には触らない（public/sw.js のコメント参照）。
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV !== 'production') return
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* 登録できなくても画面は動く */ })
  }, [])
  return null
}
