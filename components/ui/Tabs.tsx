'use client'

import { tabsContainerCls, tabButtonCls } from '@/lib/styles'

interface TabItem<T extends string> {
  id: T
  label: string
}

interface TabsProps<T extends string> {
  tabs: TabItem<T>[]
  active: T
  onChange: (id: T) => void
  className?: string
}

/**
 * 共通タブコンポーネント
 *
 * 8+ 箇所のタブパターン（settings/monthly/leave/evaluation）を統一。
 *
 * 使用例:
 *   const tabs = [
 *     { id: 'list', label: '一覧' },
 *     { id: 'review', label: '評価入力' },
 *     { id: 'approve', label: '承認' },
 *   ] as const
 *   <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
 */
export function Tabs<T extends string>({ tabs, active, onChange, className = '' }: TabsProps<T>) {
  return (
    <div className={`${tabsContainerCls} ${className}`.trim()}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={tabButtonCls(active === tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
