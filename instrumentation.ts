/**
 * サーバ起動時に 1 回だけ走る（Next 15 の instrumentation）。
 * 中身は instrumentation-node.ts（Node ランタイム専用。eMudhra 認証局事件で漏えいした
 * 中間証明書の親ルートを、Node 内蔵の信頼一覧から外す。2026-10-23）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { distrustCompromisedRoots } = await import('./instrumentation-node')
      distrustCompromisedRoots()
    } catch (e) {
      console.warn('[instrumentation] CA ルートの絞り込みに失敗（通信は従来どおり）:', e instanceof Error ? e.message : e)
    }
  }
}
