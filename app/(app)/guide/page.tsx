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
              <p>月の合計で法定上限以内なら、特定の日や週が8時間・40時間を超えてもOK</p>
            </div>
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            忙しい週と暇な週を平均化できる制度。カレンダーで出勤/休日を事前に決めるため、
            <span className="font-bold text-hibi-navy dark:text-blue-300">会社都合の休業（0.6補償）が発生しなくなる</span>のが最大のメリット。
          </p>
          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-3">
            <p className="font-bold text-orange-700 dark:text-orange-400 mb-1">残業の判定（3段階）</p>
            <p>変形労働時間制では、残業かどうかを<span className="font-bold">日→週→月の3段階</span>で判定します。</p>
            <div className="mt-2 space-y-1 text-xs">
              <p><span className="font-bold text-red-600">第1段階（日単位）:</span> 所定8h以下の日は<span className="font-bold">8hを超えた分</span>。所定8h超の日はその所定を超えた分</p>
              <p><span className="font-bold text-yellow-700">第2段階（週単位）:</span> 所定40h以下の週は<span className="font-bold">40hを超えた分</span>（第1段階分を除く）</p>
              <p><span className="font-bold text-blue-600">第3段階（月単位）:</span> <span className="font-bold">法定上限（暦日数&times;40&divide;7）を超えた分</span>（第1・2段階分を除く）</p>
            </div>
            <p className="text-xs text-orange-600 dark:text-orange-400 mt-2 font-bold">
              この3段階判定はシステムが自動計算し、出面Excelの「勤怠サマリー」シートに出力されます。
            </p>
          </div>
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
            { step: '1', label: '元請から次月工程表を入手', when: '20日頃', icon: '\uD83D\uDCE5' },
            { step: '2', label: '管理者がシステムに入力', when: '〜25日', icon: '\u270F\uFE0F', detail: '就業カレンダー画面で現場ごとに出勤日/休みを設定（青=出勤、グレー=休み）' },
            { step: '3', label: '事業責任者が承認', when: '〜月末', icon: '\u2705', detail: '所定日数・所定時間が確定。法定上限チェック（自動）' },
            { step: '4', label: 'Messengerでリンク送信', when: '承認後', icon: '\uD83D\uDCE8', detail: 'スタッフがスマホでカレンダーを確認し、全現場一括で署名' },
            { step: '5', label: 'カレンダー通りに勤務開始', when: '翌月1日〜', icon: '\uD83D\uDC77', detail: 'スタッフは毎日スマホで開始/終了時刻・休憩を入力して出勤登録（5月〜新形式）' },
            { step: '6', label: '月次集計・月締め', when: '翌月5日頃', icon: '\uD83D\uDCCA', detail: '出面データから給与を自動計算。月締めで確定。出面Excelの「勤怠サマリー」シートに3段階残業判定の結果が自動出力される（HFU→キャシュモ、日比建設→社内で給与計算に使用）' },
          ].map((s, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-hibi-navy text-white flex items-center justify-center text-sm font-bold">
                  {s.step}
                </div>
                {i < 5 && <div className="w-0.5 h-full bg-gray-200 dark:bg-gray-600 my-1" />}
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
          {/* 3層構造（外国人） */}
          <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50/30 dark:bg-blue-900/10">
            <h4 className="font-bold text-blue-700 dark:text-blue-400 mb-3">3層構造（ベトナム人スタッフ）— 2026年5月〜</h4>

            {/* 3層のビジュアル */}
            <div className="space-y-1 mb-3">
              <div className="bg-green-100 dark:bg-green-800/30 border border-green-300 dark:border-green-700 rounded-lg px-3 py-2 text-sm">
                <span className="font-bold text-green-700 dark:text-green-400">① 基本給（固定）</span>
                <span className="text-gray-600 dark:text-gray-400 ml-2">= 時給 &times; 20日 &times; 7h — 毎月同額</span>
              </div>
              <div className="bg-blue-100 dark:bg-blue-800/30 border border-blue-300 dark:border-blue-700 rounded-lg px-3 py-2 text-sm">
                <span className="font-bold text-blue-700 dark:text-blue-400">② 追加所定手当</span>
                <span className="text-gray-600 dark:text-gray-400 ml-2">= 時給 &times; (出勤日数 − 20日) &times; 7h — 割増なし</span>
              </div>
              <div className="bg-yellow-100 dark:bg-yellow-800/30 border border-yellow-300 dark:border-yellow-700 rounded-lg px-3 py-2 text-sm">
                <span className="font-bold text-yellow-700 dark:text-yellow-400">③ 残業手当</span>
                <span className="text-gray-600 dark:text-gray-400 ml-2">= 時給 &times; 1.25 &times; 法定超過時間</span>
              </div>
            </div>

            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded-lg p-3">
              <p><span className="text-gray-400">(1)</span> 基本給 = <span className="font-bold">時給 &times; ベース日数(20日) &times; 7h</span></p>
              <p><span className="text-gray-400">(2)</span> 追加所定手当 = 時給 &times; MAX(0, 実出勤日数 − 20日) &times; 7h</p>
              <p><span className="text-gray-400">(3)</span> 法定上限 = 暦日数 &times; 40 &divide; 7</p>
              <p><span className="text-gray-400">(4)</span> 法定外労働時間 = 3段階判定（日8h超 + 週40h超 + 月法定上限超）</p>
              <p><span className="text-gray-400">(5)</span> 残業手当 = 時給 &times; 1.25 &times; 法定外労働時間</p>
              <p><span className="text-gray-400">(6)</span> 欠勤控除 = 時給 &times; 7h &times; MAX(0, 20日 − 実出勤日数 − 有給日数)</p>
              <p className="pt-1 border-t dark:border-gray-700"><span className="text-gray-400">(7)</span> <span className="font-bold text-blue-600 dark:text-blue-400">支給額 = (1) − (6) + (2) + (5)</span></p>
            </div>

            <div className="mt-3 bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800 rounded-lg p-3">
              <p className="text-xs font-bold text-orange-700 dark:text-orange-400 mb-1">残業の3段階判定（例: ある日の残業2h）</p>
              <T
                headers={['区分', '時間', '割増', '説明']}
                rows={[
                  ['所定内', '7h (8:00-17:00)', 'なし', '基本給 or 追加所定手当に含まれる'],
                  ['法定内残業', '1h (17:00-18:00)', 'なし', '所定7h超だが1日8h以内 → 割増不要'],
                  ['法定外残業', '1h (18:00-19:00)', '×1.25', '1日8h超 → 25%割増'],
                ]}
              />
              <p className="text-xs text-gray-500 mt-1">※ 「残業2h」のうち割増がつくのは1hだけ。システムが自動計算します。</p>
            </div>

            <div className="mt-3">
              <p className="text-xs font-bold text-gray-500 mb-1">計算例：時給2,000円 / 31日月 / 24日出勤 / 出面の残業合計12h</p>
              <T
                headers={['項目', '計算', '金額']}
                rows={[
                  ['基本給（固定）', '2,000 \u00d7 20日 \u00d7 7h', '280,000円'],
                  ['追加所定手当', '2,000 \u00d7 (24日−20日) \u00d7 7h', '56,000円'],
                  ['法定上限', '31日 \u00d7 40 \u00f7 7', '177.1h'],
                  ['法定外労働時間', '3段階判定（システム自動計算）', '例: 7.3h'],
                  ['残業手当', '2,000 \u00d7 1.25 \u00d7 7.3h', '18,250円'],
                  ['欠勤控除', 'MAX(0, 20−24−0) = 0日', '0円'],
                  ['支給額', '280,000 + 56,000 + 18,250', '354,250円'],
                ]}
              />
              <p className="text-xs text-gray-400 mt-1">※ 法定外労働時間はシステムが日次・週次・月次で自動判定します。出面Excelの「勤怠サマリー」に内訳が記載されます。</p>
            </div>

            <div className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
              <p>※ 実出勤日数に有給（P）は含めない</p>
              <p>※ ベース日数（20日）は管理者設定で変更可能</p>
              <p>※ 法定外労働時間 = 日8h超 + 週40h超 + 月法定上限超（3段階判定をシステムが自動計算）</p>
              <p>※ 法定休日（日曜）の労働は別枠（&times;1.35）で集計</p>
              <p>※ 給与計算の分担: HFU → キャシュモ / 日比建設 → 社内</p>
            </div>
          </div>

          {/* 日給月給制（日本人） */}
          <div className="border border-green-200 dark:border-green-800 rounded-lg p-4 bg-green-50/30 dark:bg-green-900/10">
            <h4 className="font-bold text-green-700 dark:text-green-400 mb-3">日給月給制スタッフ（日本人）— 変更なし</h4>
            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded-lg p-3">
              <p><span className="text-gray-400">(1)</span> 基本給 = <span className="font-bold">日額 &times; 実出勤日数</span></p>
              <p><span className="text-gray-400">(2)</span> 残業手当 = (日額 &divide; 8h) &times; 1.25 &times; 残業h</p>
              <p className="pt-1 border-t dark:border-gray-700"><span className="text-gray-400">(3)</span> <span className="font-bold text-green-600 dark:text-green-400">支給額 = (1) + (2)</span></p>
            </div>
            <p className="text-xs text-gray-400 mt-2">※ 日本人スタッフの残業単価は日額÷8時間で計算します</p>
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
        </div>
      </Section>

      {/* ── セクション 7: 出面入力 ── */}
      <Section title="出面入力の使い方" icon="&#128221;">
        <div className="mt-3 space-y-4">
          {/* PC画面 */}
          <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50/30 dark:bg-blue-900/10">
            <h4 className="font-bold text-blue-700 dark:text-blue-400 mb-2">PC画面（管理者向け）</h4>
            <div className="bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-2">
              <p className="text-xs font-bold text-orange-700 dark:text-orange-400 mb-1">5月〜 外国人スタッフの入力方式が変わります</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">外国人スタッフは時刻ベース入力（出/有/休/現 + 開始/終了時刻 + 休憩チェック2つ）に変更。日本人社員は従来形式のまま。</p>
            </div>
            <p className="text-xs font-bold text-gray-500 mb-1">日本人社員（従来形式）</p>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>入力値：<span className="font-bold">1</span>=出勤、<span className="font-bold">0.5</span>=半日、<span className="text-green-600 font-bold">補</span>=0.6補償、<span className="text-green-600 font-bold">有</span>=有給</li>
              <li>残業は各セルの下段に時間数を入力</li>
            </ul>
            <p className="text-xs font-bold text-gray-500 mt-2 mb-1">外国人スタッフ（5月〜時刻ベース）</p>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>セルに出勤区分（出/有/休/現）+ 開始時刻・終了時刻を入力</li>
              <li>休憩チェックボックス2つ：午前10:00-10:30 / 午後15:00-15:30（昼休み12:00-13:00は常に控除）</li>
            </ul>
            <p className="text-xs font-bold text-gray-500 mt-2 mb-1">共通</p>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>現場を選択し、月のグリッドで一括入力</li>
              <li>日比建設・HFU・外注がグループ別に表示</li>
              <li>配置編集ボタンでスタッフの配置変更が可能</li>
            </ul>
          </div>

          {/* スマホ画面 */}
          <div className="border border-green-200 dark:border-green-800 rounded-lg p-4 bg-green-50/30 dark:bg-green-900/10">
            <h4 className="font-bold text-green-700 dark:text-green-400 mb-2">スマホ画面（スタッフ向け）— 5月〜新形式</h4>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>トークンURLでアクセス（ログイン不要）</li>
              <li><span className="font-bold">出勤登録</span>：開始時刻（初期値8:00）・終了時刻（初期値17:00）を設定し、休憩チェックボックス2つ（午前10:00-10:30 / 午後15:00-15:30）を確認して登録。昼休み（12:00-13:00）は常に控除</li>
              <li>通常の日はそのまま「出勤登録」を押すだけ（実労働7時間）。残業日は終了時刻を変更</li>
              <li>実労働時間がリアルタイム表示される</li>
              <li><span className="font-bold">欠勤届</span>ボタンでカレンダーの出勤日に休む場合に理由を選択して提出（体調不良/通院/私用/家族の事情/帰国関連/その他）。カレンダーの休日は何もしなくてOK</li>
              <li><span className="font-bold">有給申請</span>ボタンで有給休暇を申請（残日数チェックあり）。5日先以降の日付のみ選択可能。開始日〜終了日の範囲指定で連続休暇を一括申請できる（日曜は自動除外）</li>
              <li>過去5日分の入力履歴を確認・修正可能</li>
              <li>日本語とベトナム語の二言語表示</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── セクション 8: 有給管理 ── */}
      <Section title="有給休暇の管理" icon="&#127796;">
        <div className="mt-3 space-y-4">
          <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
            <p>有給休暇は通知ベースで付与（管理者がワンクリックで確認・実行）し、申請→承認のワークフローで消化を管理します。
            常に最新の有給レコードが表示され、年度セレクタはありません。月別消化テーブルで取得状況を一覧できます。</p>
          </div>

          {/* 法定付与日数 */}
          <div>
            <p className="text-xs font-bold text-gray-500 mb-1">法定付与日数（労働基準法第39条）</p>
            <T
              headers={['勤続年数', '0.5年', '1.5年', '2.5年', '3.5年', '4.5年', '5.5年', '6.5年〜']}
              rows={[
                ['付与日数', '10日', '11日', '12日', '14日', '16日', '18日', '20日'],
              ]}
            />
          </div>

          {/* 運用フロー */}
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500">有給の運用フロー</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                <p className="font-bold text-blue-700 dark:text-blue-400 text-xs mb-1">付与（通知ベース）</p>
                <ul className="list-disc ml-4 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                  <li>入社日から6ヶ月後に初回付与、以降毎年</li>
                  <li>付与時期が来ると通知ベルにアラート表示</li>
                  <li>通知からワンクリックで付与を実行（手動確認）</li>
                  <li>前年の残日数を繰越（上限20日、出面Pデータ含む）</li>
                  <li>有効期限は付与日から2年間</li>
                </ul>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
                <p className="font-bold text-green-700 dark:text-green-400 text-xs mb-1">申請・消化</p>
                <ul className="list-disc ml-4 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                  <li>スタッフがスマホから有給申請（5日先以降の日付のみ選択可能）</li>
                  <li>連続休暇は開始日〜終了日の範囲指定で一括申請（日曜は自動除外）</li>
                  <li>残日数0の場合は申請不可</li>
                  <li>管理者がダッシュボード「勤怠申請」カードまたは有給申請画面で承認/却下</li>
                  <li>承認すると出面データに自動反映</li>
                </ul>
              </div>
            </div>
          </div>

          {/* 年5日義務 */}
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">年5日取得義務（2019年法改正）</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              年10日以上付与された労働者には、付与日から1年以内に5日以上取得させる義務があります。
              有効期限まで残り3ヶ月の時点で未達の場合、有給管理画面にアラートが表示されます。
            </p>
          </div>
        </div>
      </Section>

      {/* ── セクション 9: システム画面一覧 ── */}
      <Section title="システム画面一覧" icon="&#128187;">
        <div className="mt-3 space-y-3">
          {[
            {
              num: '1', title: 'ダッシュボード', color: 'blue',
              items: ['お知らせ（カレンダー準備・月締め状況など）', '勤怠申請カード（有給申請の承認・本日の欠勤届＋過去7日の欠勤を表示）', '本日の稼働状況（現場別配置）', '今月サマリー（人工数+売上）', '日別稼働人数チャート', '※ 原価・収益・KPIの詳細チャートは「原価・収益管理」に移動'],
            },
            {
              num: '2', title: '出面入力', color: 'green',
              items: ['現場ごとのグリッド入力（日比建設/HFU/外注）', '外国人スタッフ: 時刻ベース入力（出/有/休/現 + 開始/終了 + 休憩チェック2つ）— 5月〜', '日本人社員: 従来形式（1/0.5/有 + 残業時間）', '日付ヘッダー固定（スクロール時も表示）', '「終了現場を表示」チェックボックス', '配置編集（スタッフの現場割り当て）'],
            },
            {
              num: '3', title: '月次集計', color: 'purple',
              items: ['全スタッフの月間実績（出勤日数・残業・有給・欠勤）', '3層構造の給与自動計算（基本給固定/追加所定手当/残業手当/欠勤控除/支給額）', '日本人は従来の日給月給制で計算', '月締め機能でデータ確定'],
            },
            {
              num: '4', title: '就業カレンダー', color: 'blue',
              items: ['現場ごとに出勤日/休みを設定（青=出勤、グレー=休み。日曜・祝日は日付が赤文字）', '法定上限チェック（自動）', '確定 → スタッフ署名のワークフロー'],
            },
            {
              num: '5', title: '有給・休み管理', color: 'green',
              items: ['付与日数・繰越・消化の一覧（常に最新レコードを表示）', '年5日取得義務アラート', '月別消化テーブル', '通知ベルからワンクリック付与', '有給申請の承認/却下'],
            },
            {
              num: '6', title: '原価・収益管理', color: 'purple',
              items: ['現場ごとの売上・原価・利益率', '外注費を含む原価計算', 'KPI推移チャート・累積推移・前年同月比（ダッシュボードから移動）'],
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

      {/* ── セクション 10: 導入手続き ── */}
      <Section title="導入に必要な手続き" icon="&#128203;">
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

      {/* ── セクション 11: 出向・Excel出力・通知 ── */}
      <Section title="出向・Excel出力・通知ベル" icon="&#128276;">
        <div className="mt-3 space-y-4">
          {/* 出向 */}
          <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50/30 dark:bg-blue-900/10">
            <h4 className="font-bold text-blue-700 dark:text-blue-400 mb-2">出向（dispatch）機能</h4>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>人員マスタでスタッフに「出向先」と「開始月」を設定可能</li>
              <li>出向設定されたスタッフは、開始月以降の労務費が自動的に控除される</li>
              <li>サイドバーの「人事・労務」セクション → 人員マスタから設定</li>
            </ul>
          </div>

          {/* Excel 3シート */}
          <div className="border border-green-200 dark:border-green-800 rounded-lg p-4 bg-green-50/30 dark:bg-green-900/10">
            <h4 className="font-bold text-green-700 dark:text-green-400 mb-2">出面Excel（3シート構成）</h4>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>HFU向け・日比建設向け出面Excelは外国人スタッフがいる場合3シート構成</li>
              <li><span className="font-bold">Sheet1「出面一覧」</span>：従来の出面表形式（社内確認用）</li>
              <li><span className="font-bold">Sheet2「勤務時間一覧」</span>：出面データを時間に変換（日次の実労働h / 所定h / 週番号）</li>
              <li><span className="font-bold">Sheet3「勤怠サマリー」</span>：3段階残業判定の結果（個人別月次集計）</li>
            </ul>
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              <p className="font-bold mb-1">勤怠サマリーの出力項目:</p>
              <p>所定労働時間/日数、実労働時間/日数、所定外労働時間、法定外労働時間（日/週/月の内訳付き）、法定休日労働時間、所定休日労働時間、基本給（固定）</p>
              <p className="mt-1">給与計算の分担: HFU → キャシュモ / 日比建設 → 社内</p>
            </div>
          </div>

          {/* 通知ベル */}
          <div className="border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 bg-yellow-50/30 dark:bg-yellow-900/10">
            <h4 className="font-bold text-yellow-700 dark:text-yellow-400 mb-2">通知ベルの項目</h4>
            <ul className="list-disc ml-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>就業カレンダー未署名・未承認</li>
              <li>有給付与アラート</li>
              <li>月締め未完了</li>
              <li>在留期限アラート（180日/90日/30日/期限切れ）</li>
              <li>有給承認待ち（スタッフからの申請が未処理）</li>
              <li>お知らせ（システムからの重要通知）</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── セクション 12: 外国人管理 ── */}
      <Section title="外国人スタッフの管理項目" icon="&#127468;">
        <div className="mt-3">
          <T
            headers={['管理項目', '内容']}
            rows={[
              ['在留資格', '実習1号/2号/3号、特定1号/2号（人員マスタで管理）'],
              ['在留期限', '日付管理 + 自動アラート（180日/90日/30日/期限切れ）'],
              ['メモ', '一時帰国予定・退職予定・更新方針など自由記述（人員マスタ）'],
              ['スタッフ画面', '日本語 + ベトナム語の二言語表示'],
              ['署名', '就業カレンダーの全現場一括署名（タイムスタンプ記録）'],
              ['有給休暇', '法定日数を自動付与、残日数チェック付きの申請フロー'],
              ['出面入力', 'スマホから開始/終了時刻・休憩を入力して出勤登録（5月〜新形式）'],
              ['帳票出力', '出面表・月次集計・有給管理台帳のExcel出力（出面Excelは3シート構成: 出面一覧+勤務時間一覧+勤怠サマリー）'],
            ]}
          />
        </div>
      </Section>
    </div>
  )
}
