/**
 * 困ったこと・要望（2026-10-09 代表「要望欄で森田さんとやり取りしながらシステムの修正につなげたい」）。
 *
 * 1件の書き込み＝1つのやり取り（スレッド）。書いた人と代表（開発）が、その中で返信を重ねる。
 * - 書ける: ログインしている人（職長・事務・役員・事業責任者・代表）。見られるのは自分が書いたものだけ
 * - 代表: 全部を見て返信し、状態（受付→対応中→直した／見送り）を変える。
 *   開発（Claude）の返信は代表のセッションから Firestore（feedback/{id}）に書く（by.kind = 'dev'）
 * - 未読: 相手が書いたら、もう一方に未読が付く（メニューの件数）。開いたら消える
 *
 * 保存先: Firestore `feedback`（1件1ドキュメント・messages は配列）。画像は Storage `feedback/{id}/…`
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */

export const FEEDBACK_COL = 'feedback'

export type FeedbackKind = 'trouble' | 'request' | 'question'
export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  trouble: '困った・おかしい',
  request: 'こうしてほしい',
  question: '使い方の質問',
}

export type FeedbackStatus = 'open' | 'doing' | 'done' | 'wontfix'
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: '受付',
  doing: '対応中',
  done: '直した',
  wontfix: '見送り',
}
/** 札の色（components/ui/PageParts の Chip の tone） */
export const FEEDBACK_STATUS_TONE: Record<FeedbackStatus, 'amber' | 'blue' | 'green' | 'gray'> = {
  open: 'amber',
  doing: 'blue',
  done: 'green',
  wontfix: 'gray',
}

/** 書いた人の種類。user = 書き込んだ本人の側、owner = 代表、dev = 開発（Claude） */
export type FeedbackAuthorKind = 'user' | 'owner' | 'dev'

export interface FeedbackImage {
  path: string
  name: string
}

export interface FeedbackMessage {
  id: string
  at: string
  by: { kind: FeedbackAuthorKind; workerId: number | null; name: string }
  text: string
  images?: FeedbackImage[]
}

export interface FeedbackThread {
  id: string
  createdAt: string
  updatedAt: string
  author: { workerId: number; name: string }
  kind: FeedbackKind
  /** どの画面のことか（メニューの名前）。空なら「全体・わからない」 */
  page: string
  title: string
  status: FeedbackStatus
  messages: FeedbackMessage[]
  /** 書いた人がまだ読んでいない返信がある */
  unreadForAuthor: boolean
  /** 代表がまだ読んでいない書き込みがある */
  unreadForOwner: boolean
}

export const FEEDBACK_LIMITS = {
  title: 60,
  text: 3000,
  /** 1回に付けられる画像の数 */
  images: 3,
  /** 画像1枚の大きさ（画面で縮めてから送る） */
  imageBytes: 1_000_000,
} as const

/** 書き込みの中身を確かめる。だめなら理由（よければ null） */
export function feedbackTextError(text: unknown, imageCount = 0): string | null {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t && imageCount === 0) return '内容を書いてください'
  if (t.length > FEEDBACK_LIMITS.text) return `内容は${FEEDBACK_LIMITS.text}文字までです`
  if (imageCount > FEEDBACK_LIMITS.images) return `画像は1回に${FEEDBACK_LIMITS.images}枚までです`
  return null
}

/** 返信したあとの未読の付け方。相手側に未読を付け、自分側は既読にする */
export function unreadAfterPost(byKind: FeedbackAuthorKind): Pick<FeedbackThread, 'unreadForAuthor' | 'unreadForOwner'> {
  return byKind === 'user'
    ? { unreadForAuthor: false, unreadForOwner: true }
    : { unreadForAuthor: true, unreadForOwner: false }
}

/** その人にとって未読か（manage = 代表として見ているか） */
export function isUnreadFor(t: Pick<FeedbackThread, 'unreadForAuthor' | 'unreadForOwner' | 'author'>, viewer: { workerId: number; manage: boolean }): boolean {
  if (viewer.manage) return t.unreadForOwner
  return t.author.workerId === viewer.workerId && t.unreadForAuthor
}

/** 一覧の並び: 未読 → 終わっていない → 新しい順 */
export function sortFeedback<T extends Pick<FeedbackThread, 'status' | 'updatedAt'>>(list: T[], unread: (t: T) => boolean): T[] {
  const closed = (s: FeedbackStatus) => s === 'done' || s === 'wontfix'
  return [...list].sort((a, b) =>
    Number(unread(b)) - Number(unread(a))
    || Number(closed(a.status)) - Number(closed(b.status))
    || b.updatedAt.localeCompare(a.updatedAt))
}

export function isFeedbackStatus(s: unknown): s is FeedbackStatus {
  return typeof s === 'string' && s in FEEDBACK_STATUS_LABEL
}
export function isFeedbackKind(s: unknown): s is FeedbackKind {
  return typeof s === 'string' && s in FEEDBACK_KIND_LABEL
}
