import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { HELP_LIMITS, helpQuestionError, helpDocsForRole, helpEscalationText } from '@/lib/help'
import { DOCS } from '@/lib/docs-catalog'
import { FEEDBACK_LIMITS } from '@/lib/feedback'
import { can } from '@/lib/permissions'
import { BACKUP_COLLECTIONS } from '@/lib/backup-plan'

vi.mock('server-only', () => ({}))

describe('使い方を聞く: 質問の不備', () => {
  it('空・長すぎを断る', () => {
    expect(helpQuestionError('')).toMatch(/質問/)
    expect(helpQuestionError('   ')).toMatch(/質問/)
    expect(helpQuestionError(undefined)).toMatch(/質問/)
    expect(helpQuestionError('x'.repeat(HELP_LIMITS.question + 1))).toMatch(/文字まで/)
    expect(helpQuestionError('有給の取り消し方は？')).toBeNull()
  })
})

describe('使い方を聞く: AI に読ませる資料の出し分け', () => {
  const urls = (role: Parameters<typeof helpDocsForRole>[0]) => helpDocsForRole(role).map(d => d.url)

  it('役割の決まった資料は、その役割の人と代表にだけ読ませる', () => {
    // 評価・賃金のマニュアルは事務（森田さん）に読ませない
    expect(urls('jimu')).toContain('/manual-morita.html')
    expect(urls('jimu')).not.toContain('/manual-evaluation.html')
    expect(urls('jimu')).not.toContain('/manual-wage-jp.html')
    expect(urls('approver')).toContain('/manual-masahito.html')
    expect(urls('approver')).toContain('/manual-wage-jp.html')
    expect(urls('approver')).not.toContain('/manual-evaluation.html')
    expect(urls('foreman')).toContain('/manual-foreman.html')
    expect(urls('foreman')).not.toContain('/manual-morita.html')
    expect(urls('owner')).toContain('/manual-evaluation.html')
  })

  it('役割が分からない・役員は、全員向けの資料だけ（狭い側に倒す）', () => {
    const open = DOCS.filter(d => !d.roles && d.category !== 'archive' && !d.internal).map(d => d.url)
    expect(urls(null)).toEqual(open)
    expect(urls('officer')).toEqual(open)
  })

  it('過去資料は、代表にも読ませない（古い手順を答えさせない）', () => {
    const archive = DOCS.filter(d => d.category === 'archive').map(d => d.url)
    expect(archive.length).toBeGreaterThan(0)
    for (const u of archive) expect(urls('owner')).not.toContain(u)
  })

  it('読ませる資料は、すべて public/ に実在する HTML（ログインなしで開ける公開資料だけ）', () => {
    for (const d of helpDocsForRole('owner')) {
      expect(d.url).toMatch(/^\/[a-z0-9-]+\.html$/)
      expect(existsSync(path.join(process.cwd(), 'public', d.url.slice(1))), d.url).toBe(true)
    }
  })

  it('資料を関数に同梱する設定がある（無いと本番で資料を読めない）', () => {
    const conf = readFileSync(path.join(process.cwd(), 'next.config.js'), 'utf-8')
    expect(conf).toMatch(/'\/api\/help':\s*\['\.\/public\/\*\.html'\]/)
  })
})

describe('使い方を聞く: 守り', () => {
  it('AI を呼ぶ側は Firestore を読まない（実データを渡さない）', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/help.server.ts'), 'utf-8')
    expect(src).toMatch(/import 'server-only'/)
    expect(src).not.toMatch(/fsdb|firebase|compute\.server|workers/)
  })

  it('試験運用の人（代表・政仁さん・森田さん）だけが聞ける', () => {
    expect(can({ role: 'admin', workerId: 0 }, 'help.ask')).toBe(true)
    expect(can({ role: 'approver', workerId: 1 }, 'help.ask')).toBe(true)
    expect(can({ role: 'jimu', workerId: 303 }, 'help.ask')).toBe(true)
    expect(can({ role: 'jimu', workerId: 304 }, 'help.ask')).toBe(false)
    expect(can({ role: 'foreman', workerId: 20 }, 'help.ask')).toBe(false)
    expect(can({ role: 'officer', workerId: 2 }, 'help.ask')).toBe(false)
  })

  it('質問の記録は日次バックアップの対象', () => {
    expect(BACKUP_COLLECTIONS.map(c => c.coll)).toContain('helpLog')
  })
})

describe('使い方を聞く: 代表に送る文', () => {
  it('質問と AI の答えが入り、要望の本文の上限に収まる', () => {
    const t = helpEscalationText([{ q: '最初の質問', a: '答え1' }, { q: '確認1が押せない', a: 'あ'.repeat(5000) }])
    expect(t.startsWith('確認1が押せない')).toBe(true)
    expect(t).toContain('AI の答え')
    expect(t.length).toBeLessThan(FEEDBACK_LIMITS.text)
    expect(helpEscalationText([])).toBe('')
  })
})

describe('使い方を聞く: マニュアルの HTML を文に直す', () => {
  it('見出し・箇条書き・表を残し、スタイルやスクリプトは捨てる', async () => {
    const { htmlToText } = await import('@/lib/help.server')
    const t = htmlToText('<style>.a{color:red}</style><h2>月の締め</h2><p>「締める」を押す&nbsp;&amp; 待つ</p><ul><li>一つめ</li></ul><table><tr><th>列</th><td>値</td></tr></table><script>x()</script>')
    expect(t).toContain('## 月の締め')
    expect(t).toContain('「締める」を押す & 待つ')
    expect(t).toContain('- 一つめ')
    expect(t).toContain('列 | 値')
    expect(t).not.toMatch(/color|x\(\)|</)
  })
})
