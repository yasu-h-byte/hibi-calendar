/**
 * 休暇管理 保守ツール モーダル（2026-06-XX 新設）
 *
 * 旧UI: ヘッダーに4ボタン（繰越再計算/データ正規化/自動修正/時効処理）を常時表示
 *   問題: 通常運用では不要なのに目立ち、誤操作リスク + 役割が分かりにくい
 *
 * 新UI: 単一の「🔧 保守ツール」ボタン → このモーダル
 *   - health-check API で件数を取得
 *   - 件数 0 のボタン → グレーアウト（実行不要表示）
 *   - 件数 > 0 のボタン → 件数バッジ + 実行ボタン強調
 *   - 時効処理: 最終Cron実行時刻を表示（通常はCron自動なので参考表示）
 */
'use client'

import { useState, useEffect } from 'react'

interface HealthCheck {
  ok: boolean
  // API 応答に counts が欠けるケース（旧バージョン・異常系）があるため optional
  counts?: {
    needsNormalization?: number
    needsFyAutoFix?: number
    needsExpiryProcess?: number
  }
  samples?: {
    normalization?: string[]
    fyAutoFix?: string[]
    expiry?: string[]
  }
  lastExpiryRun?: string | null
}

interface Props {
  password: string
  onClose: () => void
  onChanged: () => void
  onOpenGrantModal: () => void  // 2026-06-XX 追加: 手動有給付与モーダルを開く
}

export default function MaintenanceModal({ password, onClose, onChanged, onOpenGrantModal }: Props) {
  const [health, setHealth] = useState<HealthCheck | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  const fetchHealth = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/leave/health-check', {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        setError(`健全性チェックに失敗しました（HTTP ${res.status}）`)
        return
      }
      const data = await res.json()
      setHealth(data)
    } catch {
      setError('健全性チェックに失敗しました（通信エラー）')
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchHealth() }, [])

  const runAction = async (
    label: string,
    body: Record<string, unknown>,
    resultFormatter: (data: { stats?: Record<string, unknown>; processed?: number; expired?: unknown[]; recordsArchived?: number }) => string,
  ) => {
    setRunning(label)
    try {
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        alert(`✅ ${label}\n\n${resultFormatter(data)}`)
        await fetchHealth()
        onChanged()
      } else {
        alert(`❌ ${label} に失敗しました`)
      }
    } finally { setRunning(null) }
  }

  const handleMigrate = (autoFix: boolean) => runAction(
    `データ正規化${autoFix ? '（fy自動修正含む）' : ''}`,
    { action: 'migrate', autoFixMismatches: autoFix },
    (d) => {
      const s = (d.stats || {}) as Record<string, number>
      return `処理ワーカー: ${s.workersProcessed || 0}名 / 修正レコード: ${s.recordsProcessed || 0}件\n` +
        `旧フィールド昇格: ${s.legacyFieldsUpgraded || 0} / fy正規化: ${s.fyNormalized || 0}\n` +
        `grantDate補完: ${s.grantDatesInferred || 0} / 重複集約: ${s.duplicatesMerged || 0}\n` +
        `期限切れアーカイブ: ${s.recordsArchived || 0}`
    },
  )

  const handleCarryOver = () => runAction(
    '繰越再計算',
    { action: 'carryOver', fy: String(new Date().getFullYear()) },
    () => '全スタッフの最新付与レコードの繰越を再計算しました。',
  )

  const handleExpiry = () => runAction(
    '時効処理',
    { action: 'processExpiry' },
    (d) => {
      const exp = (d.expired || []) as { workerName: string; fy: string; grantDate: string; expiredDays: number }[]
      if (!d.processed) return '失効対象レコードはありませんでした。'
      return `${d.processed}件を失効として記録:\n` +
        exp.slice(0, 10).map(e => `  - ${e.workerName} FY${e.fy} (${e.grantDate}~): ${e.expiredDays}日`).join('\n') +
        (exp.length > 10 ? `\n  ... ほか${exp.length - 10}件` : '')
    },
  )

  const fmtDateTime = (iso: string | null | undefined) => {
    if (!iso) return '未実行'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  if (loading && !health) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl p-6"><div className="text-gray-500">健全性チェック中...</div></div>
      </div>
    )
  }

  if (!health) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
          <div className="text-red-600 font-bold text-sm mb-2">⚠️ 保守ツールを開けません</div>
          <div className="text-sm text-gray-700 mb-4">{error || '健全性チェックの結果を取得できませんでした。'}</div>
          <div className="flex justify-end gap-2">
            <button onClick={fetchHealth} className="px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:opacity-90">
              再試行
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-bold hover:bg-gray-300">
              閉じる
            </button>
          </div>
        </div>
      </div>
    )
  }
  // API 応答に counts が無くてもクラッシュしないようガード（c.xxx は全て optional 参照）
  const c = health.counts ?? {}

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl border border-hibi-line shadow-2xl max-w-2xl w-full my-8" onClick={e => e.stopPropagation()}>
        <div className="bg-hibi-navy text-white px-5 py-4 rounded-t-xl flex justify-between items-center">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">🔧 メニュー</h2>
            <div className="text-xs opacity-80 mt-0.5">例外オペレーション・保守ツール</div>
          </div>
          <button onClick={onClose} className="text-2xl leading-none hover:opacity-70">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* ── 例外オペレーション ── */}
          <div className="border-b border-gray-200 pb-4">
            <div className="text-xs font-bold text-gray-700 mb-2 flex items-center gap-1">
              ✏️ 例外オペレーション
            </div>
            <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-3">
              <div className="flex justify-between items-start gap-3">
                <div className="flex-1">
                  <div className="font-bold text-sm">手動有給付与</div>
                  <div className="text-xs text-gray-600 mt-1">
                    特定スタッフへの個別付与（過去分の遡及・特別付与・補正用）
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    💡 通常の年次付与は「🌴 半自動付与バナー」から実行してください
                  </div>
                </div>
                <button
                  onClick={() => { onOpenGrantModal(); onClose() }}
                  className="text-xs px-3 py-1.5 rounded font-bold whitespace-nowrap bg-green-600 text-white hover:bg-green-700"
                >
                  + 付与する
                </button>
              </div>
            </div>
          </div>

          {/* ── 保守ツール（健全性） ── */}
          <div className="text-xs font-bold text-gray-700 mb-2 flex items-center gap-1">
            🔧 保守ツール（データ整合性）
          </div>

          {/* 全体ステータス */}
          <div className={`rounded-lg p-3 border ${health.ok ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-300'}`}>
            <div className="font-bold text-sm">
              {health.ok ? '✅ 健全 — 保守ツールの実行は不要です' : '⚠️ 修正が必要なレコードがあります'}
            </div>
            {!health.ok && (
              <div className="text-xs text-gray-600 mt-1">下記の「実行」ボタンを押してください。冪等な処理なので何度実行しても安全です。</div>
            )}
          </div>

          {/* データ正規化 */}
          <ActionRow
            title="データ正規化"
            description="旧フィールド・型ブレ・grantDate欠落・重複・期限切れアーカイブを一括修復"
            count={c.needsNormalization || 0}
            samples={health.samples?.normalization}
            disabled={!c.needsNormalization || running !== null}
            running={running === 'データ正規化'}
            onRun={() => handleMigrate(false)}
          />

          {/* 自動修正（fy/grantDate年ズレ） */}
          <ActionRow
            title="自動修正（fy/grantDate年ズレ）"
            description="fy と grantDate の年が一致しないレコードを、grantDate に合わせて修正"
            count={c.needsFyAutoFix || 0}
            samples={health.samples?.fyAutoFix}
            disabled={!c.needsFyAutoFix || running !== null}
            running={running === 'データ正規化（fy自動修正含む）'}
            onRun={() => handleMigrate(true)}
          />

          {/* 繰越再計算 */}
          <ActionRow
            title="繰越再計算"
            description="付与時に自動計算されるため通常不要。旧データの繰越値修復用"
            count={0}
            disabled={running !== null}
            running={running === '繰越再計算'}
            onRun={handleCarryOver}
            optional
          />

          {/* 時効処理 */}
          <div className="border border-gray-200 rounded-lg p-3">
            <div className="flex justify-between items-start gap-3">
              <div className="flex-1">
                <div className="font-bold text-sm flex items-center gap-2">
                  時効処理
                  {(c.needsExpiryProcess || 0) > 0 && (
                    <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full font-bold">
                      {c.needsExpiryProcess}件 要処理
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-1">付与日+2年を過ぎた有給を失効として記録</div>
                <div className="text-[11px] text-gray-500 mt-1">
                  最終自動実行（Cron）: <strong>{fmtDateTime(health.lastExpiryRun)}</strong>
                  <br />
                  自動実行は毎月1日 00:00 JST（Vercel Cron）
                </div>
                {(health.samples?.expiry?.length ?? 0) > 0 && (
                  <details className="text-[10px] text-gray-500 mt-1">
                    <summary className="cursor-pointer">対象レコード（最大5件）</summary>
                    <ul className="list-disc list-inside mt-1">
                      {(health.samples?.expiry || []).map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </details>
                )}
              </div>
              <button
                onClick={handleExpiry}
                disabled={!c.needsExpiryProcess || running !== null}
                className={`text-xs px-3 py-1.5 rounded font-bold whitespace-nowrap ${
                  !c.needsExpiryProcess ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-amber-600 text-white hover:bg-amber-700'
                }`}
              >
                {running === '時効処理' ? '実行中...' : '手動実行'}
              </button>
            </div>
          </div>

          <div className="text-[11px] text-gray-500 border-t pt-3">
            ℹ️ 全てのアクションは冪等です。何度実行しても結果は同じです。
            <br />
            ℹ️ 時効処理は Vercel Cron で月1回自動実行されるため、通常手動実行は不要です。
          </div>
        </div>

        <div className="px-5 py-3 bg-gray-50 rounded-b-xl flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:opacity-90">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function ActionRow({
  title, description, count, samples, disabled, running, onRun, optional,
}: {
  title: string
  description: string
  count: number
  samples?: string[]
  disabled: boolean
  running: boolean
  onRun: () => void
  optional?: boolean
}) {
  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1">
          <div className="font-bold text-sm flex items-center gap-2">
            {title}
            {count > 0 && (
              <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full font-bold">
                {count}件 要処理
              </span>
            )}
            {count === 0 && !optional && (
              <span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">
                ✓ 正常
              </span>
            )}
            {optional && (
              <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">
                修復用
              </span>
            )}
          </div>
          <div className="text-xs text-gray-600 mt-1">{description}</div>
          {(samples?.length ?? 0) > 0 && (
            <details className="text-[10px] text-gray-500 mt-1">
              <summary className="cursor-pointer">対象レコード（最大5件）</summary>
              <ul className="list-disc list-inside mt-1">
                {(samples || []).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </details>
          )}
        </div>
        <button
          onClick={onRun}
          disabled={disabled}
          className={`text-xs px-3 py-1.5 rounded font-bold whitespace-nowrap ${
            disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : count > 0 ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-purple-600 text-white hover:bg-purple-700'
          }`}
        >
          {running ? '実行中...' : '実行'}
        </button>
      </div>
    </div>
  )
}
