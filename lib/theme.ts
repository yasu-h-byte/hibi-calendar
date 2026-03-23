const STORAGE_KEY = 'hibi_theme'

export type Theme = 'light' | 'dark'

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

/** Initialize theme on app mount. Call once in layout. */
export function initTheme(): Theme {
  const theme = getTheme()
  applyTheme(theme)
  return theme
}
