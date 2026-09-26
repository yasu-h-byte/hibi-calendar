/**
 * すべての API が「誰が呼べるか」を明示しているかの自動点検（2026-09-26）
 *
 * 2026-09-26 の総点検で、サーバー側の権限チェックの付け忘れが何か所も見つかった
 * （評価の承認・振込先の読み取り・帳票の出力・写真のアップロード など。どれもパスワード一致だけで通っていた）。
 * 同じ抜けを二度と起こさないため、app/api のすべての処理（GET/POST/PUT/PATCH/DELETE）が
 * 次のどれかを本体に含むことを確かめる:
 *   - requireCap(...)            … 権限表（lib/permissions.ts）でのチェック（基本はこれ）
 *   - requireSuperAdmin / requireExecutiveAuth / isManagerRole / resolveApiRoleFromMain
 *   - getWorkerByToken / checkIntegrationKey / CRON_SECRET … スタッフ本人・連携・定期実行の鍵
 *   - `// auth: <理由>`          … 上のどれでもない理由を1行で書く（public / any-login / 下で確認 など）
 * checkApiAuth（ログインしていれば誰でも）だけの処理は、`// auth: any-login — 理由` を書かない限り落ちる。
 *
 * 新しい API を足してこのテストが落ちたら: まず lib/permissions.ts の権限で requireCap を付ける。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const API_DIR = path.join(__dirname, '..', 'app', 'api')
const EXPLICIT = [
  'requireCap(', 'requireSuperAdmin(', 'requireExecutiveAuth(', 'isManagerRole(', 'resolveApiRoleFromMain(',
  'getWorkerByToken(', 'checkIntegrationKey(', 'CRON_SECRET', '// auth:',
]

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return routeFiles(p)
    return name === 'route.ts' ? [p] : []
  })
}

function handlers(src: string): { method: string; body: string }[] {
  const parts = src.split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/)
  return parts.slice(1).map(p => ({
    method: /export async function (\w+)/.exec(p)![1],
    body: p.split('\nexport ')[0],
  }))
}

describe('API の権限チェック', () => {
  const files = routeFiles(API_DIR)

  test('API が見つかる（点検そのものが動いている）', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  test('すべての処理が「誰が呼べるか」を明示している', () => {
    const missing: string[] = []
    for (const f of files) {
      for (const h of handlers(readFileSync(f, 'utf8'))) {
        if (!EXPLICIT.some(t => h.body.includes(t))) {
          missing.push(`${path.relative(API_DIR, f).replace(/\/route\.ts$/, '')} ${h.method}`)
        }
      }
    }
    expect(missing, `権限チェックが無い処理（requireCap を付けるか // auth: で理由を書く）:\n${missing.join('\n')}`).toEqual([])
  })

  test('`// auth:` には理由が書いてある', () => {
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\/\/ auth:(.*)$/gm)) {
        expect(m[1].trim().length, `${path.relative(API_DIR, f)}: // auth: の理由が空`).toBeGreaterThan(5)
      }
    }
  })
})
