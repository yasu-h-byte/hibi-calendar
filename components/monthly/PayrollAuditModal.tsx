/**
 * 給与計算根拠の透明化モーダル
 *
 * 2026-06-XX リファクタ: 表示本体は PayrollAuditContent に分離
 *   このファイルはモーダルの枠（ヘッダー・閉じるボタン・スクロール領域）
 *   のみを担当。表示内容はすべて PayrollAuditContent に集約され、
 *   印刷ページ (/monthly/audit-print) とも共有される。
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */
'use client'

import { jobShortLabel } from '@/lib/jobs'
import { Modal, CancelButton } from '@/components/ui/Modal'
import PayrollAuditContent, { type PayrollAuditWorker } from './PayrollAuditContent'

interface Props {
  worker: PayrollAuditWorker
  ym: string
  prescribedDays: number
  baseDays: number
  onClose: () => void
}

export default function PayrollAuditModal({ worker: w, ym, prescribedDays, baseDays, onClose }: Props) {
  const orgName = w.org === 'hfu' ? 'HFU' : '日比建設'
  const yearStr = `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月`

  return (
    <Modal
      open
      onClose={onClose}
      title={`給与計算の根拠（${yearStr}）`}
      sub={`${w.name}（${orgName} / ${jobShortLabel(w.job)}）ID:${w.id}`}
      size="xl"
      footer={<CancelButton onClick={onClose}>閉じる</CancelButton>}
    >
      <PayrollAuditContent
        worker={w}
        ym={ym}
        prescribedDays={prescribedDays}
        baseDays={baseDays}
      />
    </Modal>
  )
}
