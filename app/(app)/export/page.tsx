'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { getYmOptions } from '@/lib/compute'

type ExportType = 'hibi' | 'hfu' | 'subcon' | 'bukake' | 'monthly' | 'pl'

interface ExportCard {
  icon: string
  title: string
  description: string
  format: 'Excel出力' | 'PDF出力'
  type: ExportType
  needsYm: boolean
}

const EXPORT_CARDS: ExportCard[] = [
  {
    icon: '📊',
    title: '日比建設向け 出面一覧',
    description: '日比建設所属の全社員・現場別の出面データをExcel形式で出力します。月次の勤怠集計に利用できます。',
    format: 'Excel出力',
    type: 'hibi',
    needsYm: true,
  },
  {
    icon: '📊',
    title: 'HFU向け 出面一覧',
    description: 'HFU所属の実習生・特定技能生の出面データをExcel形式で出力します。管理団体への報告に利用できます。',
    format: 'Excel出力',
    type: 'hfu',
    needsYm: true,
  },
  {
    icon: '📄',
    title: '外注先向け 出面確認書',
    description: '外注先ごとの出面確認書をExcel形式で出力します。外注先への送付・確認用です。',
    format: 'Excel出力',
    type: 'subcon',
    needsYm: true,
  },
  {
    icon: '📐',
    title: '歩掛管理表',
    description: '現場別の歩掛（人工数・鳶換算）をExcel形式で出力します。原価管理・見積もりに活用できます。',
    format: 'Excel出力',
    type: 'bukake',
    needsYm: true,
  },
  {
    icon: '📈',
    title: '月次レポート',
    description: '月次の売上・原価・粗利をグラフ付きで出力します。経営会議や報告書に利用できます。',
    format: 'PDF出力',
    type: 'monthly',
    needsYm: true,
  },
  {
    icon: '🌴',
    title: '有給管理台帳',
    description: '全社員の有給付与・消化・残日数をExcel形式で出力します。労務管理・監査対応に利用できます。',
    format: 'Excel出力',
    type: 'pl',
    needsYm: false,
  },
]

interface MonthlyReportData {
  workers: {
    name: string; org: string; workDays: number; otHours: number;
    plDays: number; totalCost: number; job: string
  }[]
  subcons: {
    name: string; type: string; workDays: number; otCount: number; cost: number
  }[]
  sites: {
    name: string; workDays: number; subWorkDays: number;
    cost: number; subCost: number; billing: number; profit: number; profitRate: number
  }[]
  totals: {
    workDays: number; subWorkDays: number; cost: number;
    subCost: number; billing: number; profit: number; otHours: number
  }
  siteNames: Record<string, string>
  ym: string
}

export default function ExportPage() {
  const [password, setPassword] = useState('')
  const [selectedYm, setSelectedYm] = useState<Record<string, string>>({})
  const [downloading, setDownloading] = useState<string | null>(null)
  const [error, setError] = useState('')

  const ymOptions = useMemo(() => getYmOptions(12), [])

  // Initialize default ym for all cards
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        setPassword(pw)
      } catch { /* ignore */ }
    }

    const defaults: Record<string, string> = {}
    for (const card of EXPORT_CARDS) {
      if (card.needsYm) {
        defaults[card.type] = ymOptions[0]?.ym || ''
      }
    }
    setSelectedYm(defaults)
  }, [ymOptions])

  const handleDownload = useCallback(async (card: ExportCard) => {
    if (!password) {
      setError('管理者パスワードが設定されていません')
      return
    }

    const ym = selectedYm[card.type]
    if (card.needsYm && !ym) {
      setError('対象月を選択してください')
      return
    }

    setError('')
    setDownloading(card.type)

    try {
      if (card.type === 'monthly') {
        // Monthly report: open printable page in new tab
        const params = new URLSearchParams({ type: 'monthly', ym })
        const res = await fetch(`/api/export?${params}`, {
          headers: { 'x-admin-password': password },
        })

        if (!res.ok) {
          const msg = await res.text()
          setError(msg || 'データ取得に失敗しました')
          return
        }

        const data: MonthlyReportData = await res.json()
        openMonthlyPrintPage(data)
      } else {
        // Excel download
        const params = new URLSearchParams({ type: card.type })
        if (card.needsYm && ym) params.set('ym', ym)

        const res = await fetch(`/api/export?${params}`, {
          headers: { 'x-admin-password': password },
        })

        if (!res.ok) {
          const errText = await res.text()
          setError(errText || 'ダウンロードに失敗しました')
          return
        }

        // Get filename from Content-Disposition header
        const disposition = res.headers.get('Content-Disposition') || ''
        const filenameMatch = disposition.match(/filename="(.+)"/)
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `export_${card.type}.xlsx`

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('Export error:', err)
      setError('エクスポートに失敗しました')
    } finally {
      setDownloading(null)
    }
  }, [password, selectedYm])

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy">帳票出力</h1>
        <p className="text-sm text-gray-500 mt-1">各種帳票をExcel/PDF形式でダウンロードできます</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {EXPORT_CARDS.map((card) => {
          const isDownloading = downloading === card.type

          return (
            <div key={card.type} className="bg-white rounded-xl shadow p-5 flex flex-col">
              <div className="text-3xl mb-3">{card.icon}</div>
              <h3 className="font-bold text-hibi-navy text-sm mb-1">{card.title}</h3>
              <p className="text-xs text-gray-500 mb-4 flex-1">{card.description}</p>

              {card.needsYm && (
                <div className="mb-3">
                  <select
                    value={selectedYm[card.type] || ''}
                    onChange={(e) => setSelectedYm(prev => ({ ...prev, [card.type]: e.target.value }))}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
                  >
                    {ymOptions.map(opt => (
                      <option key={opt.ym} value={opt.ym}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <button
                onClick={() => handleDownload(card)}
                disabled={isDownloading}
                className={`w-full rounded-lg py-2 text-sm font-medium transition flex items-center justify-center gap-2
                  ${isDownloading
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-hibi-navy text-white hover:bg-hibi-light'
                  }`}
              >
                {isDownloading ? (
                  <>
                    <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    <span>ダウンロード中...</span>
                  </>
                ) : (
                  <>
                    <span>{'📥'}</span>
                    <span>{card.format}</span>
                  </>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ────────────────────────────────────────
//  月次レポート印刷用ページ
// ────────────────────────────────────────

function openMonthlyPrintPage(data: MonthlyReportData) {
  const ymLabel = (() => {
    const y = parseInt(data.ym.slice(0, 4))
    const m = parseInt(data.ym.slice(4, 6))
    return `${y}年${m}月`
  })()

  const formatYen = (v: number) => `\u00A5${v.toLocaleString()}`

  const siteRows = data.sites.map(s => `
    <tr>
      <td>${s.name}</td>
      <td class="num">${s.workDays}</td>
      <td class="num">${s.subWorkDays}</td>
      <td class="num">${formatYen(s.cost)}</td>
      <td class="num">${formatYen(s.subCost)}</td>
      <td class="num">${formatYen(s.billing)}</td>
      <td class="num">${formatYen(s.profit)}</td>
      <td class="num">${s.profitRate.toFixed(1)}%</td>
    </tr>
  `).join('')

  const workerRows = data.workers.map(w => `
    <tr>
      <td>${w.name}</td>
      <td>${w.org}</td>
      <td>${w.job}</td>
      <td class="num">${w.workDays}</td>
      <td class="num">${w.otHours}</td>
      <td class="num">${w.plDays}</td>
      <td class="num">${formatYen(w.totalCost)}</td>
    </tr>
  `).join('')

  const subconRows = data.subcons.map(sc => `
    <tr>
      <td>${sc.name}</td>
      <td>${sc.type}</td>
      <td class="num">${sc.workDays}</td>
      <td class="num">${sc.otCount}</td>
      <td class="num">${formatYen(sc.cost)}</td>
    </tr>
  `).join('')

  const t = data.totals

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>月次レポート ${ymLabel}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
  body { font-family: 'Hiragino Sans', 'Meiryo', sans-serif; margin: 20px; color: #1a1a2e; font-size: 12px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin-top: 24px; margin-bottom: 8px; border-bottom: 2px solid #1a1a2e; padding-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .summary-card { background: #f0f4ff; border-radius: 8px; padding: 12px 16px; min-width: 140px; }
  .summary-card .label { font-size: 11px; color: #666; }
  .summary-card .value { font-size: 18px; font-weight: bold; color: #1a1a2e; }
  .summary-card.profit { background: #e8f5e9; }
  .summary-card.loss { background: #ffebee; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1a1a2e; color: white; padding: 6px 8px; text-align: left; font-size: 11px; }
  td { border-bottom: 1px solid #ddd; padding: 5px 8px; font-size: 11px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 2px solid #1a1a2e; font-weight: bold; }
  .print-btn { position: fixed; top: 16px; right: 16px; background: #1a1a2e; color: white; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #2d2d5e; }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">印刷 / PDF保存</button>

  <h1>月次レポート</h1>
  <div class="subtitle">${ymLabel}</div>

  <div class="summary">
    <div class="summary-card">
      <div class="label">売上</div>
      <div class="value">${formatYen(t.billing)}</div>
    </div>
    <div class="summary-card">
      <div class="label">総原価</div>
      <div class="value">${formatYen(t.cost + t.subCost)}</div>
    </div>
    <div class="summary-card ${t.profit >= 0 ? 'profit' : 'loss'}">
      <div class="label">粗利</div>
      <div class="value">${formatYen(t.profit)}</div>
    </div>
    <div class="summary-card">
      <div class="label">自社人工</div>
      <div class="value">${t.workDays}人工</div>
    </div>
    <div class="summary-card">
      <div class="label">外注人工</div>
      <div class="value">${t.subWorkDays}人工</div>
    </div>
    <div class="summary-card">
      <div class="label">残業</div>
      <div class="value">${t.otHours}h</div>
    </div>
  </div>

  <h2>現場別サマリー</h2>
  <table>
    <thead>
      <tr>
        <th>現場名</th><th>自社人工</th><th>外注人工</th>
        <th>自社原価</th><th>外注原価</th><th>請求額</th><th>粗利</th><th>粗利率</th>
      </tr>
    </thead>
    <tbody>
      ${siteRows}
      <tr>
        <td>合計</td>
        <td class="num">${t.workDays}</td>
        <td class="num">${t.subWorkDays}</td>
        <td class="num">${formatYen(t.cost)}</td>
        <td class="num">${formatYen(t.subCost)}</td>
        <td class="num">${formatYen(t.billing)}</td>
        <td class="num">${formatYen(t.profit)}</td>
        <td class="num">${t.billing > 0 ? ((t.profit / t.billing) * 100).toFixed(1) + '%' : '-'}</td>
      </tr>
    </tbody>
  </table>

  <h2>社員別集計</h2>
  <table>
    <thead>
      <tr>
        <th>名前</th><th>所属</th><th>職種</th>
        <th>出勤日数</th><th>残業(h)</th><th>有給</th><th>原価</th>
      </tr>
    </thead>
    <tbody>
      ${workerRows}
    </tbody>
  </table>

  <h2>外注先別集計</h2>
  <table>
    <thead>
      <tr>
        <th>外注先名</th><th>区分</th><th>人工数</th><th>残業人数</th><th>原価</th>
      </tr>
    </thead>
    <tbody>
      ${subconRows}
    </tbody>
  </table>
</body>
</html>`

  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  }
}
