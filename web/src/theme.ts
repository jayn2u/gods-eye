import React from 'react'

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'gods-eye-theme'
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)'

function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  try {
    return window.matchMedia(SYSTEM_THEME_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  } catch {
    return null
  }
}

export function initialTheme(): Theme {
  return readStoredTheme() ?? systemTheme()
}

function storeTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Private browsing and blocked storage should not prevent theme switching.
  }
}

export function useTheme(): readonly [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = React.useState<Theme>(() => initialTheme())
  const hasExplicitChoice = React.useRef(readStoredTheme() !== null)

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  React.useEffect(() => {
    if (hasExplicitChoice.current || typeof window.matchMedia !== 'function') return

    let mediaQuery: MediaQueryList
    try {
      mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY)
    } catch {
      return
    }

    const handleChange = (event: MediaQueryListEvent) => {
      if (!hasExplicitChoice.current) setTheme(event.matches ? 'dark' : 'light')
    }

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [])

  const chooseTheme = React.useCallback((nextTheme: Theme) => {
    hasExplicitChoice.current = true
    setTheme(nextTheme)
    storeTheme(nextTheme)
  }, [])

  return [theme, chooseTheme] as const
}
