import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * iPhone のホーム画面から開いたとき、画面が時計・Dynamic Island の帯の裏に入らないこと（2026-10-26）。
 *
 * 2026-10-21 に viewport を metadata から分けたとき、それまで Next 14 に無視されていた viewportFit: 'cover' が初めて効き、
 * apple-mobile-web-app-status-bar-style: black-translucent と組み合わさって画面が帯の裏まで広がった。
 * 左上のメニューボタンが帯に重なって押せず、大川さんが出面入力へ移れない・ログアウトもできなくなった。
 * cover を付け直すなら、管理画面のメニューボタン・見出し・下の固定バーすべてに safe-area の余白を入れてからにする。
 */
describe('viewport と iPhone の上端', () => {
  it('ルートの viewport に viewportFit: cover を付けない', () => {
    const src = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')
    expect(src).not.toMatch(/viewportFit\s*:\s*['"]cover['"]/)
    expect(src).not.toMatch(/viewport-fit\s*=\s*cover/)
  })
})
