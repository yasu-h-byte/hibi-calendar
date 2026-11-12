/**
 * DEZRA ブランド要素（システム名の表示はすべてここを経由する）
 *
 * 名前の由来は「出面（でづら）」。2026-11-12 に DEDURA＋ から DEZRA（デズラ）へ改称した。
 *
 * シンボルは単管クランプ（直交する2本のパイプ＋ボルトの芯）。とび・土工の道具を
 * そのまま記号にしているので、社名を出さなくても「現場のシステム」だと伝わる。
 * 旧名では名前の「＋」を兼ねて文字の後ろに置いていたが、改称で「＋」が名前から
 * 外れたため、文字の前に置くシンボル（エンブレム）にした。後ろに置くと「DEZRA＋」と
 * 読まれてしまうので、文字の後ろには置かないこと。意味づけ（パイプを組む＝
 * タグライン「現場を組む。日々を組む。」）は変えない。
 *
 * 会社名（HIBI CONSTRUCTION）とシステム名（DEZRA）は別物。使い分けは:
 *   - ブラウザタブ / PWA / アプリ内のシステム表示 → DEZRA
 *   - 公開カレンダー・帳票・スタッフ向け通知文の差出人 → HIBI CONSTRUCTION
 *
 * 色は docs/ui-design.md のパレット準拠。SVG 内は Tailwind が効かないため
 * ブランド色は 16 進で直接指定している（tailwind.config.ts と同じ値）。
 */

const NAVY = '#1B2A4A'
const AMBER = '#F5A623'
const AMBER_DARK = '#DD9314'

/** クランプのシンボル単体。ロゴ以外（スマホのヘッダー・ローディング等）でも使える */
export function DezraMark({ size = 22, bolt = true }: { size?: number; bolt?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" className="shrink-0">
      <rect x="0" y="13" width="36" height="10" rx="2.5" fill={AMBER} />
      <rect x="13" y="0" width="10" height="36" rx="2.5" fill={AMBER_DARK} />
      {/* ボルトの芯。16px 未満だと潰れて濁るので小サイズでは省く */}
      {bolt && size >= 16 && (
        <>
          <circle cx="18" cy="18" r="5.2" fill={NAVY} />
          <circle cx="18" cy="18" r="1.9" fill={AMBER} />
        </>
      )}
    </svg>
  )
}

/**
 * 横組みワードマーク。
 * variant: 'navy' = 白背景用 / 'white' = ネイビー・チャコール地用
 */
export function DezraWordmark({
  size = 'md',
  variant = 'navy',
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  variant?: 'navy' | 'white'
}) {
  // xl はサイドバー用。内寸 184px（2026-09-30 から w-56）に対し実測 約151px で、フォントが変わって
  // 1割膨らんでも収まる上限。これ以上大きくすると運営表記と干渉する。
  const text =
    size === 'xl' ? 'text-[1.75rem]' : size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-lg'
  // シンボルは文字のキャップハイトより一回り大きく（≒ font-size × 1.0）。
  // 文字の前に置くエンブレムなので、キャップハイトちょうどだと小さく沈んで見える。
  const mark = size === 'xl' ? 28 : size === 'lg' ? 24 : size === 'sm' ? 14 : 18
  const color = variant === 'white' ? 'text-white' : 'text-hibi-navy'

  return (
    <span className="inline-flex items-center gap-2 select-none">
      <DezraMark size={mark} />
      <span className={`${text} ${color} font-extrabold tracking-wider leading-none`}>DEZRA</span>
    </span>
  )
}

/** ログイン画面などで使うタグライン */
export const DEZRA_TAGLINE = '現場を組む。日々を組む。'

/** metadata・manifest と表記を揃えるための正式名称 */
export const DEZRA_NAME = 'DEZRA'

/**
 * グループ名。このシステムは日比建設と HFU の両社の人員を扱うため、
 * 常設表示は個社名ではなくグループ名を出す。
 */
export const DEZRA_GROUP = 'BOWHEAD HOLDINGS'

/**
 * 運営主体の表示。DEZRA の下に添える。
 * 「Managed by」は英語では運用受託（他社に代わって管理する）の含みが出るため使わない。
 * 自社グループが自社のために運営しているシステムなので「Operated by」が正確。
 * サイドバーの内寸は 176px しかないので、9px・字間ほぼ標準で1行に収める前提。
 */
export const DEZRA_BYLINE = `Operated by ${DEZRA_GROUP}`
