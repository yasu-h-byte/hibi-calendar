// ESLint 9（flat config・2026-10-21 Next 15 への更新で .eslintrc.json から移行）。中身は変えていない: next/core-web-vitals
import { FlatCompat } from '@eslint/eslintrc'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) })

export default [
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // 意図して外す依存は `// eslint-disable-next-line react-hooks/exhaustive-deps` に理由を書く（CLAUDE.md）
      'react-hooks/exhaustive-deps': 'warn',
      // 署名 URL・data URL の <img>（理由コメントつきの 4 か所）
      '@next/next/no-img-element': 'off',
    },
  },
  { ignores: ['.next/**', 'node_modules/**', 'scripts/archive/**'] },
]
