import { Crepe } from '@milkdown/crepe'
import { prosePluginsCtx } from '@milkdown/kit/core'
import {
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from '@milkdown/kit/prose/commands'
import { splitListItem } from '@milkdown/kit/prose/schema-list'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { useEffect, useRef, useState } from 'react'

interface WysiwygEditorProps {
  value: string
  onChange: (value: string) => void
  onCompositionChange: (composing: boolean) => void
  onLifecycleError?: (message: string) => void
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function WysiwygEditor({
  value,
  onChange,
  onCompositionChange,
  onLifecycleError,
}: WysiwygEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const onCompositionChangeRef = useRef(onCompositionChange)
  const onLifecycleErrorRef = useRef(onLifecycleError)
  const composingRef = useRef(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onCompositionChangeRef.current = onCompositionChange
  }, [onCompositionChange])

  useEffect(() => {
    onLifecycleErrorRef.current = onLifecycleError
  }, [onLifecycleError])

  useEffect(() => {
    if (!rootRef.current) return
    const root = rootRef.current
    let destroyed = false
    // markdownUpdated 有 200 ms 防抖，初始化事务可能在 create() resolve 后才回调。
    // 在 ProseMirror 事务发生时判定生命周期：create 前的规范化事务忽略，
    // create 后任何 docChanged（含菜单命令和块拖拽）都接收，不依赖 DOM 事件。
    let acceptUserTransactions = false
    let hasUserDocumentChange = false
    const reportCreateError = (error: unknown) => {
      const message = errorMessage(error, '所见即所得编辑器加载失败')
      if (!destroyed) setFailed(message)
      onLifecycleErrorRef.current?.(`所见即所得编辑器创建失败：${message}`)
    }
    const reportDestroyError = (error: unknown) => {
      const message = errorMessage(error, '未知销毁错误')
      onLifecycleErrorRef.current?.(`所见即所得编辑器销毁失败：${message}`)
    }

    let editor: Crepe | null = null
    let creation: Promise<unknown> | null = null
    try {
      editor = new Crepe({
        root,
        defaultValue: value,
        features: {
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.ImageBlock]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.BlockEdit]: true,
          [Crepe.Feature.Toolbar]: true,
          [Crepe.Feature.CodeMirror]: true,
          [Crepe.Feature.Table]: true,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: '写下这一轮要交给 AI 或编程工具的提示词…',
            mode: 'block',
          },
          [Crepe.Feature.BlockEdit]: {
            advancedGroup: {
              label: '高级内容',
              image: null,
              codeBlock: { label: '代码块' },
              table: { label: '表格' },
              math: null,
            },
          },
        },
      })
      editor.editor.config((context) => {
        context.update(prosePluginsCtx, (plugins) => {
          const documentChangeTracker = new Plugin({
            state: {
              init: () => null,
              apply: (transaction, pluginState) => {
                if (
                  acceptUserTransactions &&
                  transaction.docChanged &&
                  transaction.getMeta('addToHistory') !== false
                ) {
                  hasUserDocumentChange = true
                }
                return pluginState
              },
            },
          })
          const lineBreakKeys = new Plugin({
            props: {
              handleKeyDown: (view, event) => {
                if (
                  event.key !== 'Enter' ||
                  event.altKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  event.isComposing
                ) {
                  return false
                }

                if (event.ctrlKey) {
                  const listItem = view.state.schema.nodes.list_item
                  if (listItem && splitListItem(listItem)(view.state, view.dispatch, view)) {
                    return true
                  }
                  return chainCommands(
                    newlineInCode,
                    createParagraphNear,
                    liftEmptyBlock,
                    splitBlock,
                  )(view.state, view.dispatch, view)
                }

                const { selection, schema, tr } = view.state
                const hardbreak = schema.nodes.hardbreak
                if (
                  !(selection instanceof TextSelection) ||
                  !hardbreak ||
                  selection.$from.parent.type.spec.code
                ) {
                  return false
                }
                view.dispatch(
                  tr
                    .setMeta('hardbreak', true)
                    .replaceSelectionWith(hardbreak.create({ isInline: false }))
                    .scrollIntoView(),
                )
                return true
              },
            },
          })

          // 键盘规则必须排在编辑器内置 Enter keymap 之前；变更追踪放在最前，
          // 继续覆盖菜单命令、拖拽和键盘输入产生的全部文档事务。
          return [documentChangeTracker, lineBreakKeys, ...plugins]
        })
      })
      editor.on((listener) => {
        listener.markdownUpdated((_context, markdown, previous) => {
          const userChanged = hasUserDocumentChange
          hasUserDocumentChange = false
          if (userChanged && markdown !== previous) onChangeRef.current(markdown)
        })
      })
      creation = Promise.resolve(editor.create())
      void creation.then(() => {
        if (!destroyed) acceptUserTransactions = true
      }, reportCreateError)
    } catch (error) {
      reportCreateError(error)
    }

    return () => {
      destroyed = true
      acceptUserTransactions = false
      hasUserDocumentChange = false
      if (composingRef.current) {
        composingRef.current = false
        onCompositionChangeRef.current(false)
      }
      // Milkdown 只在 create 成功后销毁；卸载发生在创建期间时等待该 Promise，
      // 并显式捕获 destroy 的同步异常或 rejection，避免未处理 Promise。
      if (editor && creation) {
        const createdEditor = editor
        void creation.then(
          async () => {
            try {
              await createdEditor.destroy()
            } catch (error) {
              reportDestroyError(error)
            }
          },
          () => undefined,
        )
      }
    }
    // Editor lifetime is bound to the active round via the component key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) {
    return (
      <div className="editor-fallback" role="alert">
        <strong>所见即所得编辑器未能安全加载</strong>
        <p>原始 Markdown 没有被改写。请切换到源码模式继续编辑。</p>
        <details>
          <summary>技术详情</summary>
          <code>{failed}</code>
        </details>
      </div>
    )
  }

  return (
    <div
      className="wysiwyg-editor"
      onCompositionStart={() => {
        composingRef.current = true
        onCompositionChangeRef.current(true)
      }}
      onCompositionEnd={() => {
        composingRef.current = false
        onCompositionChangeRef.current(false)
      }}
    >
      <div ref={rootRef} />
    </div>
  )
}
