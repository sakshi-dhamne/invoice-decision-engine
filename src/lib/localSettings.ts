// Two small per-viewer preferences: the colour scheme, and whether the first-visit
// explainer has been dismissed.
//
// Both live in localStorage, which is not always there. A private window, blocked
// site data or a hardened browser can make every call below throw, so each one is
// wrapped and the app renders correctly when nothing can be stored: light theme,
// explainer shown.

const THEME_KEY = 'clearline.theme'
const EXPLAINER_KEY = 'clearline.explainer-dismissed'

export type Theme = 'light' | 'dark'

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Nothing to do. The preference simply does not survive this session.
  }
}

// Light is the default. A stored preference wins; failing that we take the
// operating system's setting so the first paint is not a surprise.
export function readTheme(): Theme {
  const stored = read(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function storeTheme(theme: Theme): void {
  write(THEME_KEY, theme)
}

export function explainerDismissed(): boolean {
  return read(EXPLAINER_KEY) === 'true'
}

export function dismissExplainer(): void {
  write(EXPLAINER_KEY, 'true')
}

export function restoreExplainer(): void {
  try {
    window.localStorage.removeItem(EXPLAINER_KEY)
  } catch {
    // Same as above.
  }
}
