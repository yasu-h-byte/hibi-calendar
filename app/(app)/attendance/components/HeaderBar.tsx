'use client'

import { GridData } from '../types'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, ToolButton, Chip } from '@/components/ui/PageParts'

// 見出し（2026-10-01 出面入力の改修・見本キャンバス7段目）
//   1段目: 題名（ロック中の印・ショートカット案内）と、右に保存状態・配置・一括入力・変更履歴
//   2段目: 現場・月の切り替え・終了した現場も出す・所定日数（2026年4月以前のみ）と、右に人数
//   処理（保存・切り替え）は旧と同じ。見せ方だけ変えた。

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
  onOpenHistory: () => void
  /** 一括入力（入力できる人だけ。応援現場は事業責任者も・2026-09-30） */
  onOpenBulk?: () => void
  onWorkDaysChange: (value: string) => void
  onSiteChange: (id: string) => void
  onYmChange: (ym: string) => void
  onShowArchivedChange: (checked: boolean) => void
}

const SHORTCUTS = [
  'キーボードショートカット',
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
].join('\n')

const selectCls = 'h-[42px] border border-gray-300 dark:border-gray-600 rounded-[10px] px-3 text-[15px] font-bold bg-white dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none'

export default function HeaderBar({
  data, useTimeBased, saveStatus, workDaysInput, siteId, ym, showArchived, allSites, ymOptions,
  onOpenAssign, onOpenHistory, onOpenBulk, onWorkDaysChange, onSiteChange, onYmChange, onShowArchivedChange,
}: Props) {
  // 月の選択肢は新しい月が上（attendance-grid の getYmOptions）。前の月＝下の項目
  const ymIdx = ymOptions.findIndex(o => o.ym === ym)
  const prevYm = ymIdx >= 0 ? ymOptions[ymIdx + 1]?.ym : undefined
  const nextYm = ymIdx > 0 ? ymOptions[ymIdx - 1]?.ym : undefined

  const saveChip = saveStatus === 'saving' ? <Chip tone="blue">保存中...</Chip>
    : saveStatus === 'saved' ? <Chip tone="green">保存済み</Chip>
    : saveStatus === 'error' ? <Chip tone="red">保存失敗 — 内容を確認してください</Chip>
    : null

  return (
    <div className="space-y-3">
      <PageHeader
        group="出面・勤怠"
        title={<span className="inline-flex items-center gap-2 flex-wrap">
          出面入力
          {data?.locked && <Chip tone="red"><span className="inline-flex items-center gap-1"><Icon name="lock" size={12} strokeWidth={2.4} />ロック中</span></Chip>}
          <span title={SHORTCUTS} className="cursor-help px-2 py-0.5 text-[11px] font-normal rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">ショートカット</span>
        </span>}
        actions={<>
          {saveChip}
          <ToolButton icon="users" onClick={onOpenAssign} title="この現場に入る人・外注を選びます">配置</ToolButton>
          {onOpenBulk && <ToolButton icon="pen" onClick={onOpenBulk} title="人と日にちをまとめて選び、同じ内容を一度に入れます">一括入力</ToolButton>}
          {/* 誤削除・誤上書きからの復元（2026-08-28 追加） */}
          <ToolButton icon="clock" onClick={onOpenHistory} title="消した・上書きした記録を元に戻せます（90日保持）">変更履歴</ToolButton>
        </>}
      />

      <div className="flex items-center gap-2.5 flex-wrap">
        {/* 工種サイト（鉄骨など）は出さない。親現場の画面で日ごと・人ごとに工種を切り替える（2026-09-30 代表） */}
        <select value={siteId} onChange={e => onSiteChange(e.target.value)} aria-label="現場" className={`${selectCls} flex-1 min-w-0 sm:flex-none sm:min-w-[260px]`}>
          {(data?.sites || allSites).filter(s => !(s as { parentId?: string }).parentId)
            .filter(s => showArchived || !(s as { archived?: boolean }).archived).map(s => (
            <option key={s.id} value={s.id}>{s.name}{(s as { archived?: boolean }).archived ? '（終了）' : ''}</option>
          ))}
        </select>

        <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
          <button type="button" onClick={() => prevYm && onYmChange(prevYm)} disabled={!prevYm} aria-label="前の月"
            className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px] disabled:opacity-30">
            <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
          </button>
          <select value={ym} onChange={e => onYmChange(e.target.value)} aria-label="年月"
            className="h-full bg-transparent text-[15px] font-bold text-gray-900 dark:text-white focus:outline-none px-1">
            {ymOptions.map(o => <option key={o.ym} value={o.ym}>{o.label}</option>)}
          </select>
          <button type="button" onClick={() => nextYm && onYmChange(nextYm)} disabled={!nextYm} aria-label="次の月"
            className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px] disabled:opacity-30">
            <Icon name="chevronRight" size={18} strokeWidth={2.2} />
          </button>
        </div>

        <label className="flex items-center gap-1.5 text-[13px] text-hibi-sub dark:text-gray-400 cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={showArchived} onChange={e => onShowArchivedChange(e.target.checked)} className="rounded" />
          終了した現場も出す
        </label>

        {/* 所定日数 input（5月以降はカレンダーで確定するため非表示） */}
        {data && !useTimeBased && (
          <div className="flex items-center gap-1.5 text-[13px]">
            <label className="text-hibi-sub dark:text-gray-400 font-bold whitespace-nowrap">所定日数</label>
            <input
              type="number" min="0" max="31" step="1"
              value={workDaysInput}
              onChange={e => onWorkDaysChange(e.target.value)}
              className="w-14 h-9 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-1.5 text-center text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
              placeholder="-"
            />
            <span className="text-hibi-sub">日</span>
            {data.siteWorkDays != null && (
              <span className="text-green-700 dark:text-green-400 whitespace-nowrap" title="就業カレンダーから自動算出">（カレンダー: {data.siteWorkDays}日）</span>
            )}
          </div>
        )}

        {data && (
          <div className="flex items-center gap-1.5 sm:ml-auto">
            {/* 配置の人数（配置外の入力の人は数えない・2026-10-02） */}
            <Chip tone="blue">日比建設 {data.workers.filter(w => w.org === 'hibi' && !w.offRoster).length}名</Chip>
            <Chip tone="gray">HFU {data.workers.filter(w => w.org === 'hfu' && !w.offRoster).length}名</Chip>
            <Chip tone="gray">外注 {data.subcons.length}社</Chip>
          </div>
        )}
      </div>
    </div>
  )
}
