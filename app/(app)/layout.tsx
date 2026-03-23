'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import NotificationBell from '@/components/NotificationBell'
import { ToastProvider } from '@/components/Toast'
import { AuthUser } from '@/types'
import { initTheme } from '@/lib/theme'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    initTheme()
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (!stored) {
      router.push('/')
      return
    }
    try {
      const { user } = JSON.parse(stored)
      setUser(user)
    } catch {
      router.push('/')
    }
  }, [router])

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-hibi-navy border-t-transparent rounded-full animate-spin" />
          <div className="text-gray-400 dark:text-gray-500">読み込み中...</div>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
        <Sidebar user={user} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Main content */}
        <div className="lg:ml-64">
          {/* Top bar */}
          <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3 sticky top-0 z-30">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-hibi-navy dark:text-gray-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="flex-1" />
            {user.role === 'admin' && <NotificationBell />}
          </header>

          <main className="p-4 lg:p-6">
            <div className="animate-fadeIn">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
