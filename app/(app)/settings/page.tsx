'use client'

import { useEffect, useState, useCallback } from 'react'

interface DefaultRates {
  tobiRate: number
  dokoRate: number
}

interface BackupPreview {
  workerCount: number
  siteCount: number
  subconCount: number
  hasAttendance: boolean
  attendanceMonths: number
  hasCalendars: boolean
  raw: Record<string, unknown>
}

export default function SettingsPage() {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Default rates
  const [rates, setRates] = useState<DefaultRates>({ tobiRate: 0, dokoRate: 0 })

  // Backup/Restore
  const [exporting, setExporting] = useState(false)
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        if (pw) setPassword(pw)
      } catch { /* ignore */ }
    }
  }, [])

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const fetchRates = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/settings', {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) throw new Error('Unauthorized')
      const data = await res.json()
      setRates(data.defaultRates || { tobiRate: 0, dokoRate: 0 })
    } catch {
      showMessage('error', '設定の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => {
    if (password) fetchRates()
  }, [password, fetchRates])

  const handleSaveRates = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          action: 'saveDefaultRates',
          tobiRate: rates.tobiRate,
          dokoRate: rates.dokoRate,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      showMessage('success', 'デフォルト単価を保存しました')
    } catch {
      showMessage('error', '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'backup' }),
      })
      if (!res.ok) throw new Error('Export failed')
      const data = await res.json()

      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const filename = `hibi-backup-${dateStr}.json`
      const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      showMessage('success', `${filename} をダウンロードしました`)
    } catch {
      showMessage('error', 'エクスポートに失敗しました')
    } finally {
      setExporting(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const raw = JSON.parse(evt.target?.result as string) as Record<string, unknown>
        const workers = Array.isArray(raw.workers) ? raw.workers : []
        const sites = Array.isArray(raw.sites) ? raw.sites : []
        const subcons = Array.isArray(raw.subcons) ? raw.subcons : []
        const attDocs = (raw._attDocs || {}) as Record<string, unknown>
        const attMonthCount = Object.keys(attDocs).filter(k => k.startsWith('att_')).length
        setImportPreview({
          workerCount: workers.length,
          siteCount: sites.length,
          subconCount: subcons.length,
          hasAttendance: attMonthCount > 0 || !!raw.attend,
          attendanceMonths: attMonthCount,
          hasCalendars: !!raw.calendars,
          raw,
        })
      } catch {
        showMessage('error', 'JSONファイルの読み込みに失敗しました')
        setImportPreview(null)
      }
    }
    reader.readAsText(file)
  }

  const handleRestore = async () => {
    if (!importPreview) return
    setRestoring(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'restore', data: importPreview.raw }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Restore failed')
      }
      showMessage('success', 'データをリストアしました')
      setImportPreview(null)
      setShowConfirm(false)
      fetchRates()
    } catch (err) {
      showMessage('error', `リストアに失敗しました: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestoring(false)
    }
  }

  const adjustRate = (field: 'tobiRate' | 'dokoRate', delta: number) => {
    setRates(prev => ({
      ...prev,
      [field]: Math.max(0, prev[field] + delta),
    }))
  }

  if (loading && password) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">読み込み中...</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-hibi-navy dark:text-white">管理者設定</h1>

      {/* Message toast */}
      {message && (
        <div className={`p-3 rounded-lg text-sm font-medium ${
          message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      {/* Default Rates Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
        <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">デフォルト単価エディタ</h2>

        <div className="space-y-4">
          {/* Tobi Rate */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">鳶基本単価</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => adjustRate('tobiRate', -1000)}
                className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
              >
                −1000
              </button>
              <input
                type="number"
                value={rates.tobiRate}
                onChange={e => setRates(prev => ({ ...prev, tobiRate: Number(e.target.value) || 0 }))}
                className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
              />
              <button
                onClick={() => adjustRate('tobiRate', 1000)}
                className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
              >
                +1000
              </button>
              <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
            </div>
          </div>

          {/* Doko Rate */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">土工基本単価</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => adjustRate('dokoRate', -1000)}
                className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
              >
                −1000
              </button>
              <input
                type="number"
                value={rates.dokoRate}
                onChange={e => setRates(prev => ({ ...prev, dokoRate: Number(e.target.value) || 0 }))}
                className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
              />
              <button
                onClick={() => adjustRate('dokoRate', 1000)}
                className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
              >
                +1000
              </button>
              <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
            </div>
          </div>
        </div>

        <button
          onClick={handleSaveRates}
          disabled={saving}
          className="mt-4 w-full bg-hibi-navy text-white py-2.5 rounded-lg font-medium hover:bg-hibi-navy/90 disabled:opacity-50 transition"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      {/* Backup Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
        <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">バックアップ</h2>

        <p className="text-sm text-gray-600 dark:text-gray-400 dark:text-gray-400 mb-3">
          現在のデータベース全体をJSONファイルとしてダウンロードします。
        </p>

        <button
          onClick={handleExport}
          disabled={exporting}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {exporting ? 'エクスポート中...' : 'JSONエクスポート'}
        </button>
      </div>

      {/* Restore Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
        <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">リストア</h2>

        <p className="text-sm text-gray-600 dark:text-gray-400 dark:text-gray-400 mb-3">
          バックアップJSONファイルからデータを復元します。現在のデータは上書きされます。
        </p>

        <input
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-200 file:text-gray-700 hover:file:bg-gray-300"
        />

        {/* Preview */}
        {importPreview && (
          <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-700">
            <h3 className="font-medium text-gray-800 dark:text-gray-200 mb-2">インポートデータのプレビュー</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-600 dark:text-gray-400">作業員数:</div>
              <div className="font-medium">{importPreview.workerCount}名</div>
              <div className="text-gray-600 dark:text-gray-400">現場数:</div>
              <div className="font-medium">{importPreview.siteCount}件</div>
              <div className="text-gray-600 dark:text-gray-400">外注先数:</div>
              <div className="font-medium">{importPreview.subconCount}件</div>
              <div className="text-gray-600 dark:text-gray-400">出面データ:</div>
              <div className="font-medium">
                {importPreview.hasAttendance ? `あり${importPreview.attendanceMonths > 0 ? `（${importPreview.attendanceMonths}ヶ月分）` : ''}` : 'なし'}
              </div>
              <div className="text-gray-600 dark:text-gray-400">カレンダーデータ:</div>
              <div className="font-medium">{importPreview.hasCalendars ? 'あり' : 'なし'}</div>
            </div>

            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="mt-4 w-full bg-orange-500 text-white py-2.5 rounded-lg font-medium hover:bg-orange-600 transition"
              >
                リストア実行
              </button>
            ) : (
              <div className="mt-4 space-y-2">
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  本当にリストアしますか？現在のデータは全て上書きされます。この操作は取り消せません。
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 py-2.5 rounded-lg font-medium hover:bg-gray-300 dark:hover:bg-gray-500 transition"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleRestore}
                    disabled={restoring}
                    className="flex-1 bg-red-600 text-white py-2.5 rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition"
                  >
                    {restoring ? 'リストア中...' : '確定する'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
