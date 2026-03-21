import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        hibi: {
          navy: '#1B2A4A',
          light: '#2A3F6A',
        },
      },
    },
  },
  plugins: [],
}
export default config
