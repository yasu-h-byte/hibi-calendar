'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthUser } from '@/types'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'password' | 'select'>('password')
  const [workers, setWorkers] = useState<{ id: number; name: string }[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError('パスワードが正しくありません')
        return
      }
      const data = await res.json()
      setWorkers(data.workers)
      setStep('select')
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  const handleWorkerSelect = async (workerId: number) => {
    setLoading(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, workerId }),
      })
      if (!res.ok) {
        setError('ログインに失敗しました')
        return
      }
      const data = await res.json()
      const user: AuthUser = data.user
      localStorage.setItem('hibi_auth', JSON.stringify({ password, user }))
      router.push('/calendar')
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-hibi-navy">HIBI CONSTRUCTION</h1>
          <p className="text-sm text-gray-500 mt-1">鳶事業部 管理システム</p>
        </div>

        {step === 'password' ? (
          <form onSubmit={handlePasswordSubmit}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="パスワード"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 mb-4 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
              autoFocus
            />
            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full bg-hibi-navy text-white rounded-lg py-3 font-bold hover:bg-hibi-light transition disabled:opacity-50"
            >
              {loading ? '確認中...' : 'ログイン'}
            </button>
          </form>
        ) : (
          <div>
            <p className="text-sm text-gray-600 mb-4 text-center">名前を選んでください</p>
            <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto">
              {workers.map(w => (
                <button
                  key={w.id}
                  onClick={() => handleWorkerSelect(w.id)}
                  disabled={loading}
                  className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 text-sm font-medium text-hibi-navy hover:bg-hibi-navy hover:text-white transition disabled:opacity-50"
                >
                  {w.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setStep('password'); setError('') }}
              className="w-full mt-4 text-sm text-gray-500 hover:text-gray-700"
            >
              ← パスワード入力に戻る
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
