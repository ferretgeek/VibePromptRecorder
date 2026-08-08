export type ShortcutAction =
  | 'new-project'
  | 'copy-round'
  | 'save'
  | 'global-search'
  | 'toggle-editor'
  | 'toggle-always-on-top'
  | 'open-settings'
  | 'timeline-top'
  | 'structural-undo'
  | 'cycle-region'
  | 'cycle-region-back'

export interface ShortcutContext {
  composing: boolean
  editorFocused: boolean
  blocked?: boolean
}

export function shortcutAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  context: ShortcutContext,
): ShortcutAction | null {
  if (context.composing || context.blocked) return null
  const key = event.key.toLowerCase()
  if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'n') return 'new-project'
  if (event.ctrlKey && !event.altKey && event.shiftKey && key === 'c') return 'copy-round'
  if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 's') return 'save'
  if (event.ctrlKey && !event.altKey && event.shiftKey && key === 'f') return 'global-search'
  if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'e') return 'toggle-editor'
  if (event.ctrlKey && event.altKey && !event.shiftKey && key === 't') return 'toggle-always-on-top'
  if (event.ctrlKey && !event.altKey && !event.shiftKey && key === ',') return 'open-settings'
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    key === 'home' &&
    !context.editorFocused
  ) {
    return 'timeline-top'
  }
  // 结构撤销：仅当焦点不在文本编辑器时，Ctrl+Z 撤销删除/清空草稿/重排等结构操作；
  // 编辑器内的 Ctrl+Z 交给编辑器自身的文字撤销历史。
  if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'z' && !context.editorFocused) {
    return 'structural-undo'
  }
  // F6 / Shift+F6 主要区域焦点循环（顶部操作栏→项目→时间线→详情）。
  if (key === 'f6' && !event.ctrlKey && !event.altKey) {
    return event.shiftKey ? 'cycle-region-back' : 'cycle-region'
  }
  return null
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.matches('input, textarea, select, [role="textbox"], .cm-editor, .milkdown')
  )
}
