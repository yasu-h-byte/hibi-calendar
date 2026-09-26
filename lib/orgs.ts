/**
 * 所属会社（日比建設 / HFU）の判定。xlsx などの重い依存を持たないので、
 * 帳票（lib/export.ts）以外の計算（lib/hfu-invoice.ts 等）からもそのまま使える。
 */
export type AttendanceOrg = 'hibi' | 'hfu'
export const ATTENDANCE_ORG_LABEL: Record<AttendanceOrg, string> = { hibi: '日比建設', hfu: 'HFU' }

/** org の表記ゆれ（'日比'/'hibi'・'HFU'/'hfu'）を吸収する */
export function isWorkerOfOrg(w: { org?: string }, org: AttendanceOrg): boolean {
  const o = (w.org || '').toLowerCase()
  return org === 'hibi' ? (o === 'hibi' || o === '日比') : (o === 'hfu')
}
