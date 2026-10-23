/**
 * 賞与（賃金制度 → 賞与）の対象者。GET（画面の試算）と POST（確定）で同じ関数を使う。
 *
 * 対象は2種類:
 *   - 日本人の号俸制の人（visaType なし・jpGrade あり。役員・事務は除く）… ①〜④すべて
 *   - **利益分配だけを受け取る人**（PROFIT_SHARE_ONLY）… ①だけ。②精勤賞与・③禁煙・④子ども手当は 0 円
 *
 * 2026-10-23 代表決定: 特定技能2号のフウ(101)・トゥアン(102)にも賞与を出す。
 *   「利益分配分のみ。梶原さんと同じイメージ（等級を読み替えて同じ原資から点数で分ける）」→ 2G相当・評語の初期値 A。
 *   人員マスタの jpGrade には入れない（jpGrade があると経営コックピットへ日給の日本人として渡り、時給の見込みが崩れる。
 *   lib/integration-workers.ts）。だから賞与のときだけ使う等級をここに持つ。
 *   外国籍の人は有給を期末に買い取らない（docs/paid-leave.md）ので精勤賞与も付けない。
 * 個別の処遇なのでサーバー専用（画面の JS に載せない）。
 */
import 'server-only'
import { isAlreadyRetired } from './workers'
import type { JpGrade } from './jp-wage'

export const PROFIT_SHARE_ONLY: Record<number, { grade: JpGrade }> = {
  101: { grade: '2G' },
  102: { grade: '2G' },
}

interface BonusWorkerLike {
  id: number
  retired?: string
  visaType?: string
  jobType?: string
  jpGrade?: string
}

export interface BonusTarget<W> {
  w: W
  /** 賞与の点数で数える等級（日本人 = jpGrade・利益分配のみの人 = PROFIT_SHARE_ONLY の等級） */
  grade: JpGrade
  /** ①利益分配だけ（②〜④は付けない） */
  profitShareOnly: boolean
}

/** 賞与の対象者（退職「予定」の人は残す・2026-10-02 総合点検） */
export function bonusTargets<W extends BonusWorkerLike>(workers: W[], todayIso: string): BonusTarget<W>[] {
  const out: BonusTarget<W>[] = []
  for (const w of workers) {
    if (isAlreadyRetired(w.retired, todayIso)) continue
    if (w.jobType === 'yakuin' || w.jobType === 'jimu') continue
    const extra = PROFIT_SHARE_ONLY[w.id]
    if (extra) { out.push({ w, grade: extra.grade, profitShareOnly: true }); continue }
    if (w.visaType && w.visaType !== 'none') continue
    if (!w.jpGrade) continue
    out.push({ w, grade: w.jpGrade as JpGrade, profitShareOnly: false })
  }
  return out
}
