'use client'
/**
 * 会社都合休と自分都合の休みの取り違えの疑いを、出面の画面の上に出す（2026-09-30）
 *
 * 自分の都合の休みの日に、同じ現場でほかの人が現場休み（0.6補）で休んでいた記録を並べる。
 * 人数調整で会社が休ませた日なら、本人の分も現場休み（0.6補）に直す。判定は lib/rest-mismatch.ts。
 * 職長承認の前（PC の出面・職長スマホ）に気づけるように出す。
 */
export default function RestMismatchBanner({
  items, workers, month,
}: {
  items?: { workerId: number; day: number; comp: number }[]
  workers: { id: number | string; name: string }[]
  month: number
}) {
  if (!items || items.length === 0) return null
  const nameOf = (id: number) => workers.find(w => String(w.id) === String(id))?.name || `ID${id}`
  return (
    <div className="rounded-lg px-3 py-2 text-sm bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800">
      <b>⚠ 休みの区別を確認してください（{items.length}件）</b>
      <span className="block text-xs mt-0.5">
        「自分の都合の休み」ですが、同じ日にこの現場でほかの人が現場休み（0.6補）です。
        人数調整で休ませたのなら、現場休み（0.6補）に直してください（自分の都合のままだと給料から引かれます）。
      </span>
      <ul className="mt-1 text-xs flex flex-wrap gap-x-3 gap-y-0.5">
        {items.map(x => (
          <li key={`${x.workerId}_${x.day}`}>{month}/{x.day} {nameOf(x.workerId)}（同じ日の0.6補 {x.comp}人）</li>
        ))}
      </ul>
    </div>
  )
}
