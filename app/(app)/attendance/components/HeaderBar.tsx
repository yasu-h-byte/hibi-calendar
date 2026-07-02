'use client'

import { GridData } from '../types'

// ヘッダー行: タイトル・ショートカット案内・ロック表示・人数バッジ・配置編集・
// 所定日数・保存状態・現場/年月選択

interface Props {
  data: GridData | null
  useTimeBased: boolean
  saveStatus: null | 'saving' | 'saved' | 'error'
  workDaysInput: string
  siteId: string
  ym: string
  showArchived: boolean
  allSites: { id: string; name: string; archived?: boolean }[]
  ymOptions: { ym: string; label: string }[]
  onOpenAssign: () => void
  onWorkDaysChange: (value: string) => void
  onSiteChange: (id: string) => void
  onYmChange: (ym: string) => void
  onShowArchivedChange: (checked: boolean) => void
}

export default function HeaderBar({
  data, useTimeBased, saveStatus, workDaysInput, siteId, ym, showArchived, allSites, ymOptions,
  onOpenAssign, onWorkDaysChange, onSiteChange, onYmChange, onShowArchivedChange,
}: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <h1 className="text-lg sm:text-xl font-bold text-hibi-navy dark:text-white flex items-center gap-2">
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        出面入力
        {/* 2026-06-XX 追加 (UI #5): キーボードショートカット案内 */}
        <span
          className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-normal bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full cursor-help"
          title={[
            '⌨️ キーボードショートカット',
            '',
            '【セル内】',
            ' W → 出勤 / P → 有給 / R → 休み',
            ' E → 試験 / H → 現場休',
            ' (select の標準動作: 文字キーで該当オプションへジャンプ)',
            '',
            '【ナビゲーション】',
            ' Enter → 同じ日の次のスタッフへ移動',
            ' Shift+Enter → 同じ日の前のスタッフへ移動',
            ' Tab → 同じ行の次のセル',
            ' Shift+Tab → 同じ行の前のセル',
            '',
            '【その他】',
            ' Esc → フォーカス解除（誤入力時）',
            ' Cmd+S (Mac) / Ctrl+S (Win) → 自動保存中なので何も起きません',
            '   （ブラウザのページ保存ダイアログを抑制）',
          ].join('\n')}
        >
          ⌨️ ショートカット
        </span>
      </h1>

      {data?.locked && (
        <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-100 text-red-700 text-xs font-bold rounded-full">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          ロック中
        </span>
      )}

      {/* Organization count badges */}
      {data && (
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
            日比建設 {data.workers.filter(w => w.org === 'hibi').length}名
          </span>
          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
            HFU {data.workers.filter(w => w.org === 'hfu').length}名
          </span>
          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
            外注 {data.subcons.length}社
          </span>
        </div>
      )}

      {/* 配置編集 button */}
      <button
        onClick={onOpenAssign}
        className="text-xs px-3 py-1.5 border border-hibi-navy text-hibi-navy rounded-lg hover:bg-hibi-navy hover:text-white transition"
      >
        配置編集
      </button>

      {/* 所定日数 input（5月以降はカレンダーで確定するため非表示） */}
      {data && !useTimeBased && (
        <div className="flex items-center gap-1.5 text-xs">
          <label className="text-gray-600 font-medium whitespace-nowrap">所定日数:</label>
          <input
            type="number"
            min="0"
            max="31"
            step="1"
            value={workDaysInput}
            onChange={e => onWorkDaysChange(e.target.value)}
            className="w-14 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-1.5 py-1 text-center text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
            placeholder="-"
          />
          <span className="text-gray-400">日</span>
          {data.siteWorkDays != null && (
            <span className="text-green-600 dark:text-green-400 whitespace-nowrap" title="就業カレンダーから自動算出">
              (カレンダー: {data.siteWorkDays}日)
            </span>
          )}
        </div>
      )}

      {/* Save status indicator */}
      {saveStatus && (
        <span className={`text-xs flex items-center gap-1 font-bold px-2 py-1 rounded ${
          saveStatus === 'saving' ? 'text-hibi-navy' :
          saveStatus === 'saved' ? 'text-green-600' :
          'text-red-700 bg-red-100 dark:bg-red-900/40 dark:text-red-300'
        }`}>
          {saveStatus === 'saving' ? (
            <>
              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              保存中...
            </>
          ) : saveStatus === 'saved' ? (
            <>&#x2713; 保存済み</>
          ) : (
            <>⚠️ 保存失敗 — 内容を確認してください</>
          )}
        </span>
      )}

      <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:ml-auto">
        {/* Site selector */}
        <select
          value={siteId}
          onChange={e => onSiteChange(e.target.value)}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none flex-1 min-w-0 sm:min-w-[180px]"
        >
          {(data?.sites || allSites).filter(s => showArchived || !(s as { archived?: boolean }).archived).map(s => (
            <option key={s.id} value={s.id}>{s.name}{(s as { archived?: boolean }).archived ? '（終了）' : ''}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={showArchived} onChange={e => onShowArchivedChange(e.target.checked)} className="rounded" />
          終了現場
        </label>

        {/* Year/Month selector */}
        <select
          value={ym}
          onChange={e => onYmChange(e.target.value)}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none shrink-0"
        >
          {ymOptions.map(o => (
            <option key={o.ym} value={o.ym}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
