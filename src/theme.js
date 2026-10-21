export const STORAGE_KEY = 'mc-theme'
export const THEME_COLOR_LIGHT = '#f6f8fb'
export const THEME_COLOR_DARK = '#07100e'

/**
 * @typedef {'light' | 'dark' | 'auto'} ThemeMode
 */

/**
 * Read persisted theme preference from storage.
 * Invalid, missing, or throwing storage falls back to 'auto'.
 *
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} storage
 * @returns {ThemeMode}
 */
export function readPreference(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 'auto'
    const value = storage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
    return 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * Cycles theme mode: auto -> light -> dark -> auto.
 *
 * @param {ThemeMode | string} mode
 * @returns {ThemeMode}
 */
export function nextMode(mode) {
  if (mode === 'auto') return 'light'
  if (mode === 'light') return 'dark'
  return 'auto'
}

/**
 * Saves theme preference to storage. Auto removes the storage key.
 * Swallows errors if storage access throws.
 *
 * @param {{ setItem?: (key: string, value: string) => void, removeItem?: (key: string) => void } | null | undefined} storage
 * @param {ThemeMode | string} mode
 * @returns {void}
 */
export function savePreference(storage, mode) {
  try {
    if (!storage) return
    if (mode === 'light' || mode === 'dark') {
      if (typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY, mode)
      }
    } else {
      if (typeof storage.removeItem === 'function') {
        storage.removeItem(STORAGE_KEY)
      }
    }
  } catch {
    // ignore storage errors (e.g. private mode or quota errors)
  }
}

/**
 * Returns human-readable label and next mode description for aria-label and title.
 *
 * @param {ThemeMode | string} mode
 * @returns {string}
 */
export function describe(mode) {
  if (mode === 'light') return 'Theme: Light. Click for Dark.'
  if (mode === 'dark') return 'Theme: Dark. Click for Auto.'
  return 'Theme: Auto (following system). Click for Light.'
}

/**
 * Applies the given theme mode to the document element and theme-color meta tags.
 *
 * @param {{ documentElement?: { setAttribute?: (name: string, value: string) => void, removeAttribute?: (name: string) => void }, querySelectorAll?: (selector: string) => ArrayLike<any> } | null | undefined} doc
 * @param {ThemeMode | string} mode
 * @returns {void}
 */
export function applyTheme(doc, mode) {
  if (!doc || !doc.documentElement) return

  if (mode === 'light' || mode === 'dark') {
    if (typeof doc.documentElement.setAttribute === 'function') {
      doc.documentElement.setAttribute('data-theme', mode)
    }
  } else {
    if (typeof doc.documentElement.removeAttribute === 'function') {
      doc.documentElement.removeAttribute('data-theme')
    }
  }

  try {
    if (typeof doc.querySelectorAll === 'function') {
      const metaTags = Array.from(doc.querySelectorAll('meta[name="theme-color"]'))
      if (metaTags.length > 0) {
        if (mode === 'light') {
          for (const meta of metaTags) {
            if (typeof meta.setAttribute === 'function') {
              meta.setAttribute('content', THEME_COLOR_LIGHT)
            }
          }
        } else if (mode === 'dark') {
          for (const meta of metaTags) {
            if (typeof meta.setAttribute === 'function') {
              meta.setAttribute('content', THEME_COLOR_DARK)
            }
          }
        } else {
          for (const meta of metaTags) {
            if (typeof meta.getAttribute === 'function' && typeof meta.setAttribute === 'function') {
              const media = meta.getAttribute('media') || ''
              if (media.includes('light')) {
                meta.setAttribute('content', THEME_COLOR_LIGHT)
              } else if (media.includes('dark')) {
                meta.setAttribute('content', THEME_COLOR_DARK)
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore non-critical meta tag update failures
  }
}
