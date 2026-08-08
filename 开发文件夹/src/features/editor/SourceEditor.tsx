import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'

const externalDocumentSync = Annotation.define<boolean>()

interface SourceEditorProps {
  value: string
  onChange: (value: string) => void
  onCompositionChange: (composing: boolean) => void
  initialSelection?: { anchor: number; head: number }
  onSelectionChange?: (anchor: number, head: number) => void
  wrap: boolean
  ariaLabel?: string
}

export function SourceEditor({
  value,
  onChange,
  onCompositionChange,
  initialSelection,
  onSelectionChange,
  wrap,
  ariaLabel = 'Markdown 源码编辑器',
}: SourceEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onCompositionChangeRef = useRef(onCompositionChange)
  const composingRef = useRef(false)
  const wrapCompartmentRef = useRef(new Compartment())

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  useEffect(() => {
    onCompositionChangeRef.current = onCompositionChange
  }, [onCompositionChange])

  useEffect(() => {
    if (!rootRef.current) return
    const selection = initialSelection
      ? {
          anchor: Math.max(0, Math.min(value.length, initialSelection.anchor)),
          head: Math.max(0, Math.min(value.length, initialSelection.head)),
        }
      : undefined
    const state = EditorState.create({
      doc: value,
      ...(selection ? { selection } : {}),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        // Ctrl+Enter 明确插入一个空行形成新段落；普通 Enter 继续使用
        // CodeMirror 的标准单换行。其余应用级快捷键交由 App 统一处理。
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              view.dispatch(view.state.replaceSelection('\n\n'))
              return true
            },
            preventDefault: true,
          },
          { key: 'Mod-s', run: () => true, preventDefault: true },
          { key: 'Mod-e', run: () => true, preventDefault: true },
          { key: 'Mod-Shift-c', run: () => true, preventDefault: true },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          spellcheck: 'false',
          autocapitalize: 'off',
        }),
        EditorView.updateListener.of((update) => {
          const isExternalSync = update.transactions.some((transaction) =>
            transaction.annotation(externalDocumentSync),
          )
          if (update.docChanged && !isExternalSync) onChangeRef.current(update.state.doc.toString())
          if (update.selectionSet) {
            const selected = update.state.selection.main
            onSelectionChangeRef.current?.(selected.anchor, selected.head)
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { minHeight: '100%' },
        }),
        wrapCompartmentRef.current.of(wrap ? EditorView.lineWrapping : []),
      ],
    })
    const view = new EditorView({ state, parent: rootRef.current })
    viewRef.current = view
    return () => {
      if (composingRef.current) {
        composingRef.current = false
        onCompositionChangeRef.current(false)
      }
      view.destroy()
      viewRef.current = null
    }
    // Recreate only when editor identity/mode changes; parent provides a stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: [Transaction.addToHistory.of(false), externalDocumentSync.of(true)],
    })
  }, [value])

  return (
    <div
      ref={rootRef}
      className="source-editor"
      onCompositionStart={() => {
        composingRef.current = true
        onCompositionChangeRef.current(true)
      }}
      onCompositionEnd={() => {
        composingRef.current = false
        onCompositionChangeRef.current(false)
      }}
    />
  )
}
