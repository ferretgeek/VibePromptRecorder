import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

describe('Dialog', () => {
  it('声明模态语义、陷阱 Tab、支持 Escape 并恢复焦点', () => {
    const onClose = vi.fn()
    const view = render(
      <>
        <button type="button">打开者</button>
        <Dialog open={false} title="测试弹窗" description="说明" onClose={onClose}>
          <button type="button">第一项</button>
          <button type="button">最后一项</button>
        </Dialog>
      </>,
    )
    const opener = screen.getByRole('button', { name: '打开者' })
    opener.focus()
    view.rerender(
      <>
        <button type="button">打开者</button>
        <Dialog open title="测试弹窗" description="说明" onClose={onClose}>
          <button type="button">第一项</button>
          <button type="button">最后一项</button>
        </Dialog>
      </>,
    )
    const dialog = screen.getByRole('dialog', { name: '测试弹窗' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '最后一项' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(
      <>
        <button type="button">打开者</button>
        <Dialog open={false} title="测试弹窗" description="说明" onClose={onClose}>
          <button type="button">第一项</button>
          <button type="button">最后一项</button>
        </Dialog>
      </>,
    )
    expect(opener).toHaveFocus()
  })

  it('优先聚焦显式初始聚焦控件', () => {
    render(
      <Dialog open title="搜索" onClose={() => undefined}>
        <input data-dialog-autofocus aria-label="查询" />
      </Dialog>,
    )
    expect(screen.getByRole('textbox', { name: '查询' })).toHaveFocus()
  })

  it('嵌套弹窗只关闭顶层，并在全部关闭后恢复应用根节点状态', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    const root = document.createElement('div')
    root.id = 'root'
    root.setAttribute('aria-hidden', 'menu')
    document.body.append(root)
    const view = render(
      <>
        <Dialog open title="外层" onClose={closeOuter}>
          <button type="button">外层操作</button>
        </Dialog>
        <Dialog open title="内层" onClose={closeInner}>
          <button type="button">内层操作</button>
        </Dialog>
      </>,
    )

    expect(root).toHaveAttribute('aria-hidden', 'true')
    const outerDialog = screen.getByRole('dialog', { name: '外层', hidden: true })
    const innerDialog = screen.getByRole('dialog', { name: '内层' })
    const outerBackdrop = outerDialog.closest('.dialog-backdrop')
    const innerBackdrop = innerDialog.closest('.dialog-backdrop')
    expect(outerBackdrop).toHaveAttribute('inert')
    expect(outerBackdrop).toHaveAttribute('aria-hidden', 'true')
    expect(outerDialog).not.toHaveAttribute('aria-modal')
    expect(innerBackdrop).not.toHaveAttribute('inert')
    expect(innerDialog).toHaveAttribute('aria-modal', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeInner).toHaveBeenCalledOnce()
    expect(closeOuter).not.toHaveBeenCalled()
    view.rerender(
      <Dialog open title="外层" onClose={closeOuter}>
        <button type="button">外层操作</button>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: '外层' })).toHaveAttribute('aria-modal', 'true')
    expect(
      screen.getByRole('dialog', { name: '外层' }).closest('.dialog-backdrop'),
    ).not.toHaveAttribute('inert')
    view.unmount()
    expect(root).toHaveAttribute('aria-hidden', 'menu')
    root.remove()
  })
})
