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
      fontFamily: {
        sans: ['var(--font-ud)', ...defaultTheme.fontFamily.sans],
      },
      // 文字の大きさは rem 系だけ使う（px 指定はブラウザ・OSの「文字を大きく」が効かない。2026-10-03）。
      // 標準の xs(12)・sm(14)・base(16)・lg(18)・xl(20)… に、札・グリッド用の小さい2段を足す。
      // 行の高さは付けない（元の text-[10px] と同じく親から継承）。10px 相当より小さい字は使わない
      fontSize: {
        '3xs': '0.625rem',  // 10px 相当。札・グリッドのマスの補足だけ（本文には使わない）
        '2xs': '0.6875rem', // 11px 相当
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
