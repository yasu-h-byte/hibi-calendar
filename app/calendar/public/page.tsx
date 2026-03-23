'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getNextMonth } from '@/lib/calendar'

interface SiteInfo {
  id: string
  name: string
  workerCount: number
  signedCount: number
}

export default function PublicCalendarPage() {
  const { year, month, ym } = getNextMonth()
  const [sites, setSites] = useState<SiteInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/calendar/public-sites?ym=${ym}`)
      .then(r => r.json())
      .then(data => setSites(data.sites || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [ym])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold">HIBI CONSTRUCTION</h1>
          <p className="text-sm opacity-80">就業カレンダー / Lịch làm việc</p>
          <p className="text-sm opacity-60 mt-1">{year}年{month}月 / Tháng {month}/{year}</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4">
        <p className="text-sm text-gray-600 mb-4 text-center">
          現場を選んでください / Chọn công trường
        </p>

        {loading ? (
          <div className="text-center py-8 text-gray-400">読み込み中... / Đang tải...</div>
        ) : sites.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-gray-400 text-lg mb-2">カレンダー準備中</div>
            <div className="text-gray-400 text-sm">Lịch đang được chuẩn bị</div>
          </div>
        ) : (
          <div className="space-y-3">
            {sites.map(site => (
              <Link
                key={site.id}
                href={`/calendar/site/${site.id}`}
                className="block bg-white rounded-xl shadow p-4 hover:bg-gray-50 transition active:scale-[0.98]"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-hibi-navy">{site.name}</h3>
                    <p className="text-xs text-gray-500 mt-1">
                      {site.signedCount}/{site.workerCount}名 署名済み
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
