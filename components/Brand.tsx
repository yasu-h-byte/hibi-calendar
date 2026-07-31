/**
 * DEDURA＋ ブランド要素（システム名の表示はすべてここを経由する）
 *
 * ＋ のモチーフは単管クランプ（直交する2本のパイプ＋ボルトの芯）。
 * とび・土工の道具をそのまま記号にしているので、社名を出さなくても
 * 「現場のシステム」だと伝わる。この意味づけは変えないこと。
 *
 * 会社名（HIBI CONSTRUCTION）とシステム名（DEDURA＋）は別物。使い分けは:
 *   - ブラウザタブ / PWA / アプリ内のシステム表示 → DEDURA＋
 *   - 公開カレンダー・帳票・スタッフ向け通知文の差出人 → HIBI CONSTRUCTION
 *
 * 色は docs/ui-design.md のパレット準拠。SVG 内は Tailwind が効かないため
 * ブランド色は 16 進で直接指定している（tailwind.config.ts と同じ値）。
 */

const NAVY = '#1B2A4A'
const AMBER = '#F5A623'
const AMBER_DARK = '#DD9314'

/** クランプ＋ マーク単体。ロゴ以外（ローディング等）でも使える */
export function DeduraMark({ size = 22, bolt = true }: { size?: number; bolt?: boolean }) {
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
export function DeduraWordmark({
  size = 'md',
  variant = 'navy',
}: {
  size?: 'sm' | 'md' | 'lg'
  variant?: 'navy' | 'white'
}) {
  const text =
    size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-lg'
  // マークは文字のキャップハイト（≒ font-size × 0.85）に合わせる。
  // 等倍だと＋だけ大きく見えてワードマークが分離するため。
  const mark = size === 'lg' ? 21 : size === 'sm' ? 13 : 17
  const color = variant === 'white' ? 'text-white' : 'text-hibi-navy'

  return (
    <span className="inline-flex items-center gap-1.5 select-none">
      <span className={`${text} ${color} font-extrabold tracking-wide leading-none`}>DEDURA</span>
      <DeduraMark size={mark} />
    </span>
  )
}

/** ログイン画面などで使うタグライン */
export const DEDURA_TAGLINE = '現場を組む。日々を組む。'

/** metadata・manifest と表記を揃えるための正式名称 */
export const DEDURA_NAME = 'DEDURA＋'

/**
 * グループ名。このシステムは日比建設と HFU の両社の人員を扱うため、
 * 常設表示は個社名ではなくグループ名を出す。
 */
export const DEDURA_GROUP = 'BOWHEAD HOLDINGS'

/**
 * 運営主体の表示。DEDURA＋ の下に添える。
 * 「Managed by」は英語では運用受託（他社に代わって管理する）の含みが出るため使わない。
 * 自社グループが自社のために運営しているシステムなので「Operated by」が正確。
 * サイドバーの内寸は 176px しかないので、9px・字間ほぼ標準で1行に収める前提。
 */
export const DEDURA_BYLINE = `Operated by ${DEDURA_GROUP}`
