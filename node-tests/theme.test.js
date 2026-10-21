import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STORAGE_KEY,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  applyTheme,
  describe,
  nextMode,
  readPreference,
  savePreference,
} from '../src/theme.js'

test('readPreference handles valid, invalid, missing, and throwing storage', () => {
  // Valid storage
  assert.equal(readPreference({ getItem: k => (k === STORAGE_KEY ? 'light' : null) }), 'light')
  assert.equal(readPreference({ getItem: k => (k === STORAGE_KEY ? 'dark' : null) }), 'dark')

  // Invalid storage values
  assert.equal(readPreference({ getItem: () => 'invalid' }), 'auto')
  assert.equal(readPreference({ getItem: () => 'auto' }), 'auto')
  assert.equal(readPreference({ getItem: () => '' }), 'auto')
  assert.equal(readPreference({ getItem: () => null }), 'auto')

  // Missing storage
  assert.equal(readPreference(null), 'auto')
  assert.equal(readPreference(undefined), 'auto')
  assert.equal(readPreference({}), 'auto')

  // Throwing storage
  const throwingStorage = {
    getItem: () => {
      throw new Error('Access denied in private mode')
    },
  }
  assert.equal(readPreference(throwingStorage), 'auto')
})

test('nextMode cycles auto -> light -> dark -> auto', () => {
  assert.equal(nextMode('auto'), 'light')
  assert.equal(nextMode('light'), 'dark')
  assert.equal(nextMode('dark'), 'auto')

  // Gracefully handles fallback
  assert.equal(nextMode('unknown'), 'auto')
})

test('savePreference handles set, remove, missing, and throwing storage', () => {
  /** @type {Record<string, string>} */
  const map = {}
  const storage = {
    getItem: (/** @type {string} */ k) => map[k] ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
      map[k] = v
    },
    removeItem: (/** @type {string} */ k) => {
      delete map[k]
    },
  }

  // Set light
  savePreference(storage, 'light')
  assert.equal(map[STORAGE_KEY], 'light')

  // Set dark
  savePreference(storage, 'dark')
  assert.equal(map[STORAGE_KEY], 'dark')

  // Auto removes preference
  savePreference(storage, 'auto')
  assert.equal(map[STORAGE_KEY], undefined)

  // Non-standard value removes preference
  map[STORAGE_KEY] = 'something'
  savePreference(storage, 'unknown')
  assert.equal(map[STORAGE_KEY], undefined)

  // Missing storage should not throw
  assert.doesNotThrow(() => savePreference(null, 'light'))
  assert.doesNotThrow(() => savePreference(undefined, 'dark'))

  // Throwing storage should be swallowed
  const throwingStorage = {
    setItem: () => {
      throw new Error('Quota exceeded')
    },
    removeItem: () => {
      throw new Error('Storage disabled')
    },
  }
  assert.doesNotThrow(() => savePreference(throwingStorage, 'light'))
  assert.doesNotThrow(() => savePreference(throwingStorage, 'auto'))
})

test('applyTheme sets and removes data-theme attribute on minimal fake document', () => {
  /** @type {Record<string, string>} */
  const attrs = {}
  const fakeDoc = {
    documentElement: {
      setAttribute: (/** @type {string} */ name, /** @type {string} */ value) => {
        attrs[name] = value
      },
      removeAttribute: (/** @type {string} */ name) => {
        delete attrs[name]
      },
    },
  }

  applyTheme(fakeDoc, 'light')
  assert.equal(attrs['data-theme'], 'light')

  applyTheme(fakeDoc, 'dark')
  assert.equal(attrs['data-theme'], 'dark')

  applyTheme(fakeDoc, 'auto')
  assert.equal(attrs['data-theme'], undefined)

  // Null/undefined doc should not throw
  assert.doesNotThrow(() => applyTheme(null, 'light'))
  assert.doesNotThrow(() => applyTheme({}, 'dark'))
})

test('applyTheme updates and restores theme-color meta tags', () => {
  const lightMeta = {
    attrs: { name: 'theme-color', media: '(prefers-color-scheme: light)', content: THEME_COLOR_LIGHT },
    getAttribute(/** @type {string} */ k) {
      return this.attrs[k]
    },
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) {
      this.attrs[k] = v
    },
  }
  const darkMeta = {
    attrs: { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: THEME_COLOR_DARK },
    getAttribute(/** @type {string} */ k) {
      return this.attrs[k]
    },
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) {
      this.attrs[k] = v
    },
  }

  const fakeDoc = {
    documentElement: {
      setAttribute: () => {},
      removeAttribute: () => {},
    },
    querySelectorAll: (/** @type {string} */ sel) => {
      if (sel === 'meta[name="theme-color"]') return [lightMeta, darkMeta]
      return []
    },
  }

  // Forced light
  applyTheme(fakeDoc, 'light')
  assert.equal(lightMeta.attrs.content, THEME_COLOR_LIGHT)
  assert.equal(darkMeta.attrs.content, THEME_COLOR_LIGHT)

  // Forced dark
  applyTheme(fakeDoc, 'dark')
  assert.equal(lightMeta.attrs.content, THEME_COLOR_DARK)
  assert.equal(darkMeta.attrs.content, THEME_COLOR_DARK)

  // Restored to auto
  applyTheme(fakeDoc, 'auto')
  assert.equal(lightMeta.attrs.content, THEME_COLOR_LIGHT)
  assert.equal(darkMeta.attrs.content, THEME_COLOR_DARK)
})

test('describe provides accurate mode and next action labels', () => {
  const autoDesc = describe('auto')
  assert.match(autoDesc, /Auto/)
  assert.match(autoDesc, /Light/)

  const lightDesc = describe('light')
  assert.match(lightDesc, /Light/)
  assert.match(lightDesc, /Dark/)

  const darkDesc = describe('dark')
  assert.match(darkDesc, /Dark/)
  assert.match(darkDesc, /Auto/)
})
