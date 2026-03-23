// Shared number formatting utilities for hibi-calendar
// Works in both server and client components

/** Format yen with comma separators: 9757001 → "¥9,757,001" */
export function fmtYen(value: number): string {
  return `¥${Math.round(value).toLocaleString()}`
}

/** Format yen for KPI cards (large numbers): 9757001 → "¥976万" */
export function fmtYenMan(value: number): string {
  const man = Math.round(value / 10000)
  return `¥${man.toLocaleString()}万`
}

/** Format number with comma: 1234.5 → "1,234.5", 91 → "91" */
export function fmtNum(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Format percentage: 76.166 → "76.2%" */
export function fmtPct(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)}%`
}
