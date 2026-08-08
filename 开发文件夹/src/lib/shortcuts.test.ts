import { describe, expect, it } from 'vitest'
import { shortcutAction } from './shortcuts'

const event = (key: string, ctrlKey = false, altKey = false, shiftKey = false) => ({
  key,
  ctrlKey,
  altKey,
  shiftKey,
})

describe('全局快捷键判定', () => {
  it('映射核心快捷键且忽略大小写', () => {
    expect(shortcutAction(event('N', true), { composing: false, editorFocused: false })).toBe(
      'new-project',
    )
    expect(
      shortcutAction(event('Enter', true), { composing: false, editorFocused: true }),
    ).toBeNull()
    expect(
      shortcutAction(event('F', true, false, true), { composing: false, editorFocused: true }),
    ).toBe('global-search')
    expect(shortcutAction(event('t', true, true), { composing: false, editorFocused: false })).toBe(
      'toggle-always-on-top',
    )
  })

  it('中文 IME 组合期间不触发任何全局动作', () => {
    expect(
      shortcutAction(event('Enter', true), { composing: true, editorFocused: true }),
    ).toBeNull()
  })

  it('模态窗口或内容切换期间不触发背景动作', () => {
    expect(
      shortcutAction(event('N', true), {
        composing: false,
        editorFocused: false,
        blocked: true,
      }),
    ).toBeNull()
  })

  it('编辑器内保留 Alt+Home 的文本语义', () => {
    expect(
      shortcutAction(event('Home', false, true), { composing: false, editorFocused: true }),
    ).toBeNull()
    expect(
      shortcutAction(event('Home', false, true), { composing: false, editorFocused: false }),
    ).toBe('timeline-top')
  })
})
