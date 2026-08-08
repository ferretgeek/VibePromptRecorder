import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type FontFaceInfo } from '../types'
import { ensureImportedFont, loadAppearanceFonts } from './theme'

const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, 'FontFace')
const originalFontSet = Object.getOwnPropertyDescriptor(document, 'fonts')
const loadFont = vi.fn<(face: FontFace) => Promise<FontFace>>()
const addFont = vi.fn()
const deleteFont = vi.fn()
const constructed: FontFace[] = []

class FontFaceMock {
  constructor(
    readonly family: string,
    readonly source: string,
  ) {
    constructed.push(this as unknown as FontFace)
  }

  load(): Promise<FontFace> {
    return loadFont(this as unknown as FontFace)
  }
}

function imported(id: string, available = true): FontFaceInfo {
  return {
    id,
    family: `用户字体-${id}`,
    source: 'imported',
    isMonospace: false,
    weights: [400],
    available,
    url: `asset://font/${id}.woff2`,
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'FontFace', {
    configurable: true,
    value: FontFaceMock,
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: addFont,
      delete: deleteFont,
      ready: Promise.resolve(),
    },
  })
})

beforeEach(() => {
  loadFont.mockReset()
  addFont.mockReset()
  deleteFont.mockReset()
  constructed.length = 0
})

afterAll(() => {
  if (originalFontFace) Object.defineProperty(globalThis, 'FontFace', originalFontFace)
  else Reflect.deleteProperty(globalThis, 'FontFace')
  if (originalFontSet) Object.defineProperty(document, 'fonts', originalFontSet)
  else Reflect.deleteProperty(document, 'fonts')
})

describe('导入字体加载并发', () => {
  it('同一字体的并发请求复用一个 in-flight load', async () => {
    let finish!: (face: FontFace) => void
    loadFont.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const font = imported('dedupe')

    const first = ensureImportedFont(font)
    const second = ensureImportedFont(font)
    finish(constructed[0]!)
    await Promise.all([first, second])

    expect(loadFont).toHaveBeenCalledOnce()
    expect(addFont).toHaveBeenCalledOnce()
  })

  it('加载期间移除字体会阻止迟到结果重新 add', async () => {
    let finish!: (face: FontFace) => void
    loadFont.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const loading = ensureImportedFont(imported('removed-late'))

    await ensureImportedFont(imported('removed-late', false))
    finish(constructed[0]!)
    await loading

    expect(addFont).not.toHaveBeenCalled()
  })

  it('切换选择后卸载不再使用的字体', async () => {
    loadFont.mockImplementation((face) => Promise.resolve(face))
    const first = imported('selected-a')
    const second = imported('selected-b')
    await loadAppearanceFonts([first, second], { ...DEFAULT_SETTINGS, uiFontFamily: first.family })
    const firstFace = constructed.at(-1)

    await loadAppearanceFonts([first, second], { ...DEFAULT_SETTINGS, uiFontFamily: second.family })

    expect(firstFace).toBeDefined()
    expect(deleteFont).toHaveBeenCalledWith(firstFace)
  })

  it('加载失败后移除 in-flight entry 并允许重试', async () => {
    loadFont.mockRejectedValueOnce(new Error('字体损坏'))
    await expect(ensureImportedFont(imported('retry'))).rejects.toThrow('字体损坏')
    loadFont.mockImplementationOnce((face) => Promise.resolve(face))

    await ensureImportedFont(imported('retry'))

    expect(loadFont).toHaveBeenCalledTimes(2)
    expect(addFont).toHaveBeenCalledOnce()
  })
})
