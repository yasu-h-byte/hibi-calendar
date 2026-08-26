'use client'

/**
 * 賃金制度（日本人社員）のハブ。
 *
 * 号俸表・調整の基準・年次改定・関連資料をひとつにまとめる。改定の数字が
 * 「どの表から出ているか」をその場で辿れるようにするのが狙い。
 *
 * 表は docs から写さず `lib/jp-wage.ts` から生成する。写すと、ピッチを変えたときに
 * 画面と計算がズレる。
 */

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { GRADE_LABELS } from '@/lib/jp-wage'
import GradeTable from './components/GradeTable'
import AdjustmentTables from './components/AdjustmentTables'
import BonusTable from './components/BonusTable'
import RevisionPanel from './components/RevisionPanel'

type Tab = 'table' | 'rules' | 'bonus' | 'revision' | 'docs'

const TABS: { key: Tab; label: string; note: string }[] = [
  { key: 'table', label: '号俸表', note: '等級と号ごとの日額' },
  { key: 'rules', label: '調整の基準', note: '評価・年齢・利益・特別' },
  { key: 'bonus', label: '賞与', note: '原資を点数比で配分' },
  { key: 'revision', label: '年次改定', note: '毎年10月1日' },
  { key: 'docs', label: '資料', note: '規程と関連ドキュメント' },
]

const RELATED = [
  { href: '/workers', label: '人員マスタ', note: '等級・号数・生年月日の登録' },
  { href: '/evaluation', label: '評価管理', note: '外国人スタッフの評価（別制度）' },
  { href: '/wage-analysis', label: '賃金分析', note: 'ベトナム人スタッフの賃金カーブ（代表のみ）' },
  { href: '/docs', label: '資料一覧', note: '全ドキュメント' },
]

function WageHub() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'table'
  const [placed, setPlaced] = useState<{ name: string; grade: string; step: number }[]>([])

  // 号俸表に「誰がどこにいるか」を重ねる。制度の話と実際の配置が別画面だと結びつかない
  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const pw = raw ? JSON.parse(raw)?.password : ''
      if (!pw) return
      fetch('/api/workers', { headers: { 'x-admin-password': pw } })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j?.workers) return
          setPlaced((j.workers as Record<string, unknown>[])
            .filter(w => !w.retired && w.jpGrade && w.jpStep)
            .map(w => ({ name: String(w.name), grade: String(w.jpGrade), step: Number(w.jpStep) })))
        })
        .catch(() => {})
    } catch { /* 配置が出せなくても表は見られるので握りつぶす */ }
  }, [])

  const go = (t: Tab) => router.replace(`/wage?tab=${t}`, { scroll: false })

  return (
    <div className="max-w-[1180px] mx-auto p-4 sm:p-6 space-y-5">
      <header>
        <h1 className="text-xl font-bold mb-1">賃金制度（日本人社員）</h1>
        <p className="text-sm text-gray-500">
          等級は<b>役割</b>を表します。在籍年数で自動的に上がるものではなく、役割が変わったときに変わります。
          外国人スタッフは時給制の別制度です。
        </p>
      </header>

      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-700 pb-px">
        {TABS.map(t => (
          <button key={t.key} onClick={() => go(t.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition ${
              tab === t.key
                ? 'border-hibi-navy text-hibi-navy dark:border-blue-400 dark:text-blue-300 bg-white dark:bg-gray-800'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}>
            {t.label}
            <span className="hidden sm:inline text-[10px] text-gray-400 ml-2">{t.note}</span>
          </button>
        ))}
      </div>

      {tab === 'table' && <GradeTable placed={placed} />}
      {tab === 'rules' && <AdjustmentTables />}
      {tab === 'bonus' && <BonusTable />}
      {tab === 'revision' && <RevisionPanel />}
      {tab === 'docs' && (
        <div className="space-y-4">
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-sm font-bold mb-1">規程</h3>
            <p className="text-xs text-gray-500 mb-3">
              制度の原本。等級の定義、昇格の要件、号俸表の作り方、改定の計算順序、移行の経緯まで。
            </p>
            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
              <div><code className="text-[11px]">docs/wage-system.md</code> — 賃金制度（日本人社員）</div>
              <div><code className="text-[11px]">lib/jp-wage.ts</code> — 号俸表と改定の計算</div>
              <div><code className="text-[11px]">lib/jp-wage-migration.ts</code> — 2026年度の移行データ</div>
            </div>
          </section>

          <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-sm font-bold mb-3">関連する画面</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {RELATED.map(r => (
                <a key={r.href} href={r.href}
                  className="block rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
                  <div className="text-sm font-medium">{r.label}</div>
                  <div className="text-[11px] text-gray-500">{r.note}</div>
                </a>
              ))}
            </div>
          </section>

          <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-sm font-bold mb-2">等級の呼称</h3>
            <div className="grid gap-1 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2">
              {Object.entries(GRADE_LABELS).map(([g, l]) => (
                <div key={g}><b className="tabular-nums">{g === 'doko' ? '土工' : g}</b> — {l}</div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
              壁は 4G と 5G の間にあります。3G 班長 → 4G 上級班長は熟練で上がれますが、
              4G → 5G 職長は「職長という役職で現場を任されたとき」が基準で、在籍年数では超えられません。
            </p>
          </section>
        </div>
      )}
    </div>
  )
}

export default function WagePage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">読み込み中…</div>}>
      <WageHub />
    </Suspense>
  )
}
