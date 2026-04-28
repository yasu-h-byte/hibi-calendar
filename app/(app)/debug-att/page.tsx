'use client'

import { useState } from 'react'

interface RepairPlan {
  date: string
  day: number
  oldKey: string
  oldEntry: Record<string, unknown> | null
  newKey: string
  newEntryBefore: Record<string, unknown> | null
  action: 'move' | 'skip-new-exists' | 'no-old-data'
  note?: string
}

interface RepairResult {
  dryRun?: boolean
  success?: boolean
  plans: RepairPlan[]
  historyUpdates: { fyIdx: number; entryIdx: number; date: string; from: string; to: string }[]
  attUpdatesCount?: number
}

interface AttEntry {
  w?: number
  p?: number
  r?: number
  h?: number
  hk?: number
  o?: number
  s?: string
  exam?: number
}

interface DesignatedLeave {
  date: string
  designatedAt: string
  designatedBy: number | string
  note?: string
  siteId: string
  kind?: string
  overwroteHomeLeave?: boolean
}

interface PLRecLite {
  fy: string | number
  grantDate?: string
  grantDays?: number
  designatedLeavesCount: number
  designatedLeaves?: DesignatedLeave[]
}

interface HomeLeaveInfo {
  workerId: number
  startDate: string
  endDate: string
  status: string
  reason?: string
}

interface InspectResult {
  matched: { id: number; name: string; nameVi?: string; visa?: string }[]
  homeLeaves?: HomeLeaveInfo[]
  [key: string]: unknown
}

export default function DebugAttPage() {
  const [workerNameLike, setWorkerNameLike] = useState('ヴゥ')
  const [ym, setYm] = useState('202603')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InspectResult | null>(null)

  // 修復ツール用
  const [repairWorkerId, setRepairWorkerId] = useState('')
  const [repairOldSiteId, setRepairOldSiteId] = useState('sasazuka')
  const [repairNewSiteId, setRepairNewSiteId] = useState('ihi')
  const [repairDates, setRepairDates] = useState('2026-03-07,2026-03-09,2026-03-10,2026-03-11,2026-03-12,2026-03-13,2026-03-14,2026-03-16')
  const [repairLoading, setRepairLoading] = useState(false)
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [skipIfNewExists, setSkipIfNewExists] = useState(true)

  const handleRepair = async (dryRun: boolean) => {
    setRepairLoading(true)
    setRepairError(null)
    setRepairResult(null)
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (!auth) {
        setRepairError('ログイン情報が見つかりません。')
        return
      }
      const { password } = JSON.parse(auth)
      const dates = repairDates.split(',').map(s => s.trim()).filter(Boolean)
      const res = await fetch('/api/debug/repair-att-site', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          workerId: Number(repairWorkerId),
          ym,
          dates,
          oldSiteId: repairOldSiteId,
          newSiteId: repairNewSiteId,
          skipIfNewExists,
          dryRun,
        }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        setRepairError(`エラー (${res.status}): ${JSON.stringify(errData)}`)
        return
      }
      const data: RepairResult = await res.json()
      setRepairResult(data)
    } catch (e) {
      setRepairError(`通信エラー: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRepairLoading(false)
    }
  }

  const handleSubmit = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (!auth) {
        setError('ログイン情報が見つかりません。一度ログアウトしてログインし直してください。')
        return
      }
      const { password } = JSON.parse(auth)
      const res = await fetch('/api/debug/inspect-att', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ workerNameLike, ym }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        setError(`エラー (${res.status}): ${JSON.stringify(errData)}`)
        return
      }
      const data: InspectResult = await res.json()
      setResult(data)
    } catch (e) {
      setError(`通信エラー: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold">🔍 出面データ確認ツール</h1>
      <p className="text-sm text-gray-600">
        帰国マーカー（✈）が有給に変わらないなど、出面データの不整合を調べるためのツールです。
        スタッフの名前と年月を入れて「確認する」を押してください。
      </p>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            スタッフ名（一部でOK・カナ／ベトナム語どちらでも）
          </label>
          <input
            type="text"
            value={workerNameLike}
            onChange={e => setWorkerNameLike(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            placeholder="例: ヴゥ、リン、Vu Duc Linh"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            年月（YYYYMM・6ケタ）
          </label>
          <input
            type="text"
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            placeholder="例: 202603 = 2026年3月"
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={loading || !workerNameLike || !ym}
          className="px-4 py-2 bg-hibi-navy text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? '確認中…' : '確認する'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* ヒットしたスタッフ */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h2 className="font-bold mb-2">🧑 検索でヒットしたスタッフ</h2>
            {result.matched.length === 0 ? (
              <p className="text-sm text-red-600">該当なし</p>
            ) : (
              <ul className="text-sm space-y-1">
                {result.matched.map(w => (
                  <li key={w.id}>
                    ID: <strong>{w.id}</strong> — {w.name}
                    {w.nameVi && <span className="text-gray-500"> ({w.nameVi})</span>}
                    {w.visa && <span className="text-gray-500"> [{w.visa}]</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 各スタッフごとの結果 */}
          {result.matched.map(w => {
            const att = (result[`att_${w.id}`] || {}) as Record<string, AttEntry>
            const pl = (result[`pl_${w.id}`] || []) as PLRecLite[]
            const attKeys = Object.keys(att).sort()
            return (
              <div key={w.id} className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
                <h2 className="font-bold">📋 {w.name} (ID: {w.id}) の {ym} 出面データ</h2>

                {/* 出面データテーブル */}
                {attKeys.length === 0 ? (
                  <p className="text-sm text-gray-500">この月の出面データはまだありません。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs border border-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-2 py-1 border text-left">日付</th>
                          <th className="px-2 py-1 border text-left">現場ID</th>
                          <th className="px-2 py-1 border text-center">出勤(w)</th>
                          <th className="px-2 py-1 border text-center">有給(p)</th>
                          <th className="px-2 py-1 border text-center">休み(r)</th>
                          <th className="px-2 py-1 border text-center">現場休(h)</th>
                          <th className="px-2 py-1 border text-center">帰国(hk)</th>
                          <th className="px-2 py-1 border text-center">残業(o)</th>
                          <th className="px-2 py-1 border text-left">画面表示</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attKeys.map(k => {
                          const e = att[k]
                          // key format: siteId_workerId_ym_day
                          const parts = k.split('_')
                          const day = parts[parts.length - 1]
                          const siteId = parts.slice(0, parts.length - 3).join('_')
                          // 表示判定 (ロジックを画面と揃える)
                          let shown = '—'
                          if (e.p && e.p > 0) shown = '🌴 有給(P)'
                          else if (e.exam && e.exam > 0) shown = '📝 試験(E)'
                          else if (e.r && e.r > 0) shown = '🏠 休み(R)'
                          else if (e.h && e.h > 0) shown = '🚧 現場休み(H)'
                          else if (e.hk && e.hk > 0) shown = '✈️ 帰国(HK)'
                          else if (e.w && e.w > 0) shown = `🔨 出勤 (w=${e.w})`
                          const hasMixedHk = e.hk && (e.p || e.r || e.h || e.exam)
                          return (
                            <tr key={k} className={hasMixedHk ? 'bg-yellow-50' : ''}>
                              <td className="px-2 py-1 border font-mono">{day}日</td>
                              <td className="px-2 py-1 border font-mono text-gray-500">{siteId}</td>
                              <td className="px-2 py-1 border text-center">{e.w ?? ''}</td>
                              <td className="px-2 py-1 border text-center font-bold">{e.p ?? ''}</td>
                              <td className="px-2 py-1 border text-center">{e.r ?? ''}</td>
                              <td className="px-2 py-1 border text-center">{e.h ?? ''}</td>
                              <td className="px-2 py-1 border text-center font-bold text-cyan-600">{e.hk ?? ''}</td>
                              <td className="px-2 py-1 border text-center">{e.o ?? ''}</td>
                              <td className="px-2 py-1 border">{shown}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <p className="text-xs text-gray-500 mt-1">
                      💡 黄色の行は「帰国(hk)」と他のステータスが両方入っている要注意データです。
                    </p>
                  </div>
                )}

                {/* 有給レコード */}
                <div>
                  <h3 className="font-bold text-sm mb-2">🌴 有給レコードと履歴</h3>
                  {pl.length === 0 ? (
                    <p className="text-sm text-gray-500">有給レコードはありません。</p>
                  ) : (
                    <div className="space-y-2">
                      {pl.map((r, i) => (
                        <div key={i} className="border border-gray-200 rounded p-2 text-xs">
                          <div className="font-mono">
                            FY: {String(r.fy)} / 付与日: {r.grantDate ?? '-'} / 付与日数: {r.grantDays ?? '-'} /
                            履歴件数: {r.designatedLeavesCount}
                          </div>
                          {r.designatedLeaves && r.designatedLeaves.length > 0 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-blue-600">履歴を表示</summary>
                              <ul className="mt-1 ml-4 list-disc">
                                {r.designatedLeaves.map((dl, j) => (
                                  <li key={j} className="font-mono">
                                    {dl.date} ({dl.kind ?? '-'})
                                    {dl.overwroteHomeLeave && ' ✈帰国期間上書き'}
                                    — siteId: <span className="text-gray-500">{dl.siteId}</span>
                                    {dl.note && <span className="text-gray-500"> note: {dl.note}</span>}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* 帰国情報 */}
          {result.homeLeaves && result.homeLeaves.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="font-bold mb-2">✈️ 帰国情報（全スタッフ）</h2>
              <ul className="text-xs space-y-1 font-mono">
                {result.homeLeaves
                  .filter(hl => result.matched.some(w => w.id === hl.workerId))
                  .map((hl, i) => (
                    <li key={i}>
                      workerId: {hl.workerId} / {hl.startDate} 〜 {hl.endDate} / status: {hl.status}
                      {hl.reason && ` / 理由: ${hl.reason}`}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* 生データ */}
          <details className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <summary className="cursor-pointer font-bold text-sm">🛠 生データ（開発担当用）</summary>
            <pre className="mt-2 text-xs overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* 修復ツール */}
      <div className="mt-12 border-t-2 border-red-200 pt-6">
        <h2 className="text-lg font-bold text-red-700 mb-2">🩹 出面データ現場移し替えツール</h2>
        <p className="text-sm text-gray-600 mb-4">
          誤った現場に書き込まれた有給データを、正しい現場に移し替えます。
          <strong className="text-red-600">必ず先に「ドライラン」で結果プレビューを確認してから実行してください。</strong>
        </p>

        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                スタッフID（数値）
              </label>
              <input
                type="text"
                value={repairWorkerId}
                onChange={e => setRepairWorkerId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="例: 109"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                対象月（上の検索と同じ年月を使用）
              </label>
              <input
                type="text"
                value={ym}
                disabled
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                誤って書かれた現場ID（移動元）
              </label>
              <input
                type="text"
                value={repairOldSiteId}
                onChange={e => setRepairOldSiteId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="例: sasazuka"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                正しい現場ID（移動先）
              </label>
              <input
                type="text"
                value={repairNewSiteId}
                onChange={e => setRepairNewSiteId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="例: ihi"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              対象日付（YYYY-MM-DD形式・カンマ区切り）
            </label>
            <textarea
              value={repairDates}
              onChange={e => setRepairDates(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
              rows={3}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="skipIfNewExists"
              checked={skipIfNewExists}
              onChange={e => setSkipIfNewExists(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="skipIfNewExists" className="text-sm text-gray-700">
              移動先にすでに有給データがある日は、移動元のみ削除（重複防止・推奨ON）
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleRepair(true)}
              disabled={repairLoading || !repairWorkerId}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {repairLoading ? '確認中…' : '👀 ドライラン（プレビューのみ）'}
            </button>
            <button
              onClick={() => {
                if (confirm(`本当に修復を実行しますか？\n\n対象: workerId=${repairWorkerId}, ${repairOldSiteId} → ${repairNewSiteId}\n${repairDates.split(',').length}日分`)) {
                  handleRepair(false)
                }
              }}
              disabled={repairLoading || !repairWorkerId}
              className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {repairLoading ? '実行中…' : '⚠️ 本番実行'}
            </button>
          </div>
        </div>

        {repairError && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {repairError}
          </div>
        )}

        {repairResult && (
          <div className="mt-4 bg-white border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 className="font-bold">
              {repairResult.dryRun ? '👀 ドライラン結果（変更なし）' : '✅ 修復実行完了'}
            </h3>
            <div>
              <h4 className="text-sm font-medium mb-1">出面データの変更計画</h4>
              <table className="min-w-full text-xs border border-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 border text-left">日付</th>
                    <th className="px-2 py-1 border text-left">アクション</th>
                    <th className="px-2 py-1 border text-left">移動元データ</th>
                    <th className="px-2 py-1 border text-left">移動先(変更前)</th>
                    <th className="px-2 py-1 border text-left">備考</th>
                  </tr>
                </thead>
                <tbody>
                  {repairResult.plans.map(p => (
                    <tr key={p.date} className={
                      p.action === 'move' ? 'bg-green-50'
                      : p.action === 'skip-new-exists' ? 'bg-yellow-50'
                      : 'bg-gray-50'
                    }>
                      <td className="px-2 py-1 border font-mono">{p.date}</td>
                      <td className="px-2 py-1 border font-mono">{p.action}</td>
                      <td className="px-2 py-1 border font-mono">{p.oldEntry ? JSON.stringify(p.oldEntry) : '(なし)'}</td>
                      <td className="px-2 py-1 border font-mono">{p.newEntryBefore ? JSON.stringify(p.newEntryBefore) : '(なし)'}</td>
                      <td className="px-2 py-1 border text-xs">{p.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4 className="text-sm font-medium mb-1">履歴の siteId 更新計画</h4>
              <p className="text-xs text-gray-500">
                {repairResult.historyUpdates.length}件の履歴を {repairOldSiteId} → {repairNewSiteId} に更新
              </p>
            </div>
            <details>
              <summary className="cursor-pointer text-sm">生レスポンス</summary>
              <pre className="mt-2 text-xs overflow-x-auto whitespace-pre-wrap break-all bg-gray-50 p-2 rounded">
                {JSON.stringify(repairResult, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
