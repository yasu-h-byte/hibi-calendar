'use client'

import { PLWorker } from '../types'

// 基準日タブ（閲覧専用: 各スタッフの有給発生月／基準日・次回付与日）

interface Props {
  visible: boolean
  filteredWorkers: PLWorker[]
}

export default function GrantDatesTab({ visible, filteredWorkers }: Props) {
  if (!visible) return null

  const parseYMD = (s: string) => { const [y, m, d] = (s || '').split('-').map(Number); return { y, m, d } }
  // 発生月（基準日）: 当年度レコードの付与日から「毎年○月○日」
  const fmtBasis = (gd: string) => { if (!gd) return '—'; const { m, d } = parseYMD(gd); return `毎年 ${m}月${d}日` }
  // 次回付与日 = 当年度付与日 + 1年（付与は年1回・年次）
  const fmtNext = (gd: string) => { if (!gd) return '—'; const { y, m, d } = parseYMD(gd); return `${y + 1}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}` }
  // 法定起算月: grantMonth 指定があればその月、無ければ 入社日+6ヶ月 の月
  const legalMonth = (w: PLWorker): number | null => {
    if (w.grantMonth) return w.grantMonth
    if (!w.hireDate) return null
    const h = parseYMD(w.hireDate); if (!h.m) return null
    return ((h.m - 1 + 6) % 12) + 1
  }
  const ruleLabel = (w: PLWorker) => w.grantMonth ? `指定（${w.grantMonth}月）` : (w.hireDate ? '入社日＋6ヶ月' : '—')
  // 発生月順 → 日付順 → 名前順
  const rows = [...filteredWorkers].sort((a, b) => {
    const am = a.grantDate ? parseYMD(a.grantDate).m : 99, bm = b.grantDate ? parseYMD(b.grantDate).m : 99
    if (am !== bm) return am - bm
    const ad = a.grantDate ? parseYMD(a.grantDate).d : 99, bd = b.grantDate ? parseYMD(b.grantDate).d : 99
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, 'ja')
  })
  const orgBadge = (org: string) => (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${org === 'hfu' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-200' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'}`}>{org === 'hfu' ? 'HFU' : '日比'}</span>
  )

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-3 text-xs text-gray-600 dark:text-gray-300">
        各スタッフの<strong>有給の発生月（基準日）</strong>と<strong>次回付与日</strong>の一覧です（閲覧専用）。基準日は<strong>当年度の付与日</strong>から表示しています。
        起算ルールは原則「<strong>入社日＋6ヶ月で初回付与、以後毎年その月</strong>」（労基法39条）。個別に基準日（月）を指定している場合は「指定」と表示します。
        <span className="text-amber-600 dark:text-amber-400">ⓘ 印</span>は、実際の付与日の月が「入社日＋6ヶ月」と異なるスタッフです（旧データ・在留更新・基準日統一などで異なることがあり、必ずしも誤りではありません。気になる場合のみ確認）。基準日の変更は「一覧」タブ→各行の編集から行えます。
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide">
              <th className="px-3 py-3 font-semibold">スタッフ</th>
              <th className="px-3 py-3 font-semibold">入社日</th>
              <th className="px-3 py-3 font-semibold">発生月（基準日）</th>
              <th className="px-3 py-3 font-semibold">次回付与日</th>
              <th className="px-3 py-3 font-semibold text-right">当年度付与</th>
              <th className="px-3 py-3 font-semibold text-right">残</th>
              <th className="px-3 py-3 font-semibold">起算ルール</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">対象スタッフがいません</td></tr>
            ) : rows.map(w => {
              const lm = legalMonth(w)
              const actualMonth = w.grantDate ? parseYMD(w.grantDate).m : null
              const mismatch = lm !== null && actualMonth !== null && lm !== actualMonth
              return (
                <tr key={w.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <td className="px-3 py-2.5 whitespace-nowrap font-medium text-gray-900 dark:text-white">
                    <span className="flex items-center gap-1.5">{orgBadge(w.org)}{w.name}{mismatch && <span title="実際の付与日の月が法定起算月とズレています（要確認）" className="text-amber-500">⚠</span>}</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-gray-600 dark:text-gray-300">{w.hireDate || '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-medium text-hibi-navy dark:text-blue-200">
                    {fmtBasis(w.grantDate)}{w.inferredFromDefault && <span className="ml-1 text-[10px] text-gray-400">(推定)</span>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-gray-600 dark:text-gray-300">{fmtNext(w.grantDate)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-300">{w.grantDays}日</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${w.remaining <= 3 ? 'text-red-500' : 'text-blue-600 dark:text-blue-300'}`}>{w.remaining}日</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">{ruleLabel(w)}{mismatch && lm !== null && <span className="text-amber-600 dark:text-amber-400">（法定 {lm}月）</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 pl-1">対象 {rows.length}名 ／ 発生月の早い順。退職済みのスタッフは含みません。</div>
    </div>
  )
}
