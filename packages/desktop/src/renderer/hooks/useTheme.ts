import { useState, useEffect, useCallback } from 'react'
import type { Theme } from '../../shared/protocol'

type ResolvedTheme = 'light' | 'dark'

interface UseThemeReturn {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>('system')
  const [nativeTheme, setNativeTheme] = useState<ResolvedTheme>('light')

  // Resolve what theme to actually display
  const resolvedTheme: ResolvedTheme =
    theme === 'system' ? nativeTheme : theme

  // Initialize theme from electron-store
  useEffect(() => {
    let mounted = true

    const init = async () => {
      const [savedTheme, currentNative] = await Promise.all([
        window.electronAPI.getTheme(),
        window.electronAPI.getNativeTheme()
      ])
      if (mounted) {
        setThemeState(savedTheme)
        setNativeTheme(currentNative)
      }
    }

    init()

    // Listen for native theme changes from the OS
    const unsubscribe = window.electronAPI.onNativeThemeChanged(
      (newTheme: ResolvedTheme) => {
        if (mounted) {
          setNativeTheme(newTheme)
        }
      }
    )

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  // Apply theme to the document when it changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  const setTheme = useCallback(async (newTheme: Theme) => {
    setThemeState(newTheme)
    await window.electronAPI.setTheme(newTheme)
  }, [])

  const toggleTheme = useCallback(() => {
    // When toggling, cycle between light and dark (skip system)
    const newTheme: Theme = resolvedTheme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
  }, [resolvedTheme, setTheme])

  return { theme, resolvedTheme, setTheme, toggleTheme }
}
