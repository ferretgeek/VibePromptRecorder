import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  create: vi.fn<() => Promise<unknown>>(),
  destroy: vi.fn<() => Promise<void>>(),
  markdownUpdated: null as null | ((markdown: string, previous: string) => void),
  transaction: null as null | (() => void),
}))

vi.mock('@milkdown/crepe', () => {
  class CrepeMock {
    static Feature = {
      AI: 'AI',
      Latex: 'Latex',
      ImageBlock: 'ImageBlock',
      TopBar: 'TopBar',
      BlockEdit: 'BlockEdit',
      Toolbar: 'Toolbar',
      CodeMirror: 'CodeMirror',
      Table: 'Table',
      Placeholder: 'Placeholder',
    }

    editor = {
      config: (
        configure: (context: {
          update: (key: unknown, updater: (plugins: unknown[]) => unknown[]) => void
        }) => void,
      ) => {
        configure({
          update: (_key, updater) => {
            const plugin = updater([])[0] as {
              spec?: {
                state?: {
                  apply?: (
                    transaction: { docChanged: boolean; getMeta: () => unknown },
                    value: null,
                  ) => null
                }
              }
            }
            lifecycle.transaction = () => {
              plugin.spec?.state?.apply?.({ docChanged: true, getMeta: () => undefined }, null)
            }
          },
        })
      },
    }

    on(
      register: (listener: {
        markdownUpdated: (
          callback: (_context: unknown, markdown: string, previous: string) => void,
        ) => void
      }) => void,
    ) {
      register({
        markdownUpdated: (callback) => {
          lifecycle.markdownUpdated = (markdown, previous) => callback(null, markdown, previous)
        },
      })
    }

    create() {
      return lifecycle.create()
    }

    destroy() {
      return lifecycle.destroy()
    }
  }

  return { Crepe: CrepeMock }
})

import { WysiwygEditor } from './WysiwygEditor'

describe('WysiwygEditor lifecycle', () => {
  beforeEach(() => {
    lifecycle.create.mockReset().mockResolvedValue(undefined)
    lifecycle.destroy.mockReset().mockResolvedValue(undefined)
    lifecycle.markdownUpdated = null
    lifecycle.transaction = null
  })

  it('创建完成后接受没有 DOM 输入事件的菜单式文档更新', async () => {
    let finishCreate!: () => void
    lifecycle.create.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = () => resolve(undefined)
      }),
    )
    const onChange = vi.fn()
    render(<WysiwygEditor value="原文" onChange={onChange} onCompositionChange={vi.fn()} />)

    lifecycle.transaction?.()
    lifecycle.markdownUpdated?.('初始化规范化', '原文')
    expect(onChange).not.toHaveBeenCalled()
    await act(() => {
      finishCreate()
      return Promise.resolve()
    })
    lifecycle.transaction?.()
    lifecycle.markdownUpdated?.('通过加号菜单插入代码块', '原文')
    expect(onChange).toHaveBeenCalledWith('通过加号菜单插入代码块')
  })

  it('捕获 create rejection 并保留源码回退提示', async () => {
    lifecycle.create.mockRejectedValue(new Error('create failed'))
    const lifecycleError = vi.fn()

    render(
      <WysiwygEditor
        value="原文"
        onChange={vi.fn()}
        onCompositionChange={vi.fn()}
        onLifecycleError={lifecycleError}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('原始 Markdown 没有被改写')
    expect(lifecycleError).toHaveBeenCalledWith(expect.stringContaining('create failed'))
  })

  it('卸载时复位 composition，等待 create 成功后销毁并捕获 rejection', async () => {
    let finishCreate!: () => void
    lifecycle.create.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = () => resolve(undefined)
      }),
    )
    lifecycle.destroy.mockRejectedValue(new Error('destroy failed'))
    const composition = vi.fn()
    const lifecycleError = vi.fn()
    const view = render(
      <WysiwygEditor
        value="原文"
        onChange={vi.fn()}
        onCompositionChange={composition}
        onLifecycleError={lifecycleError}
      />,
    )
    const editor = view.container.querySelector('.wysiwyg-editor')!
    fireEvent.compositionStart(editor)
    expect(composition).toHaveBeenLastCalledWith(true)

    view.unmount()
    expect(composition).toHaveBeenLastCalledWith(false)
    expect(lifecycle.destroy).not.toHaveBeenCalled()

    await act(() => {
      finishCreate()
      return Promise.resolve()
    })
    await waitFor(() => expect(lifecycle.destroy).toHaveBeenCalledOnce())
    expect(lifecycleError).toHaveBeenCalledWith(expect.stringContaining('destroy failed'))
  })
})
