'use client'

import { useState } from 'react'
import { ToolButton } from '@/components/ui/PageParts'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { Icon } from '@/components/ui/Icon'
import { notify } from '@/lib/notify'

/**
 * 有給管理簿（Excel）の出力（2026-10-05 代表依頼）。
 * 会社ごと（日比建設・HFU）／日本人スタッフ／ベトナム人スタッフ の4つから選ぶ。中身は「一覧表＋1人1枚の個人票」
 * （lib/leave-ledger.ts）。既定は今の期と前の期。保存用に全期間も出せる。
 */
const CHOICES = [
  { scope: 'hibi', label: '日比建設', sub: '会社ごと（社労士・監督署への提出用）' },
  { scope: 'hfu', label: 'HFU', sub: '会社ごと（社労士・監督署への提出用）' },
  { scope: 'jp', label: '日本人スタッフ', sub: '両社の日本人（入社6か月後・以後1年ごとの付与と年5日の確認）' },
  { scope: 'vn', label: 'ベトナム人スタッフ', sub: '両社のベトナム人（在留資格・繰越・買取つき）' },
] as const

export default function LedgerExportButton({ password }: { password: string }) {
  const [open, setOpen] = useState(false)
  const [allPeriods, setAllPeriods] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const download = async (scope: string) => {
    setBusy(scope)
    try {
      const res = await fetch(`/api/leave/export-ledger?scope=${scope}${allPeriods ? '&range=all' : ''}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        notify.failed('管理簿の出力', err?.error || 'サーバが受け付けませんでした', '時間をおいてもう一度お試しください')
        return
      }
      // ファイル名はサーバが決める（Content-Disposition の filename="…"・URL エンコード済み）
      const cd = res.headers.get('Content-Disposition') || ''
      const m = /filename="([^"]+)"/.exec(cd)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = m ? decodeURIComponent(m[1]) : '有給管理簿.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      notify.failed('管理簿の出力', e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <ToolButton icon="download" title="年次有給休暇管理簿（労基法施行規則24条の7）を Excel で出力" onClick={() => setOpen(true)}>
        管理簿（Excel）
      </ToolButton>
      <Modal open={open} onClose={() => setOpen(false)} size="md" autoFocus="none"
        title="有給管理簿を出力する"
        sub="先頭に全員の一覧表、そのあとに1人1枚の個人票（基準日・付与日数・取得した日・残日数・年5日の取得）"
        footer={<CancelButton onClick={() => setOpen(false)}>閉じる</CancelButton>}>
        <div className="space-y-2">
          {CHOICES.map(ch => (
            <button key={ch.scope} type="button" disabled={busy !== null} onClick={() => download(ch.scope)}
              className="w-full flex items-center justify-between gap-3 text-left rounded-[10px] border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-hibi-bg dark:hover:bg-gray-700 px-4 py-3 transition disabled:opacity-50">
              <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-900 dark:text-white">{ch.label}</span>
                <span className="block text-xs text-hibi-sub dark:text-gray-400">{ch.sub}</span>
              </span>
              <span className="shrink-0 inline-flex items-center gap-1.5 text-sm font-bold text-hibi-navy dark:text-blue-300">
                <Icon name="download" size={15} />{busy === ch.scope ? '作っています…' : 'Excel'}
              </span>
            </button>
          ))}
          <label className="flex items-start gap-2 pt-2 text-sm text-gray-800 dark:text-gray-100">
            <input type="checkbox" checked={allPeriods} onChange={e => setAllPeriods(e.target.checked)} className="w-4 h-4 mt-0.5" />
            <span>全期間を出す（保存用）
              <span className="block text-xs text-hibi-sub dark:text-gray-400">チェックなしは「今の期と前の期」だけ。過去の期もすべて要るとき（監督署の調査など）にチェック</span>
            </span>
          </label>
        </div>
      </Modal>
    </>
  )
}
