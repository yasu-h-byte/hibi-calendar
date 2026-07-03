'use client'

import { fmtPct } from '@/lib/format'
import { rateBarColor } from '@/lib/leave-utils'
import { PLWorker } from '../types'

// 一覧タブ: KPI・全社消化率・スタッフ別テーブル

interface Props {
  visible: boolean
  filteredWorkers: PLWorker[]
  loading: boolean
  onEdit: (worker: PLWorker) => void
}

export default function ListTab({ visible, filteredWorkers, loading, onEdit }: Props) {
  if (!visible) return null

  const eligible = filteredWorkers.length
  const totalRemaining = filteredWorkers.reduce((s, w) => s + w.remaining, 0)
  const totalUsed = filteredWorkers.reduce((s, w) => s + w.used, 0)
  const totalTotal = filteredWorkers.reduce((s, w) => s + w.total, 0)
  const alertCount = filteredWorkers.filter(w => w.remaining <= 3).length
  const companyRate = totalTotal > 0 ? (totalUsed / totalTotal * 100) : 0

  // ※ 年5日未達のKPI・警告表示は運用上不要のため非表示（2026-07-02 靖仁さん指示）

  return (<>
    {/* KPI */}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
        <div className="text-2xl font-bold text-hibi-navy">{eligible}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">対象人数</div>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
        <div className="text-2xl font-bold text-blue-600">{totalRemaining}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">有給残日数</div>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
        <div className="text-2xl font-bold text-green-600">{totalUsed}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">消化日数</div>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
        <div className={`text-2xl font-bold ${alertCount > 0 ? 'text-red-500' : 'text-green-600'}`}>{alertCount}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">残3日以下</div>
      </div>
    </div>

    {/* Company-wide consumption rate bar */}
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">全社消化率</span>
        <span className="text-sm font-bold text-gray-700 dark:text-gray-300">{fmtPct(companyRate)}（{totalUsed}/{totalTotal}日）</span>
      </div>
      <div className="w-full h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${rateBarColor(companyRate)} transition-all`}
          style={{ width: `${Math.min(100, companyRate)}%` }}
        />
      </div>
    </div>

    {/* Table */}
    {/* === リデザイン: 8列構成・固定行高・ステータスドット === */}
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide">
            <th className="px-3 py-3 font-semibold" style={{ width: '2%' }}></th>
            <th className="px-3 py-3 font-semibold">スタッフ</th>
            <th className="px-3 py-3 font-semibold">有給の内訳</th>
            <th className="px-3 py-3 font-semibold">消化</th>
            <th className="px-3 py-3 font-semibold text-right">残日数</th>
            <th className="px-3 py-3 font-semibold">警告</th>
            <th className="px-3 py-3 font-semibold text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">読み込み中...</td></tr>
          ) : filteredWorkers.length === 0 ? (
            <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">対象者がいません</td></tr>
          ) : filteredWorkers.map(w => {
            const rate = w.total > 0 ? (w.used / w.total * 100) : 0
            const hasCarryOver = (w.carryOverRemaining ?? 0) > 0 && !!w.carryOverExpiryDate
            // ── 総合ステータス判定 (🟢 ok / 🟡 注意 / 🔴 警告) ──
            let statusColor = 'bg-emerald-500'
            let statusLabel = '正常'
            if (w.expiryStatus === 'expired' || w.carryOverExpiryStatus === 'expired') {
              statusColor = 'bg-red-500'
              statusLabel = '要対応'
            } else if (w.remaining <= 3 || w.carryOverExpiryStatus === 'warning' || w.expiryStatus === 'warning') {
              statusColor = 'bg-amber-500'
              statusLabel = '注意'
            }
            const visaLabel = !w.visa || w.visa === 'none' ? '' :
              w.visa === 'jisshu1' ? '実習1号' :
              w.visa === 'jisshu2' ? '実習2号' :
              w.visa === 'jisshu3' ? '実習3号' :
              w.visa === 'tokutei1' ? '特定1号' :
              w.visa === 'tokutei2' ? '特定2号' :
              w.visa === 'tokutei3' ? '特定3号' :
              w.visa
            return (
              <tr key={w.id}
                className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer transition"
                onClick={() => onEdit(w)}
              >
                {/* Status dot */}
                <td className="pl-3 pr-0">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor}`} title={statusLabel}></span>
                </td>
                {/* スタッフ: 固定幅カラムで各要素を縦方向に揃える */}
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      {/* 名前: 固定幅160px */}
                      <div className="w-[160px] flex-shrink-0 truncate" title={w.name}>
                        <span className="font-semibold text-gray-900 dark:text-gray-100">{w.name}</span>
                      </div>
                      {/* 所属バッジ: 固定幅48px */}
                      <div className="w-[44px] flex-shrink-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${w.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {w.org === 'hfu' ? 'HFU' : '日比'}
                        </span>
                      </div>
                      {/* ビザ: 固定幅72px */}
                      <div className="w-[72px] flex-shrink-0">
                        {visaLabel && (
                          <span className="text-[10px] text-gray-500">{visaLabel}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {w.grantDate ? `付与日 ${w.grantDate}` : '付与日未設定'}
                      {w.inferredFromDefault && <span className="ml-1 text-blue-500">💡推定</span>}
                    </div>
                  </div>
                </td>
                {/* 有給の内訳: バケット毎に [ラベル | 日数 | 時効] を1行で表示 (FIFO 順: 繰越 → 当期) */}
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    {/* 繰越バケット（あれば表示） */}
                    {hasCarryOver && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded font-medium text-[10px] whitespace-nowrap ${
                          w.carryOverExpiryStatus === 'expired' ? 'bg-red-100 text-red-700'
                          : w.carryOverExpiryStatus === 'warning' ? 'bg-orange-100 text-orange-700'
                          : 'bg-blue-100 text-blue-700'
                        }`}>
                          {w.carryOverExpiryStatus === 'warning' && '⏰ '}繰越
                        </span>
                        <span className="tabular-nums font-medium text-gray-700 dark:text-gray-200 min-w-[32px] text-right">
                          {w.carryOverRemaining}<span className="text-[10px] text-gray-400 ml-0.5">日</span>
                        </span>
                        <span className={`text-[10px] tabular-nums ${
                          w.carryOverExpiryStatus === 'warning' ? 'text-orange-600 font-semibold' : 'text-gray-400'
                        }`}>
                          〜{w.carryOverExpiryDate}
                        </span>
                      </div>
                    )}
                    {/* 当期バケット */}
                    {w.grantDays > 0 && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded font-medium text-[10px] whitespace-nowrap ${
                          w.expiryStatus === 'expired' ? 'bg-red-100 text-red-700'
                          : w.expiryStatus === 'warning' ? 'bg-orange-100 text-orange-700'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                        }`}>
                          当期
                        </span>
                        <span className="tabular-nums font-medium text-gray-700 dark:text-gray-200 min-w-[32px] text-right">
                          {w.grantRemaining ?? w.grantDays}<span className="text-[10px] text-gray-400 ml-0.5">日</span>
                        </span>
                        <span className={`text-[10px] tabular-nums ${
                          w.expiryStatus === 'expired' ? 'text-red-600 font-semibold'
                          : w.expiryStatus === 'warning' ? 'text-orange-600 font-semibold'
                          : 'text-gray-400'
                        }`}>
                          〜{w.expiryStatus === 'expired' ? '期限切れ' : w.expiryDate}
                        </span>
                      </div>
                    )}
                    {/* 調整がある場合のみ副次情報として */}
                    {w.adjustment > 0 && (
                      <div className="text-[10px] text-gray-400">
                        調整 {w.adjustment}日
                      </div>
                    )}
                  </div>
                </td>
                {/* 消化: バー + 数値 */}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${rateBarColor(rate)} transition-all`}
                        style={{ width: `${Math.min(100, rate)}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap tabular-nums">
                      <span className="font-medium">{w.used}</span><span className="text-gray-400">/{w.total}</span>
                    </div>
                  </div>
                </td>
                {/* 残日数: 大きく表示（申請ベース＝管理の正） */}
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={`text-2xl font-bold ${w.remaining <= 3 ? 'text-red-500' : w.remaining <= 5 ? 'text-amber-500' : 'text-gray-800 dark:text-gray-100'}`}>
                    {w.remaining}
                  </span>
                  <span className="text-[10px] text-gray-400 ml-0.5">日</span>
                  {/* 実消化ベース残（参考・2026-06）: 承認済みの未来分を引かず「今日まで実際に取得した分」だけ
                      引いた残日数。管理の正は上の大きい数字（申請ベース）。スマホ表示・年5日義務も申請ベースのまま。
                      申請ベース残と一致する場合（未来の承認済み有給が無い）は冗長なので非表示。 */}
                  {(w.remainingActual ?? w.remaining) !== w.remaining && (
                    <div
                      className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5"
                      title="実消化ベース残＝今日までに実際に取得した有給だけを引いた残日数（参考）。上の大きい残日数は「申請ベース」（承認済みの未来有給も引く）で、管理・スマホ表示・年5日義務はこちらが正です。"
                    >
                      実消化残 {w.remainingActual ?? w.remaining}日
                    </div>
                  )}
                </td>
                {/* 警告: 期限切れ 等 */}
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {w.expiryStatus === 'expired' && (
                      <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
                        期限切れ
                      </span>
                    )}
                    {w.carryOverExpiryStatus === 'warning' && (
                      <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-bold" title="繰越分の時効間近">
                        繰越3ヶ月
                      </span>
                    )}
                  </div>
                </td>
                {/* 操作 */}
                <td className="px-3 py-2 text-right">
                  <button onClick={e => {
                    e.stopPropagation()
                    onEdit(w)
                  }} className="text-hibi-navy dark:text-blue-400 text-xs hover:underline px-2 py-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30">編集</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-4 pl-1">
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>正常</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block"></span>注意（残≤5日/時効3ヶ月以内）</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>要対応（期限切れ）</span>
      <span className="ml-auto text-gray-400">行をクリックで編集</span>
    </div>
  </>)
}
