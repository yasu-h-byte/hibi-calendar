/**
 * 日次バックアップの対象に、コードで使っているコレクションが全部入っているかの自動点検（2026-10-02 総合点検）
 *
 * 承認の記録（attendanceApprovals）・本人確認（attConfirm）・書類庫（staffDocs）・給与欄の変更記録（auditTrail）が
 * 退避されていなかった。対象を1行ずつ手で足す作りだったので、新しいコレクションを作ったときに足し忘れる。
 * app/ と lib/ で使っているコレクション名を全部拾い、lib/backup-plan.ts の「退避する」か
 * 「意図して退避しない（理由つき）」のどちらかに載っていることを確かめる。
 *
 * 新しいコレクションを足してこのテストが落ちたら: lib/backup-plan.ts の BACKUP_COLLECTIONS に1行足す
 * （増え続けるものは BACKUP_MONTHLY_COLLECTIONS にして app/api/backup/snapshot に月ごとの退避を書く）。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import {
  BACKUP_COLLECTIONS, BACKUP_MONTHLY_COLLECTIONS, BACKUP_DOCS, BACKUP_EXCLUDED,
  approvalDocYm, backupHealth, BACKUP_STALE_HOURS,
} from '@/lib/backup-plan'

const ROOT = path.join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** app/ と lib/ で使っているコレクション名（collection(db,'x')・doc(db,'x',…)・`const XXX_COL = 'x'` 形の定数） */
function usedCollections(): Map<string, string> {
  const found = new Map<string, string>()
  const files = [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'lib'))]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const rel = path.relative(ROOT, f)
    for (const m of src.matchAll(/\b(?:collection|doc)\(\s*db\s*,\s*'([A-Za-z]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], rel)
    }
    // 定数に入れてから collection(db, COL) と使う書き方
    for (const m of src.matchAll(/\bconst\s+[A-Z_]*COL(?:LECTION)?\s*=\s*'([A-Za-z]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], rel)
    }
  }
  return found
}

describe('バックアップの対象の網羅', () => {
  const covered = new Set<string>([
    ...BACKUP_COLLECTIONS.map(c => c.coll),
    ...BACKUP_MONTHLY_COLLECTIONS.map(c => c.coll),
    ...BACKUP_DOCS.map(d => d.path[0]),
  ])
  const excluded = new Set(BACKUP_EXCLUDED.map(e => e.coll))

  test('コードで使っているコレクションは、退避するか、理由つきで外すかのどちらかに載っている', () => {
    const used = usedCollections()
    // 拾い方が壊れていないこと（主なコレクションが見つかる）
    for (const must of ['demmen', 'leaveRequests', 'attendanceApprovals', 'peerInvoices', 'staffDocs', 'activityLog']) {
      expect(used.has(must), `${must} を拾えていません（拾い方の正規表現を確認）`).toBe(true)
    }
    const missing = [...used.entries()].filter(([c]) => !covered.has(c) && !excluded.has(c))
    expect(
      missing.map(([c, f]) => `${c}（${f}）`),
      'バックアップの対象に入っていないコレクションがあります。lib/backup-plan.ts に足してください',
    ).toEqual([])
  })

  test('退避するものと外すものが重なっていない・接頭辞が重複していない', () => {
    for (const c of covered) {
      if (c === 'demmen') continue   // demmen はドキュメント単位で退避（外す一覧には説明のために載せている）
      expect(excluded.has(c), `${c} が両方に載っています`).toBe(false)
    }
    const prefixes = [...BACKUP_COLLECTIONS, ...BACKUP_MONTHLY_COLLECTIONS, ...BACKUP_DOCS].map(x => x.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    // 'att' で始まる接頭辞は出面（att_YYYYMM_）の復元の絞り込みとぶつからないこと
    for (const p of prefixes) expect(/^att_/.test(p + '_')).toBe(false)
  })

  test('snapshot の処理が、一覧（lib/backup-plan.ts）から回している', () => {
    const src = readFileSync(path.join(ROOT, 'app/api/backup/snapshot/route.ts'), 'utf8')
    expect(src).toContain('for (const c of BACKUP_COLLECTIONS)')
    expect(src).toContain('for (const d of BACKUP_DOCS)')
    for (const m of BACKUP_MONTHLY_COLLECTIONS) expect(src, `${m.coll} の月ごとの退避がありません`).toContain(`'${m.coll}'`)
    // 古いバックアップは「古い順」に引いて消す（新しい順に N 件だと、古いものが永久に消えない）
    expect(src).toMatch(/where\('snapshotAt', '<'/)
    expect(src).not.toMatch(/orderBy\('snapshotAt', 'desc'\)/)
  })
})

describe('approvalDocYm（承認の記録の ID から月を取り出す）', () => {
  test('現場IDに「_」や数字が入っていても月を取れる', () => {
    expect(approvalDocYm('ihi_202609_5')).toBe('202609')
    expect(approvalDocYm('site_a_1_202610_31')).toBe('202610')
    expect(approvalDocYm('kasai__tekkotsu_202609_1')).toBe('202609')
  })
  test('形が違うものは null', () => {
    expect(approvalDocYm('ihi_202609')).toBeNull()
    expect(approvalDocYm('ihi_2026_5')).toBeNull()
    expect(approvalDocYm('')).toBeNull()
  })
})

describe('backupHealth（バックアップが動いているか）', () => {
  const now = Date.parse('2026-10-02T03:00:00.000Z')
  test('記録が無ければ異常', () => {
    expect(backupHealth(null, now).ok).toBe(false)
  })
  test('26時間以内で失敗なしなら正常', () => {
    const at = new Date(now - 10 * 3600000).toISOString()
    expect(backupHealth({ at, saved: 25, deleted: 0, errors: [] }, now)).toEqual({ ok: true, reason: null, hoursAgo: 10 })
  })
  test('26時間以上たてば異常', () => {
    const at = new Date(now - BACKUP_STALE_HOURS * 3600000).toISOString()
    const h = backupHealth({ at, saved: 25, deleted: 0, errors: [] }, now)
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('26時間')
  })
  test('一部が失敗していれば異常', () => {
    const at = new Date(now - 3600000).toISOString()
    const h = backupHealth({ at, saved: 20, deleted: 0, errors: ['peerInvoices: too large'] }, now)
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('1件')
  })
})
