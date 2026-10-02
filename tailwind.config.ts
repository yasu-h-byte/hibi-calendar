import type { Config } from 'tailwindcss'
import defaultTheme from 'tailwindcss/defaultTheme'

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    // クラス文字列を返すヘルパー（lib/leave-utils.ts の rateBarColor 等）も
    // スキャン対象にする。外すと CSS が生成されず UI が無色になる
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // 字は BIZ UDPゴシック（読み間違えにくいユニバーサルデザイン書体）。app/layout.tsx で読み込む
      /**
       * 文字の大きさ（2026-10-03 UI の磨き込み・土台）。
       * 旧: text-[10px] のような px 指定が約650か所あり、「大きい文字」（html の font-size を 18px にする）が効かなかった。
       * rem で定義して、画面全体が設定どおりに大きくなるようにする。px 指定は印刷用の画面（給料表・計算根拠PDF・
       * 評価の印刷・請求書の印刷）だけに残す（紙の見た目を変えないため）。
       * 2xs（10px 相当）は札・補足だけ。本文には xxs（11px 相当）以上を使う
       */
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],   // 10px
        'xxs': ['0.6875rem', { lineHeight: '1rem' }],      // 11px
        '13': ['0.8125rem', { lineHeight: '1.125rem' }],   // 13px
        '15': ['0.9375rem', { lineHeight: '1.375rem' }],   // 15px
        '17': ['1.0625rem', { lineHeight: '1.5rem' }],     // 17px
        '22': ['1.375rem', { lineHeight: '1.75rem' }],     // 22px
        '26': ['1.625rem', { lineHeight: '2rem' }],        // 26px
        '28': ['1.75rem', { lineHeight: '2.125rem' }],     // 28px
        '30': ['1.875rem', { lineHeight: '2.25rem' }],     // 30px
        '32': ['2rem', { lineHeight: '2.375rem' }],        // 32px
      },
      fontFamily: {
        sans: ['var(--font-ud)', ...defaultTheme.fontFamily.sans],
      },
      colors: {
        hibi: {
          navy: '#1B2A4A',
          light: '#2A3F6A',
          // デザイン刷新トークン（2026-09-30 第2次刷新「案1 UDホワイト」。旧: 案A/案C 2026-07-03）
          bg: '#F3F5F8',        // ページ背景（白いサイドバー・白いカードとの差がわかる薄いグレー）
          line: '#E3E7EE',      // カード・サイドバーの細枠線
          sub: '#5B6475',       // 補足の文字（ラベル・単位）。gray-500 より濃く、白地で 4.5:1 以上
          active: '#EAF0FA',    // サイドバーの選択中・情報ピルの地
          thead: '#F2F4F9',     // グリッド日付ヘッダー背景
          charcoal: '#20262F',  // スマホ画面のヘッダー・文字色（案C チャコール）
          amber: '#F5A623',     // スマホ画面の主役ボタン（案C 工事アンバー）
          amberDark: '#DD9314', // アンバーの押下色
        },
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(100%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideOutRight: {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(100%)' },
        },
        modalIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 0.3s ease-out',
        slideInRight: 'slideInRight 0.3s ease-out',
        slideOutRight: 'slideOutRight 0.3s ease-out',
        modalIn: 'modalIn 0.2s ease-out',
        skeleton: 'pulse 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
export default config
