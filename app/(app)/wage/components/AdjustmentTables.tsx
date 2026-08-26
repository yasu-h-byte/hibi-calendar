'use client'

/**
 * 改定額を決める4つの調整（docs/wage-system.md 第5〜8節）。
 * いずれも `lib/jp-wage.ts` から生成する（画面と計算のズレを作らない）。
 */

import {
  HYOGO_PITCH, ageTableForDisplay,
  SPECIAL_REASONS, SPECIAL_CAP, GRADE_LABELS,
} from '@/lib/jp-wage'

const GRADE_COLS = ['1G', '2G', '3G', '4G', '5G', '6G'] as const
const signed = (v: number) => (v > 0 ? '+' : '') + v

function Card({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-bold mb-1">{title}</h3>
      <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">{note}</p>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

const th = 'px-2.5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
const td = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'

export default function AdjustmentTables() {
  return (
    <div className="space-y-4">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">改定額の決まり方</div>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
          合計ピッチ ＝ <b>昇給評価</b> ＋ <b>年齢調整</b> ＋ <b>特別調整</b><br />
          新しい号 ＝ 現在の号 ＋ 合計ピッチ（60号が上限）。<b>合計がマイナスでも 0 まで</b>で、降給は行いません。
        </p>
      </div>

      <Card title="① 昇給評価" note="5段階。基本は A。S以上・B以下は理由の記録が必須。S を1人出したら B を1人、SS を1人出したら C を1人（ペアで出す）。">
        <table className="text-sm">
          <thead><tr>
            <th className={`${th} text-left`}>評語</th>
            {(['SS', 'S', 'A', 'B', 'C'] as const).map(h => <th key={h} className={`${th} text-right`}>{h}</th>)}
          </tr></thead>
          <tbody><tr>
            <td className="px-2.5 py-1.5 text-gray-500">ピッチ</td>
            {(['SS', 'S', 'A', 'B', 'C'] as const).map(h => (
              <td key={h} className={`${td} ${h === 'A' ? 'font-bold' : ''}`}>{HYOGO_PITCH[h]}{h === 'A' && <span className="text-[10px] text-gray-400 ml-1">標準</span>}</td>
            ))}
          </tr></tbody>
        </table>
      </Card>

      <Card title="② 年齢調整" note="若いうちは厚く、年齢が上がると薄くする。下位等級ほど幅が大きい。基準日（10月1日）時点の満年齢で判定する。">
        <table className="text-sm">
          <thead><tr>
            <th className={`${th} text-left`}>年齢</th>
            {GRADE_COLS.map(g => <th key={g} className={`${th} text-right`}>{g}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {ageTableForDisplay().map(r => (
              <tr key={r.band}>
                <td className="px-2.5 py-1.5 whitespace-nowrap">{r.band}</td>
                {r.pitches.map((p, i) => (
                  <td key={i} className={`${td} ${p < 0 ? 'text-red-600 dark:text-red-400' : p > 0 ? 'text-green-700 dark:text-green-400' : 'text-gray-400'}`}>{signed(p)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="③ 特別調整" note={`該当する事由を足し合わせる。合計は ±${SPECIAL_CAP} が上限。`}>
        <table className="text-sm w-full">
          <thead><tr>
            <th className={`${th} text-left`}>事由</th><th className={`${th} text-right`}>ピッチ</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {SPECIAL_REASONS.map(r => (
              <tr key={r.key}>
                <td className="px-2.5 py-1.5">{r.label}</td>
                <td className={`${td} ${r.pitch < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{signed(r.pitch)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <section className="bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-bold mb-1">業績（利益）はここには入りません</h3>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          以前は「利益調整」として号数に反映していましたが、2026年8月に撤廃しました。
          賞与が「原資を業績で決め、等級×評語の点数で配分する」方式のため二重連動になること、
          また号は一度上げると定年まで残るため、単年の業績を恒久的な賃金に変えてしまうことが理由です。
          業績連動は賞与に一本化しています。
        </p>
      </section>

      <p className="text-[11px] text-gray-400">
        等級の呼称：{Object.entries(GRADE_LABELS).map(([g, l]) => `${g === 'doko' ? '土工' : g}=${l}`).join(' ／ ')}
      </p>
    </div>
  )
}
