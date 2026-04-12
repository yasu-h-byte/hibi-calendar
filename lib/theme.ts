const STORAGE_KEY = 'hibi_theme'
const FONT_SIZE_KEY = 'hibi_fontSize'

export type Theme = 'light' | 'dark'
export type FontSize = 'normal' | 'large'

// ── Theme ──

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'dark' || stored === 'light') return stored
  // Check system preference
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

export function setTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

export function toggleTheme(): Theme {
  const current = getTheme()
  const next: Theme = current === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (theme === 'dark') {
    html.classList.add('dark')
  } else {
    html.classList.remove('dark')
  }
}

// ── Font Size ──

export function getFontSize(): FontSize {
  if (typeof window === 'undefined') return 'normal'
  const stored = localStorage.getItem(FONT_SIZE_KEY)
  if (stored === 'normal' || stored === 'large') return stored
  return 'normal'
}

export function setFontSize(size: FontSize): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(FONT_SIZE_KEY, size)
  applyFontSize(size)
}

export function toggleFontSize(): FontSize {
  const current = getFontSize()
  const next: FontSize = current === 'large' ? 'normal' : 'large'
  setFontSize(next)
  return next
}

export function applyFontSize(size: FontSize): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.fontSize = size === 'large' ? '18px' : ''
}

// ── Init ──

/** Initialize theme + font size on app mount. Call once in layout. */
export function initTheme(): Theme {
  const theme = getTheme()
  applyTheme(theme)
  const fontSize = getFontSize()
  applyFontSize(fontSize)
  return theme
}

/** Initialize font size and return current value */
export function initFontSize(): FontSize {
  const size = getFontSize()
  applyFontSize(size)
  return size
}
