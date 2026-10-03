/**
 * 確認の部品の「呼び出し口」（UI/UX 磨き込み 土台②・2026-10-03 代表 OK）
 *
 * ブラウザ標準の confirm()（OS ごとに見た目が違う・ボタンがいつも OK／キャンセル・理由を書けない・
 * スマホで字が小さい）をやめ、本体の見た目の確認窓に置き換える。画面側はこの関数を await するだけ。
 * 窓そのもの（React）は components/ui/Confirm.tsx の <ConfirmHost /> で、レイアウトに1つ置く。
 * ホストが無い画面（まだ置いていない layout・テスト）では window.confirm / window.prompt に落ちる。
 *
 * 4つの型（見本 https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh）:
 *   ① ふつうの確認（提出・承認・保存）     tone: 'main'（既定）。主役ボタンは紺
 *   ② 取り消し・削除（元に戻せない）       tone: 'danger'。赤は取り消し・削除だけ。description に「元に戻せません」を書く
 *   ③ 理由を書く確認（承認後の修正など）   reason を渡す → confirmWithReason() が理由の文字列を返す（やめたら null）
 *   ④ スタッフ向け（日本語とベトナム語）   vi を渡す → 2言語並記・指で押せる大きいボタン
 *
 * ボタンの言葉は「OK」でなく起きることの動詞（提出する・承認する・取り消す）。「やめる」は既定で付く。
 *
 *   if (!(await confirmDialog({ title: '葛西のカレンダーを提出しますか？', description: '提出すると政仁さんの承認待ちになります。', confirmLabel: '提出する' }))) return
 *   const reason = await confirmWithReason({ title: '承認済みのカレンダーを直します', confirmLabel: '保存する', reason: { label: '直す理由' } })
 *   if (reason === null) return
 */

export type ConfirmTone = 'main' | 'danger'

export interface ConfirmOptions {
  /** 1行の問いかけ（例: 「この請求書を取り消しますか？」） */
  title: string
  /** 何が起きるか・元に戻せるか。\n で段落を分けられる */
  description?: string
  /** 主役ボタンの言葉（動詞で。例: 提出する・取り消す）。省略時は「はい」 */
  confirmLabel?: string
  /** 省略時は「やめる」 */
  cancelLabel?: string
  /** danger = 取り消し・削除だけ（赤）。それ以外は main（紺） */
  tone?: ConfirmTone
  /** スタッフ向け（日越並記・大きいボタン）。title の下にベトナム語を出す */
  vi?: { title?: string; description?: string; confirmLabel?: string; cancelLabel?: string }
  /** 理由を書かせる（③）。required（既定 true）なら書くまで主役ボタンを押せない */
  reason?: { label: string; placeholder?: string; required?: boolean }
}

export interface ConfirmResult {
  ok: boolean
  /** reason を渡したときの入力（ok のときだけ） */
  reason?: string
}

type Host = (opts: ConfirmOptions) => Promise<ConfirmResult>

let host: Host | null = null

/** <ConfirmHost /> が mount したときに登録する（画面側は使わない） */
export function registerConfirmHost(h: Host | null): void {
  host = h
}

/** テストやホスト無し画面のための素の確認（window.confirm / prompt） */
function fallback(opts: ConfirmOptions): ConfirmResult {
  if (typeof window === 'undefined') return { ok: true }
  const text = [opts.title, opts.description, opts.vi?.title].filter(Boolean).join('\n')
  if (opts.reason) {
    const r = window.prompt(`${text}\n\n${opts.reason.label}`, '') // dialog-ok
    if (r === null) return { ok: false }
    if (opts.reason.required !== false && !r.trim()) return { ok: false }
    return { ok: true, reason: r.trim() }
  }
  return { ok: window.confirm(text) } // dialog-ok
}

/** 確認の窓を出し、主役ボタンが押されたら true */
export async function confirmDialog(opts: Omit<ConfirmOptions, 'reason'>): Promise<boolean> {
  const r = host ? await host(opts) : fallback(opts)
  return r.ok
}

/** 理由つきの確認。主役ボタンが押されたら理由の文字列、やめたら null */
export async function confirmWithReason(opts: ConfirmOptions & { reason: NonNullable<ConfirmOptions['reason']> }): Promise<string | null> {
  const r = host ? await host(opts) : fallback(opts)
  if (!r.ok) return null
  return (r.reason ?? '').trim()
}

/** 「元に戻せない」操作の定型（②）。description の末尾に必ず「元に戻せません。」を添える */
export function confirmDanger(opts: Omit<ConfirmOptions, 'reason' | 'tone'>): Promise<boolean> {
  const base = (opts.description ?? '').trim()
  const description = base.endsWith('元に戻せません。') || base.endsWith('元に戻せません')
    ? base
    : (base ? `${base}\n元に戻せません。` : '元に戻せません。')
  return confirmDialog({ ...opts, description, tone: 'danger' })
}
