/**
 * 経営コックピット向け: 確定した賞与の合計（読むだけ・2026-11-11）
 *
 * 代表「2026年12月の決算賞与は DEDURA＋ 側で確定しているので、DEDURA＋ からデータを拾ってください」。
 * 賃金制度の賞与の画面で確定した記録（jpBonuses）を、**合計だけ**にして渡す（個人ごとの額は渡さない）。
 * 数え方は画面の合計行と同じ1か所（lib/bonus-summary.ts の summarizeBonus）。
 * 経営コックピットは「自社が払う分（own.total）」を資金繰りと着地の賞与に使う（出向先が払う分は会社のお金が出ない）。
 * 詳細は docs/integration.md
 */
import { summarizeBonus, type BonusSumLine, type BonusPart } from '@/lib/bonus-summary'

export interface IntegrationBonus {
  id: string
  /** 支給名（例: 2026年 冬の賞与） */
  label: string
  /** 支給日 YYYY-MM-DD */
  paidOn: string
  /** 原資（利益分配の元・円） */
  pool: number
  /** 自社が払う人の合計（人数・①利益分配・②精勤賞与・③禁煙手当・④子ども手当・合計） */
  own: BonusPart
  /** 出向先が払う人の合計（自社のお金は出ない） */
  dispatched: BonusPart
  /** 自社が払う分のうち、振込・現金 */
  transfer: number
  cash: number
  /** 確定した時刻 */
  savedAt: string | null
}

/** 確定した賞与の記録1件を、合計だけの形にする。純粋な計算（テストできる） */
export function bonusToIntegration(r: { id: string; label?: string; paidOn?: string; pool?: number; allocations?: BonusSumLine[]; savedAt?: string }): IntegrationBonus {
  const s = summarizeBonus(Number(r.pool) || 0, Array.isArray(r.allocations) ? r.allocations : [])
  return {
    id: r.id,
    label: r.label || '',
    paidOn: r.paidOn || '',
    pool: Number(r.pool) || 0,
    own: s.own,
    dispatched: s.dispatched,
    transfer: s.transfer,
    cash: s.cash,
    savedAt: r.savedAt || null,
  }
}

/** from（YYYY-MM-DD）以降が支給日の、確定した賞与（新しい順）。サーバーだけ */
export async function loadIntegrationBonuses(from: string): Promise<{ generatedAt: string; from: string; bonuses: IntegrationBonus[] }> {
  const [{ db }, { collection, getDocs, query, where }] = await Promise.all([import('@/lib/firebase'), import('@/lib/fsdb')])
  // 支給日で絞って読む（コレクション全体を読まない）
  const snap = await getDocs(query(collection(db, 'jpBonuses'), where('paidOn', '>=', from)))
  const bonuses: IntegrationBonus[] = []
  snap.forEach((d) => bonuses.push(bonusToIntegration({ id: d.id, ...(d.data() as Record<string, unknown>) } as never)))
  bonuses.sort((a, b) => b.paidOn.localeCompare(a.paidOn))
  return { generatedAt: new Date().toISOString(), from, bonuses } // utc-ok（記録の時刻）
}
