'use client'
// 2026-10-03: 画面の型（PageHeader・カード・下線タブ）にそろえた

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
import { PageHeader, ToolButton, UnderlineTabs } from '@/components/ui/PageParts'
import { useRouter, useSearchParams } from 'next/navigation'
import { GRADE_LABELS } from '@/lib/jp-wage'
import { isAlreadyRetired } from '@/lib/workers'
import GradeTable from './components/GradeTable'
import AdjustmentTables from './components/AdjustmentTables'
import BonusTable from './components/BonusTable'
import PromotionPanel from './components/PromotionPanel'
import RevisionPanel from './components/RevisionPanel'

type Tab = 'table' | 'rules' | 'revision' | 'promotion' | 'bonus' | 'docs'

const TABS: { key: Tab; label: string; note: string }[] = [
  { key: 'table', label: '号俸表', note: '等級と号ごとの日額' },
  { key: 'rules', label: '調整の基準', note: '評価・年齢・特別' },
  { key: 'revision', label: '年次改定', note: '毎年10月1日' },
  { key: 'promotion', label: '昇格', note: '役割が変わったとき' },
  { key: 'bonus', label: '賞与', note: '原資を点数比で配分' },
  { key: 'docs', label: '資料', note: '規程と関連ドキュメント' },
]

const RELATED = [
  { href: '/workers', label: '人員マスタ', note: '等級・号数・生年月日の登録' },
  { href: '/evaluation', label: '評価管理', note: '外国人スタッフの評価（別制度）' },
  { href: '/wage-analysis', label: '賃金分析', note: 'ベトナム人スタッフの賃金カーブ（代表のみ）' },
  { href: '/docs', label: '資料一覧', note: '全ドキュメント' },
]

const ALLOWED_VIEWERS = [0, 1]   // 代表・事業責任者（RevisionPanel と同一基準）

function WageHub() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'table'
  const [placed, setPlaced] = useState<{ name: string; grade: string; step: number }[]>([])
  // 等級が未設定の日本人社員。放置すると年次改定が確定できないので、どのタブでも出す
  const [unset, setUnset] = useState<{ id: number; name: string }[]>([])
  // 2026-08-27 追加（給与総点検）: ページ全体の閲覧ガード。改定タブだけでなく
  //   昇格・賞与タブにも個人の日額・賞与額が出るため、ハブごと代表・事業責任者に限定する
  //   （APIはサーバ側 requireExecutiveAuth でも強制済み。これはUXのための早期表示制御）
  const [allowed, setAllowed] = useState<boolean | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const wid = raw ? JSON.parse(raw)?.user?.workerId : undefined
      // workerId 0（代表）は falsy なので includes で判定
      setAllowed(typeof wid === 'number' && ALLOWED_VIEWERS.includes(wid))
    } catch { setAllowed(false) }
  }, [])

  // 号俸表に「誰がどこにいるか」を重ねる。制度の話と実際の配置が別画面だと結びつかない
  useEffect(() => {
    if (allowed !== true) return
    try {
      const raw = localStorage.getItem('hibi_auth')
      const pw = raw ? JSON.parse(raw)?.password : ''
      if (!pw) return
      fetch('/api/workers', { headers: { 'x-admin-password': pw } })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j?.workers) return
          const ws = j.workers as Record<string, unknown>[]
          setPlaced(ws
            // 退職の判定は「今日の時点で退職日を過ぎたか」（lib/workers.ts isAlreadyRetired・2026-10-02 総合点検）。旧: `!w.retired` で退職「予定」の在籍者まで外れていた
            .filter(w => !isAlreadyRetired(w.retired as string | undefined) && w.jpGrade && w.jpStep)
            .map(w => ({ name: String(w.name), grade: String(w.jpGrade), step: Number(w.jpStep) })))
          setUnset(ws
            .filter(w => !isAlreadyRetired(w.retired as string | undefined) && (!w.visaType || w.visaType === 'none'))
            .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
            .filter(w => !w.jpGrade || !w.jpStep)
            .map(w => ({ id: Number(w.id), name: String(w.name) })))
        })
        .catch(() => {})
    } catch { /* 配置が出せなくても表は見られるので握りつぶす */ }
  }, [allowed])

  const go = (t: Tab) => router.replace(`/wage?tab=${t}`, { scroll: false })

  if (allowed === null) return <div className="p-8 text-center text-gray-400">読み込み中...</div>
  if (!allowed) {
    return (
      <div className="max-w-lg mx-auto p-8 text-center space-y-2">
        <p className="font-bold">このページは代表・事業責任者のみ閲覧できます</p>
        <p className="text-sm text-gray-500">賃金制度の内容（等級・日額・賞与）は機密情報のため、閲覧を制限しています。</p>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="賃金・評価"
        title="賃金制度（日本人社員）"
        sub="等級は役割を表します。在籍年数で自動的に上がるものではなく、役割が変わったときに変わります。外国人スタッフは時給制の別制度です"
        actions={
          <>
            <ToolButton icon="users" onClick={() => router.push('/workers')} title="等級・号数・生年月日の登録">人員マスタ</ToolButton>
            <ToolButton icon="star" onClick={() => router.push('/evaluation')} title="外国人スタッフの評価（別制度）">評価管理</ToolButton>
          </>
        }
      />

      {unset.length > 0 && (
        <section className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-5 py-4">
          <h2 className="text-sm font-bold text-amber-800 dark:text-amber-300 mb-1">
            等級・号数が未設定 {unset.length}名
          </h2>
          <p className="text-xs text-gray-600 dark:text-gray-300 mb-2 leading-relaxed">
            未設定のままだと年次改定で「要入力」になり、<b>改定を確定できません</b>。
            人員マスタの編集画面で、等級（役割）を選んでください。日額に見合う号は自動で当たります。
          </p>
          <div className="flex flex-wrap gap-2">
            {unset.map(w => (
              <a key={w.id} href={`/workers?edit=${w.id}`}
                className="text-xs px-2.5 py-1 rounded-lg bg-white text-amber-800 border border-amber-300 hover:bg-amber-100 dark:bg-gray-800 dark:text-amber-300 dark:border-amber-800 transition">
                {w.name}
              </a>
            ))}
          </div>
        </section>
      )}

      <div>
        <UnderlineTabs tabs={TABS.map(t => ({ key: t.key, label: t.label }))} active={tab} onChange={go} label="賃金制度のタブ" />
        {/* 旧タブに添えていた一言（例: 年次改定＝毎年10月1日）は、選んでいるタブの分だけ下に出す */}
        <p className="text-xs text-hibi-sub dark:text-gray-400 mt-2">{TABS.find(t => t.key === tab)?.note}</p>
      </div>

      {tab === 'table' && <GradeTable placed={placed} />}
      {tab === 'rules' && <AdjustmentTables />}
      {tab === 'promotion' && <PromotionPanel />}
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
              <div><code className="text-2xs">docs/wage-system.md</code> — 賃金制度（日本人社員）</div>
              <div><code className="text-2xs">lib/jp-wage.ts</code> — 号俸表と改定の計算</div>
              <div><code className="text-2xs">lib/jp-wage-migration.ts</code> — 2026年度の移行データ</div>
            </div>
          </section>

          <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-sm font-bold mb-3">関連する画面</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {RELATED.map(r => (
                <a key={r.href} href={r.href}
                  className="block rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
                  <div className="text-sm font-medium">{r.label}</div>
                  <div className="text-2xs text-gray-500">{r.note}</div>
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
            <p className="text-2xs text-gray-400 mt-3 leading-relaxed">
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
