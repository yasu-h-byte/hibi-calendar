/**
 * 長い休み（帰国・育休・産休・介護休業・休職）の種類（2026-11-14 代表）
 *
 * ■ なぜ
 *   白戸職長が育休に入った（2026-12-07〜12-19・12-26〜2027-02-16）。それまで長く休む記録は
 *   「帰国」（homeLongLeave）しかなく、育休を記録する場所が無かった。何も記録しないと、
 *   出面がずっと空欄の人＝入力漏れ・欠勤・カレンダー未署名に見えてしまう。
 *
 * ■ 方針: 帰国の仕組みに「種類」を足す（別の仕組みを作らない）
 *   帰国の記録（homeLongLeave）は、出面の印（hk）・カレンダー署名の対象外・入力漏れの通知・
 *   出勤率・月次集計の日割りなど 20 か所以上に効いている。種類を足せば、1 回の登録で全部に効く。
 *   - 記録: homeLongLeave の `kind`（無い古い記録は reason から決める。決まらなければ帰国）
 *   - 出面の印: hk の値で種類を表す（1=帰国・2=育休・3=産休・4=介護休業・5=休職）。
 *     「hk があれば長い休み」という判定（truthy / > 0）はそのまま使える
 *
 * ■ 種類で違うところ
 *   - 育休・産休・介護休業は、有給の出勤率（8割）の計算で「出勤したもの」とみなす（労基法39条10項）。
 *     帰国・休職は計算から外す（今までの帰国と同じ）。→ {@link deemedWorkedForLeave}
 *   - 職長が休む日は、その現場の職長承認を政仁さん（事業責任者）へ回す（種類を問わない）
 *
 * このファイルは純粋な決まりだけ（画面からも読む）。
 */

export type LongLeaveKind = 'kikoku' | 'ikukyu' | 'sankyu' | 'kaigo' | 'kyushoku'

export const LONG_LEAVE_KINDS: LongLeaveKind[] = ['kikoku', 'ikukyu', 'sankyu', 'kaigo', 'kyushoku']

interface KindDef {
  /** 出面の印 hk の値 */
  code: number
  /** 出面のマスに出す短い名前 */
  short: string
  /** 「〜中」 */
  during: string
  /** 正式な名前（登録画面・帳票） */
  label: string
  /** 有給の出勤率で出勤とみなすか（労基法39条10項） */
  deemedWorked: boolean
  /** 外国人スタッフだけか（帰国） */
  foreignOnly: boolean
}

const DEFS: Record<LongLeaveKind, KindDef> = {
  kikoku:   { code: 1, short: '帰国', during: '帰国中',   label: '一時帰国',       deemedWorked: false, foreignOnly: true },
  ikukyu:   { code: 2, short: '育休', during: '育休中',   label: '育児休業',       deemedWorked: true,  foreignOnly: false },
  sankyu:   { code: 3, short: '産休', during: '産休中',   label: '産前産後休業',   deemedWorked: true,  foreignOnly: false },
  kaigo:    { code: 4, short: '介護', during: '介護休業中', label: '介護休業',     deemedWorked: true,  foreignOnly: false },
  kyushoku: { code: 5, short: '休職', during: '休職中',   label: '休職',           deemedWorked: false, foreignOnly: false },
}

/** 帰国のときに選べる理由（今までの選択肢） */
export const HOME_LEAVE_REASONS = ['一時帰国', 'ビザ更新帰国', 'その他'] as const

export function isLongLeaveKind(v: unknown): v is LongLeaveKind {
  return typeof v === 'string' && (LONG_LEAVE_KINDS as string[]).includes(v)
}

/**
 * 記録の種類。kind が無い古い記録（2026-11-14 より前はすべて帰国）は reason の名前から決め、
 * 決まらなければ帰国。
 */
export function longLeaveKindOf(rec: { kind?: unknown; reason?: unknown } | null | undefined): LongLeaveKind {
  if (rec && isLongLeaveKind(rec.kind)) return rec.kind
  const reason = typeof rec?.reason === 'string' ? rec.reason : ''
  for (const k of LONG_LEAVE_KINDS) {
    if (k !== 'kikoku' && reason === DEFS[k].label) return k
  }
  return 'kikoku'
}

export function longLeaveLabel(kind: LongLeaveKind): string { return DEFS[kind].label }
export function longLeaveShort(kind: LongLeaveKind): string { return DEFS[kind].short }
export function longLeaveDuring(kind: LongLeaveKind): string { return DEFS[kind].during }
export function deemedWorkedForLeave(kind: LongLeaveKind): boolean { return DEFS[kind].deemedWorked }
export function isForeignOnlyKind(kind: LongLeaveKind): boolean { return DEFS[kind].foreignOnly }

/** 出面の印 hk に書く値 */
export function hkCodeOf(kind: LongLeaveKind): number { return DEFS[kind].code }

/** 出面の印 hk の値 → 種類（1・不明な値は帰国） */
export function kindFromHk(hk: unknown): LongLeaveKind {
  const n = Number(hk)
  for (const k of LONG_LEAVE_KINDS) if (DEFS[k].code === n) return k
  return 'kikoku'
}

/** 出面のマスに出す短い名前（hk の値から）。例: 帰国・育休 */
export function hkShortLabel(hk: unknown): string { return longLeaveShort(kindFromHk(hk)) }
/** 「帰国中」「育休中」（hk の値から） */
export function hkDuringLabel(hk: unknown): string { return longLeaveDuring(kindFromHk(hk)) }

/**
 * その日に長い休みに入っているか（承認済みの記録で見る）。
 * 終了日は休みに含む（最終日）。
 */
export function isOnLongLeave(
  workerId: number,
  iso: string,
  leaves: { workerId: number; startDate: string; endDate: string }[],
): boolean {
  return leaves.some(l => l.workerId === workerId && iso >= l.startDate && iso <= l.endDate)
}
