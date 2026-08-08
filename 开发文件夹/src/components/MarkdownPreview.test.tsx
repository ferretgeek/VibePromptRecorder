import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { MarkdownPreview } from './MarkdownPreview'

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('安全 Markdown 预览', () => {
  it('移除脚本、事件属性与危险协议', () => {
    const { container } = render(
      <MarkdownPreview
        markdown={
          '<script>alert(1)</script>\n<a href="javascript:alert(2)" onclick="alert(3)">危险</a>'
        }
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    const link = screen.getByText('危险').closest('a')
    expect(link).not.toHaveAttribute('href')
    expect(link).not.toHaveAttribute('onclick')
  })

  it('仅保留 code 的 language-* 类并移除应用样式类', () => {
    const { container } = render(
      <MarkdownPreview
        markdown={'<code class="language-ts source-only-notice app-shell">const n = 1</code>'}
        compact
      />,
    )
    const code = container.querySelector('code')
    expect(code).toHaveClass('language-ts')
    expect(code).not.toHaveClass('source-only-notice')
    expect(code).not.toHaveClass('app-shell')
  })

  it('浏览器验收壳不会绕过原生代理直接创建远程图片请求', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = render(
      <MarkdownPreview markdown="![远程图](https://example.com/image.png)" />,
    )
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '临时加载' }))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('安全远程图片加载仅在 Windows 应用中可用')).toBeInTheDocument()
  })

  it('本机图片不能被临时授权', () => {
    const { container } = render(<MarkdownPreview markdown="![秘密](http://127.0.0.1/a.png)" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: '临时加载' })).toBeNull()
    expect(screen.getByText('已阻止本机或内网图片')).toBeInTheDocument()
  })

  it('图片地址变化后忽略旧地址的迟到响应', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let resolveImage!: (value: { dataUrl: string; byteCount: number }) => void
    vi.spyOn(api, 'fetchRemoteImage').mockReturnValue(
      new Promise((resolve) => {
        resolveImage = resolve
      }),
    )
    const view = render(<MarkdownPreview markdown="![旧图](https://old.example.com/image.png)" />)
    fireEvent.click(screen.getByRole('button', { name: '临时加载' }))
    view.rerender(<MarkdownPreview markdown="![新图](https://new.example.com/image.png)" />)
    resolveImage({ dataUrl: 'data:image/png;base64,old', byteCount: 3 })

    await waitFor(() => {
      expect(screen.getByText(/new\.example\.com/)).toBeInTheDocument()
      expect(view.container.querySelector('img')).toBeNull()
    })
  })

  it('单行无语言 fenced code 仍按块级代码渲染', () => {
    const { container } = render(
      <MarkdownPreview markdown={'~~~\nconst answer = 42\n~~~'} compact />,
    )
    expect(container.querySelector('.code-block')).not.toBeNull()
    expect(container.querySelector('.code-block code')).toHaveTextContent('const answer = 42')
  })

  it('折叠预览移除链接和远程图片按钮的键盘交互', () => {
    const { container } = render(
      <MarkdownPreview
        markdown={'[外链](https://example.com)\n\n![远程图](https://example.com/image.png)'}
        compact
      />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(screen.getByText('外链')).toBeInTheDocument()
    expect(screen.getByText('图片：远程图')).toBeInTheDocument()
  })

  it('2 MiB 以上只创建有界纯文本节点而不构建完整 Markdown AST', () => {
    const source = `# 不应渲染成标题\n\n${'a'.repeat(2 * 1024 * 1024)}`
    const { container } = render(<MarkdownPreview markdown={source} />)

    expect(screen.getByText('超大内容已使用有界纯文本预览')).toBeInTheDocument()
    expect(container.querySelector('h1')).toBeNull()
    const excerpt = container.querySelector('.markdown-large-preview__content')
    expect(excerpt?.textContent?.length).toBeLessThanOrEqual(256 * 1024)
  })
})
