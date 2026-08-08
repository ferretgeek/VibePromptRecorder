import type { AppSettings, FontFaceInfo, ThemeId } from '../types'

interface ImportedFontEntry {
  face: FontFace
  promise: Promise<void>
  added: boolean
  cancelled: boolean
}

const importedFontEntries = new Map<string, ImportedFontEntry>()

export async function ensureImportedFont(font: FontFaceInfo | undefined): Promise<void> {
  if (!font || font.source !== 'imported') return
  const existing = importedFontEntries.get(font.id)
  if (!font.available) {
    if (existing) {
      existing.cancelled = true
      importedFontEntries.delete(font.id)
      if (existing.added) document.fonts.delete(existing.face)
    }
    return
  }
  if (!font.url) return
  if (existing) return existing.promise

  const face = new FontFace(font.family, `url("${font.url}")`, {
    weight:
      font.weights.length > 1
        ? `${Math.min(...font.weights)} ${Math.max(...font.weights)}`
        : String(font.weights[0] ?? 400),
    style: 'normal',
  })
  const entry: ImportedFontEntry = {
    face,
    promise: Promise.resolve(),
    added: false,
    cancelled: false,
  }
  entry.promise = face
    .load()
    .then((loadedFace) => {
      // removeImportedFont 可能在 load() 期间完成；迟到结果不得把已移除字体重新注册。
      if (entry.cancelled || importedFontEntries.get(font.id) !== entry) return
      document.fonts.add(loadedFace)
      entry.added = true
    })
    .catch((error: unknown) => {
      if (importedFontEntries.get(font.id) === entry) importedFontEntries.delete(font.id)
      throw error
    })
  importedFontEntries.set(font.id, entry)
  return entry.promise
}

export async function loadAppearanceFonts(
  fonts: FontFaceInfo[],
  settings: AppSettings,
): Promise<void> {
  const selected = new Set([
    settings.uiFontFamily,
    settings.bodyFontFamily,
    settings.codeFontFamily,
    ...settings.uiFallbackFamilies,
    ...settings.bodyFallbackFamilies,
    ...settings.codeFallbackFamilies,
  ])
  const requiredIds = new Set(
    fonts
      .filter((font) => font.source === 'imported' && font.available && selected.has(font.family))
      .map((font) => font.id),
  )
  for (const [id, entry] of importedFontEntries) {
    if (requiredIds.has(id)) continue
    entry.cancelled = true
    importedFontEntries.delete(id)
    if (entry.added) document.fonts.delete(entry.face)
  }
  await Promise.all(
    fonts
      .filter(
        (font) => (font.source === 'imported' && !font.available) || selected.has(font.family),
      )
      .map((font) => ensureImportedFont(font)),
  )
  await document.fonts.ready
  window.dispatchEvent(new Event('vpr:fonts-ready'))
}

export function resolvedTheme(theme: ThemeId): 'light' | 'dark' {
  if (theme === 'graphite') return 'dark'
  if (theme !== 'system') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function quoteFontFamily(family: string): string {
  const escaped = [...family]
    .map((character) => {
      if (character === '\\') return '\\\\'
      if (character === '"') return '\\"'
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint === 0 || codePoint < 0x20 || codePoint === 0x7f) {
        return `\\${codePoint.toString(16)} `
      }
      return character
    })
    .join('')
  return `"${escaped}"`
}

function cssFontFamily(primary: string, fallbacks: string[], generic: string): string {
  return [primary, ...fallbacks]
    .filter((family, index, values) => family && values.indexOf(family) === index)
    .map(quoteFontFamily)
    .concat(generic)
    .join(', ')
}

export function applyAppearance(settings: AppSettings): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.dataset.resolvedTheme = resolvedTheme(settings.theme)
  root.style.setProperty(
    '--font-ui',
    cssFontFamily(settings.uiFontFamily, settings.uiFallbackFamilies, 'sans-serif'),
  )
  root.style.setProperty(
    '--font-body',
    cssFontFamily(settings.bodyFontFamily, settings.bodyFallbackFamilies, 'sans-serif'),
  )
  root.style.setProperty(
    '--font-code',
    cssFontFamily(settings.codeFontFamily, settings.codeFallbackFamilies, 'monospace'),
  )
  root.style.setProperty('--size-ui', `${settings.uiFontSize}px`)
  root.style.setProperty('--size-body', `${settings.bodyFontSize}px`)
  root.style.setProperty('--size-code', `${settings.codeFontSize}px`)
  root.style.setProperty('--weight-ui', String(settings.uiFontWeight))
  root.style.setProperty('--weight-body', String(settings.bodyFontWeight))
  root.style.setProperty('--weight-code', String(settings.codeFontWeight))
  root.style.setProperty('--line-body', String(settings.bodyLineHeight))
  root.style.setProperty('--line-code', String(settings.codeLineHeight))
}

export function observeSystemTheme(settings: AppSettings): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => {
    if (settings.theme === 'system') applyAppearance(settings)
  }
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
