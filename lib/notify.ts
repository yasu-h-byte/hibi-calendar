/**
 * お知らせの部品の「呼び出し口」（UI/UX 磨き込み 土台②・2026-10-03 代表 OK）
 *
 * ブラウザ標準の alert()（「通信エラーが発生しました」だけで、何が失敗して次に何をすればよいか分からない）を
 * やめ、画面の右上の帯に置き換える。帯そのもの（React）は components/Toast.tsx の <ToastProvider>。
 * ホストが無い画面（まだ置いていない layout・テスト）では window.alert に落ちる。
 *
 * 3種類（見本 https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh）:
 *   うまくいった → notify.success('保存しました')            緑の帯・3秒で消える。「何を・どうしたか」を1行で
 *   失敗した     → notify.failed('保存', err)                 赤の帯・閉じるまで残る。1行目「保存できませんでした」、2行目に理由と次の手
 *                  notify.error('見出し', '理由と次の手')      文面を自分で決めるとき
 *   入力の不備   → 帯は使わない。その欄のすぐ下に赤字（components/ui/PageParts.tsx の <FieldError>）
 *
 * サーバの断り（403・409 等）は data.error の文をそのまま理由に出す。通信の失敗（status 0・fetch の例外）は
 * 「通信がとぎれました。入力は画面に残っています。電波のよい所でもう一度お試しください。」に統一する。
 */

export type NotifyKind = 'success' | 'error' | 'info'

export interface NotifyMessage {
  kind: NotifyKind
  /** 1行目（太字） */
  title: string
  /** 2行目（理由・次の手）。無くてもよい */
  detail?: string
  /** true = 閉じるまで残る（失敗の既定） */
  sticky?: boolean
}

type Host = (m: NotifyMessage) => void

let host: Host | null = null

/** <ToastProvider> が mount したときに登録する（画面側は使わない） */
export function registerNotifyHost(h: Host | null): void {
  host = h
}

export const NETWORK_FAILED_DETAIL = '通信がとぎれました。入力は画面に残っています。電波のよい所でもう一度お試しください。'

/** fetch の例外や status 0 など、サーバに届かなかった失敗か */
function looksLikeNetworkError(error: unknown): boolean {
  if (error == null) return true
  const s = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
  const t = s.trim()
  if (!t) return true
  return /Failed to fetch|NetworkError|Load failed|network|通信エラー|fetch failed|ECONN|timeout|HTTP 0\b/i.test(t)
}

/** 失敗の帯の文面を組み立てる（テストから直接読めるよう純関数） */
export function failedMessage(action: string, error?: unknown, hint?: string): NotifyMessage {
  const errText = typeof error === 'string' ? error : error instanceof Error ? error.message : error == null ? '' : String(error)
  const detail = looksLikeNetworkError(error)
    ? NETWORK_FAILED_DETAIL
    : [errText.trim(), hint?.trim()].filter(Boolean).join(' ')
  return { kind: 'error', title: `${action}できませんでした`, detail, sticky: true }
}

function emit(m: NotifyMessage): void {
  if (host) { host(m); return }
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert([m.title, m.detail].filter(Boolean).join('\n')) // dialog-ok
  }
}

export const notify = {
  /** 緑の帯・3秒で消える。例: notify.success('葛西のカレンダーを提出しました') */
  success(title: string, detail?: string): void {
    emit({ kind: 'success', title, detail })
  },
  /** 赤の帯・閉じるまで残る。文面を自分で決めるとき */
  error(title: string, detail?: string): void {
    emit({ kind: 'error', title, detail, sticky: true })
  },
  /**
   * 赤の帯の定型。action は「保存」「提出」「承認」のような名詞。error はサーバの data.error か例外。
   *   notify.failed('保存', res.error)  → 「保存できませんでした」＋ 理由
   *   notify.failed('承認', e, '締めの解除は政仁さんに頼んでください')
   */
  failed(action: string, error?: unknown, hint?: string): void {
    emit(failedMessage(action, error, hint))
  },
  /** 青の帯・3秒で消える */
  info(title: string, detail?: string): void {
    emit({ kind: 'info', title, detail })
  },
}
