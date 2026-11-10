/**
 * 使い方を聞く（2026-11-10 代表「使い方や機能のことを聞いたら AI が自動で答えるメニュー」）。
 *
 * 「困ったこと・要望」（/feedback）のいちばん上にある欄。質問を書くと、AI（Claude）が資料一覧のマニュアルだけを
 * 読んでその場で答える。解決しなければ、質問と答えを付けたまま「困ったこと・要望」として代表に送れる。
 *
 * 守り:
 * - AI に渡すのは、ログインなしで開ける公開マニュアル（public/*.html）の文だけ。出面・給与・有給などの実データは渡さない
 * - 資料は役割ごとに出し分ける（helpDocsForRole）。役割の決まった資料は、その役割の人と代表にだけ読ませる。
 *   役割が分からないときは全員向けの資料だけ（資料一覧の画面とは逆に、狭い側に倒す）
 * - AI は読んで答えるだけ。システムの操作はしない
 * - 質問と答えは Firestore `helpLog` に残す（見られるのは代表 = feedback.manage）
 * - 1人1日の回数に上限（HELP_LIMITS.perDay）
 *
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。AI の呼び出しは lib/help.server.ts。
 */
import { DOCS, type DocItem, type DocRole } from './docs-catalog'
import type { PermRole } from './permissions'

export const HELP_COL = 'helpLog'

export const HELP_LIMITS = {
  /** 質問1回の文字数 */
  question: 600,
  /** 1人1日に聞ける回数（使いすぎ・費用の歯止め） */
  perDay: 20,
  /** 続けて聞くときに AI へ渡す、直前のやり取りの数（質問と答えの組） */
  historyPairs: 3,
} as const

export interface HelpSource {
  url: string
  title: string
}

/** 画面に返す答え */
export interface HelpAnswer {
  /** 資料から答えられたか。false のときは「代表に送る」を強く勧める */
  answered: boolean
  answer: string
  sources: HelpSource[]
  /** 今日あと何回聞けるか */
  remaining: number
}

/** 続けて聞くときに画面から送る、直前のやり取り */
export interface HelpTurn {
  q: string
  a: string
}

/** Firestore `helpLog/{id}` */
export interface HelpLogEntry {
  at: string
  /** 日本時間の日付 'YYYY-MM-DD'（1日の回数を数える鍵） */
  day: string
  workerId: number
  name: string
  role: PermRole | null
  question: string
  answered: boolean
  answer: string
  sources: string[]
  /** 費用の目安に使う（入力・キャッシュ読み・キャッシュ書き・出力のトークン数） */
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }
}

export function helpQuestionError(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return '質問を書いてください'
  if (text.length > HELP_LIMITS.question) return `質問は${HELP_LIMITS.question}文字までです（長いときは分けて聞いてください）`
  return null
}

const DOC_ROLE_OF: Record<PermRole, DocRole | null> = {
  owner: 'admin',
  approver: 'approver',
  jimu: 'jimu',
  foreman: 'foreman',
  // 役員向けの資料は無い。全員向けの資料だけ
  officer: null,
}

/**
 * その役割の人の質問に、AI が読んでよい資料。
 * - 過去資料（archive）は読ませない（古い手順を答えてしまう）
 * - 役割の決まった資料は、その役割の人と代表にだけ
 * - 役割が分からない・役員は、全員向けの資料だけ（安全側）
 */
export function helpDocsForRole(role: PermRole | null): DocItem[] {
  const docRole = role ? DOC_ROLE_OF[role] : null
  return DOCS.filter(d => {
    if (d.category === 'archive') return false
    if (d.internal) return false
    if (!d.roles) return true
    if (docRole === 'admin') return true
    return !!docRole && d.roles.includes(docRole)
  })
}

const ESCALATION_MAX = 2400

/** 「これでは分からない → 代表に送る」で、要望の本文に入れる文 */
export function helpEscalationText(turns: HelpTurn[]): string {
  const last = turns[turns.length - 1]
  if (!last) return ''
  const earlier = turns.slice(0, -1).map(t => `（その前の質問）${t.q}`).join('\n')
  const full = [
    last.q,
    '',
    '--- AI の答え（これでは解決しませんでした）---',
    last.a,
    ...(earlier ? ['', earlier] : []),
  ].join('\n')
  // 要望の本文の上限（lib/feedback.ts FEEDBACK_LIMITS.text = 3000）に収め、書き足す余白を残す
  return full.length > ESCALATION_MAX ? `${full.slice(0, ESCALATION_MAX)}…` : full
}
