'use client'

import { useState, useEffect } from 'react'
import { AuthUser } from '@/types'

// ── アコーディオンセクション ──
function Section({ title, icon, children, defaultOpen }: {
  title: string; icon: string; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen || false)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
      >
        <span className="text-xl">{icon}</span>
        <span className="flex-1 font-bold text-hibi-navy dark:text-white">{title}</span>
        <span className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      {open && <div className="px-5 pb-5 border-t dark:border-gray-700">{children}</div>}
    </div>
  )
}

// ── テーブルヘルパー ──
function T({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-700">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b dark:border-gray-600">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b dark:border-gray-700">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-gray-700 dark:text-gray-300">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── メインページ ──
export default function GuidePage() {
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try { setUser(JSON.parse(stored).user) } catch { /* ignore */ }
    }
  }, [])

  const isAdmin = user?.role === 'admin' || user?.role === 'approver' || user?.role === 'jimu'

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="mb-2">
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">運用ガイド</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">変形労働時間制の制度設計とシステム運用の手引き</p>
      </div>

      {/* 月次チェックリストはダッシュボードに移動 */}
      {isAdmin && (
        <a href="/dashboard" className="block bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition">
          <p className="text-sm text-blue-700 dark:text-blue-400 font-medium">
            月次チェックリストはダッシュボードに表示されています →
          </p>
        </a>
      )}

      {/* ── セクション 1: 制度概要 ── */}
      <Section title="変形労働時間制とは" icon="&#128214;" defaultOpen>
        <div className="space-y-3 mt-3 text-sm text-gray-700 dark:text-gray-300">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <p className="font-bold text-red-600 dark:text-red-400 mb-1">通常の労働時間制</p>
              <p>1日8時間・週40時間を超えたら即残業</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
              <p className="font-bold text-blue-600 dark:text-blue-400 mb-1">変形労働時間制（1ヶ月単位）</p>
              <p>月の合計で法定上限以内なら、1日8時間を超えても残業にならない</p>
            </div>
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            忙しい週と暇な週を平均化できる制度。カレンダーで出勤/休日を事前に決めるため、
            <span className="font-bold text-hibi-navy dark:text-blue-300">会社都合の休業（0.6補償）が発生しなくなる</span>のが最大のメリット。
          </p>
        </div>
      </Section>

      {/* ── セクション 2: 勤務スケジュール ── */}
      <Section title="1日の勤務スケジュール" icon="&#9200;">
        <div className="mt-3 space-y-3">
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
            <div className="space-y-2 text-sm font-mono">
              <div className="flex items-center gap-3">
                <span className="w-14 text-right text-gray-500">8:00</span>
                <div className="flex-1 bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 rounded px-3 py-1 font-bold">始業</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-right text-gray-500">10:00</span>
                <div className="flex-1 bg-yellow-100 dark:bg-yellow-800/50 text-yellow-700 dark:text-yellow-200 rounded px-3 py-1">休憩 30分</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-right text-gray-500">12:00</span>
                <div className="flex-1 bg-yellow-100 dark:bg-yellow-800/50 text-yellow-700 dark:text-yellow-200 rounded px-3 py-1">昼休み 60分</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-right text-gray-500">15:00</span>
                <div className="flex-1 bg-yellow-100 dark:bg-yellow-800/50 text-yellow-700 dark:text-yellow-200 rounded px-3 py-1">休憩 30分</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-right text-gray-500">17:00</span>
                <div className="flex-1 bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 rounded px-3 py-1 font-bold">終業</div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">拘束時間</p>
              <p className="font-bold text-lg">9時間</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">休憩合計</p>
              <p className="font-bold text-lg">120分</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
              <p className="text-xs text-gray-500">所定労働</p>
              <p className="font-bold text-lg text-blue-600 dark:text-blue-400">7時間</p>
            </div>
          </div>
        </div>
      </Section>

      {/* ── セクション 3: 法定上限 ── */}
      <Section title="法定上限と所定日数" icon="&#128200;">
        <div className="mt-3 space-y-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            計算式：暦日数 &times; 40h &divide; 7 = 法定上限時間
          </p>
          <T
            headers={['月の暦日数', '法定上限時間', '7hでの最大所定日数']}
            rows={[
              ['28日', '160.0h', '22日'],
              ['29日', '165.7h', '23日'],
              ['30日', '171.4h', '24日'],
              ['31日', '177.1h', '25日'],
            ]}
          />
          <p className="text-xs text-gray-400">
            システムがカレンダー作成時にこの上限を自動チェックし、超過していれば警告を出します。
          </p>
        </div>
      </Section>

      {/* ── セクション 4: 運用サイクル ── */}
      <Section title="毎月の運用サイクル" icon="&#128260;">
        <div className="mt-3 space-y-0">
          {[
            { step: '1', label: '元請からカレンダー入手', when: '20日頃', icon: '\uD83D\uDCE5' },
            { step: '2', label: '職長がシステムに入力', when: '〜25日', icon: '\u270F\uFE0F', detail: '出勤日/休日/祝日を設定。法定上限チェック（自動）' },
            { step: '3', label: '社長（政仁さん）が承認', when: '〜月末', icon: '\u2705', detail: '所定日数・所定時間が確定' },
            { step: '4', label: 'Messengerでリンク送信', when: '承認後', icon: '\uD83D\uDCE8', detail: 'スタッフがカレンダーを確認・署名。署名後ロック' },
            { step: '5', label: 'カレンダー通りに勤務開始', when: '翌月1日〜', icon: '\uD83D\uDC77' },
          ].map((s, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-hibi-navy text-white flex items-center justify-center text-sm font-bold">
                  {s.step}
                </div>
                {i < 4 && <div className="w-0.5 h-full bg-gray-200 dark:bg-gray-600 my-1" />}
              </div>
              <div className="pb-4 flex-1">
                <div className="flex items-center gap-2">
                  <span>{s.icon}</span>
                  <span className="font-medium text-sm text-gray-800 dark:text-gray-200">{s.label}</span>
                  <span className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-400">{s.when}</span>
                </div>
                {s.detail && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">{s.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── セクション 5: 給与計算 ── */}
      <Section title="給与計算" icon="&#128176;">
        <div className="mt-3 space-y-4">
          {/* 月給制 */}
          <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50/30 dark:bg-blue-900/10">
            <h4 className="font-bold text-blue-700 dark:text-blue-400 mb-3">月給制スタッフ（ベトナム人）</h4>
            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded-lg p-3">
              <p><span className="text-gray-400">(1)</span> 基本給 = <span className="font-bold">月給（固定）</span></p>
              <p><span className="text-gray-400">(2)</span> 欠勤控除 = 月給 &divide; 所定日数 &times; 欠勤日数</p>
              <p><span className="text-gray-400">(3)</span> 残業手当 = (月給 &divide; 所定時間) &times; 1.25 &times; 残業h</p>
              <p className="pt-1 border-t dark:border-gray-700"><span className="text-gray-400">(4)</span> <span className="font-bold text-blue-600 dark:text-blue-400">支給額 = (1) - (2) + (3)</span></p>
            </div>
            <div className="mt-3">
              <p className="text-xs font-bold text-gray-500 mb-1">計算例：フウさん（月給360,900円 / 所定24日）</p>
              <T
                headers={['項目', '計算', '金額']}
                rows={[
                  ['基本給', '月給', '360,900円'],
                  ['時間単価', '360,900 \u00f7 168h', '2,148円/h'],
                  ['欠勤控除', 'なし（0日）', '0円'],
                  ['残業手当', '2,148 \u00d7 1.25 \u00d7 36h', '96,660円'],
                  ['支給額', '', '457,560円'],
                ]}
              />
            </div>
          </div>

          {/* 日給月給制 */}
          <div className="border border-green-200 dark:border-green-800 rounded-lg p-4 bg-green-50/30 dark:bg-green-900/10">
            <h4 className="font-bold text-green-700 dark:text-green-400 mb-3">日給月給制スタッフ（日本人）</h4>
            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded-lg p-3">
              <p><span className="text-gray-400">(1)</span> 基本給 = <span className="font-bold">日額 &times; 実出勤日数</span></p>
              <p><span className="text-gray-400">(2)</span> 残業手当 = (日額 &divide; 8h) &times; 1.25 &times; 残業h</p>
              <p className="pt-1 border-t dark:border-gray-700"><span className="text-gray-400">(3)</span> <span className="font-bold text-green-600 dark:text-green-400">支給額 = (1) + (2)</span></p>
            </div>
            <div className="mt-3">
              <p className="text-xs font-bold text-gray-500 mb-1">計算例：大川さん（日額23,000円 / 24日出勤）</p>
              <T
                headers={['項目', '計算', '金額']}
                rows={[
                  ['基本給', '23,000 \u00d7 24日', '552,000円'],
                  ['時間単価', '23,000 \u00f7 8h', '2,875円/h'],
                  ['残業手当', '2,875 \u00d7 1.25 \u00d7 10h', '35,938円'],
                  ['支給額', '', '587,938円'],
                ]}
              />
            </div>
          </div>
        </div>
      </Section>

      {/* ── セクション 6: 休業補償 ── */}
      <Section title="休業補償が不要になる仕組み" icon="&#128161;">
        <div className="mt-3 space-y-3">
          <T
            headers={['状況', '旧制度（週6日契約）', '変形労働時間制']}
            rows={[
              ['土曜が現場休み', '会社都合で休ませた → 0.6補償発生', 'カレンダーで「休日」設定済 → 補償不要'],
              ['土曜が出勤', '通常出勤', 'カレンダーで「出勤」設定済 → 通常の給与'],
            ]}
          />
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
            <p className="text-sm font-bold text-green-700 dark:text-green-400">
              どちらのケースでも0.6補償は発生しません。
            </p>
          </div>
          <div className="text-sm">
            <p className="font-bold text-gray-600 dark:text-gray-400 mb-2">残業比較（4月の例）</p>
            <T
              headers={['', '旧制度（週5日・6h40m）', '変形労働（24日・7h）']}
              rows={[
                ['所定時間', '146.7h', '168h'],
                ['土曜出勤2日', '13.3h（全額残業）', '0h（所定内）'],
                ['日々の残業', '36h', '36h'],
                ['残業合計', '49.3h', '36h'],
              ]}
            />
            <p className="text-xs text-gray-500 mt-2">
              残業が <span className="font-bold text-green-600">13.3時間/月</span> 削減。
            </p>
          </div>
        </div>
      </Section>

      {/* ── セクション 7: システム管理フロー ── */}
      <Section title="システムでの管理フロー" icon="&#128187;">
        <div className="mt-3 space-y-3">
          {[
            {
              num: '1', title: '就業カレンダー画面', color: 'blue',
              items: ['職長が翌月の出勤日/休日を設定', '法定上限チェック（自動）', '所定日数・所定時間が自動計算', '提出 → 承認 → スタッフ署名'],
            },
            {
              num: '2', title: '出面入力画面', color: 'green',
              items: ['日々の出勤・残業を記録', 'カレンダーの所定日以外の出勤は「休日出勤」として自動判定'],
            },
            {
              num: '3', title: '月次集計画面', color: 'purple',
              items: ['所定日数（カレンダーから自動取得）', '実出勤日数・残業時間・欠勤日数', '残業時間 = 実労働時間 − 所定時間', '給与自動計算（月給制 / 日給月給制）'],
            },
          ].map((s, i) => (
            <div key={i} className={`border-l-4 ${
              s.color === 'blue' ? 'border-blue-500' : s.color === 'green' ? 'border-green-500' : 'border-purple-500'
            } bg-gray-50 dark:bg-gray-700/30 rounded-r-lg p-3`}>
              <p className="font-bold text-sm text-gray-800 dark:text-gray-200 mb-1">
                <span className="text-gray-400 mr-1">{s.num}.</span>{s.title}
              </p>
              <ul className="list-disc ml-5 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                {s.items.map((item, j) => <li key={j}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      {/* ── セクション 8: 導入手続き ── */}
      <Section title="導入に必要な手続き" icon="&#128221;">
        <div className="mt-3 space-y-2">
          {[
            { label: '労使協定の締結', detail: '対象者、変形期間（1ヶ月）、所定労働時間の決定方法（就業カレンダーによる）' },
            { label: '就業規則の変更', detail: '所定労働 6h40m→7h、休憩 140分→120分、変形労働時間制の規定追加' },
            { label: '雇用契約書の更新', detail: '上記変更を反映、各スタッフの署名取得' },
            { label: '労基署への届出', detail: '変形労働時間制の労使協定届 + 就業規則変更届' },
            { label: '技能実習機構への届出', detail: '実習計画の変更届（技能実習生がいる場合）' },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
              <span className="w-6 h-6 rounded-full bg-hibi-navy text-white text-xs flex items-center justify-center font-bold mt-0.5">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── セクション 9: 外国人管理 ── */}
      <Section title="外国人スタッフの管理項目" icon="&#127468;">
        <div className="mt-3">
          <T
            headers={['管理項目', '内容']}
            rows={[
              ['在留資格', '実習1号/2号/3号、特定1号/2号'],
              ['在留期限', '日付管理 + 自動アラート（180日/90日/30日/期限切れ）'],
              ['スタッフ画面', '日本語 + ベトナム語の二言語表示'],
              ['署名', 'トークン認証、タイムスタンプ + IPハッシュ記録'],
              ['有給休暇', '勤続年数に応じた法定付与日数を自動計算'],
              ['レポート', '監理団体（エムテック）向けExcel出力'],
            ]}
          />
        </div>
      </Section>
    </div>
  )
}
