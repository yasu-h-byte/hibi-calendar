/**
 * 権限の決まりは lib/permissions.ts だけ（CLAUDE.md・2026-09-26）。
 *
 * requireExecutiveAuth（「代表または workerId 1」の直書き）と isManagerRole（役割名の直書き）は、権限表を変えても
 * 追従しない古い書き方。既に使っている所は一覧で許し、**新しい API で使ったらこのテストが落ちる**
 * （2026-10-02 総合点検。新しい API は requireCap / callerCan を使う）。
 * 一覧から減らすのは歓迎（減らしたらここも減らす）。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(__dirname, '..')

/** 2026-10-02 時点で requireExecutiveAuth / isManagerRole を使っているファイル（これ以上増やさない） */
const ALLOWED = new Set([
  'app/api/attendance/grid/route.ts',
  'app/api/calendar/approve/route.ts',
  'app/api/calendar/bulk-confirm/route.ts',
  'app/api/calendar/reject/route.ts',
  'app/api/calendar/reset/route.ts',
  'app/api/calendar/revert/route.ts',
  'app/api/calendar/save-days/route.ts',
  'app/api/calendar/submit/route.ts',
  'app/api/home-long-leave/route.ts',
  'app/api/jp-wage/bonus/route.ts',
  'app/api/jp-wage/history/route.ts',
  'app/api/jp-wage/promotion/route.ts',
  'app/api/jp-wage/revision/route.ts',
  'app/api/jp-wage/seed/route.ts',
  'app/api/leave-request/route.ts',
  'lib/auth.ts',          // 定義そのもの
  'lib/foreman-todo.ts',  // managerByToken（マイページからの最終承認）
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('古い権限判定（requireExecutiveAuth / isManagerRole）を新しく使わない', () => {
  const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'components'))]
  const users = files
    .filter(f => /\b(requireExecutiveAuth|isManagerRole)\(/.test(readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f))

  test('一覧に無いファイルで使っていない（新しい API は requireCap / callerCan を使う）', () => {
    expect(users.filter(f => !ALLOWED.has(f))).toEqual([])
  })
  test('一覧は実際に使っているファイルだけ（減らしたら一覧も減らす）', () => {
    expect([...ALLOWED].filter(f => !users.includes(f))).toEqual([])
  })
})
