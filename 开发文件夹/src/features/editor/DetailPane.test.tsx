import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import type { RoundDetail } from '../../types'
import { DetailPane, MARKDOWN_ANALYSIS_DELAY_MS } from './DetailPane'

const activeRound: RoundDetail = {
  id: 'round-focus',
  projectId: 'project-focus',
  position: 1,
  status: 'draft',
  contentMd: '复测内容',
  createdAt: 1,
  finalizedAt: null,
  updatedAt: 2,
  revision: 0,
  note: '',
}

afterEach(() => vi.useRealTimers())

describe('DetailPane', () => {
  it('安全预览可切回所见即所得且切换轮次会退出预览', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      activeRound,
      selectedProjectId: activeRound.projectId,
      selectedRoundId: activeRound.id,
      editorContent: activeRound.contentMd,
      editorNote: '',
      editorMode: 'wysiwyg',
      detailOpen: true,
      contentTransitionLocked: false,
      markdownSafetyPending: true,
    })

    render(<DetailPane onCompositionChange={vi.fn()} />)
    await act(() => vi.advanceTimersByTimeAsync(MARKDOWN_ANALYSIS_DELAY_MS))
    const preview = screen.getByRole('button', { name: '安全预览' })
    const wysiwyg = screen.getByRole('button', { name: '所见即所得' })

    fireEvent.click(preview)
    expect(document.querySelector('.detail-preview-scroll')).not.toBeNull()
    expect(preview).toHaveClass('is-active')
    expect(wysiwyg).not.toHaveClass('is-active')

    fireEvent.click(wysiwyg)
    expect(document.querySelector('.detail-preview-scroll')).toBeNull()
    expect(preview).not.toHaveClass('is-active')

    fireEvent.click(preview)
    act(() => {
      useAppStore.setState({
        activeRound: { ...activeRound, id: 'round-next', contentMd: '下一轮' },
        selectedRoundId: 'round-next',
        editorContent: '下一轮',
      })
    })
    expect(document.querySelector('.detail-preview-scroll')).toBeNull()
    expect(preview).not.toHaveClass('is-active')
  })

  it('大文本安全分析在渲染外防抖且待分析时禁止进入所见即所得', async () => {
    vi.useFakeTimers()
    const largeContent = 'a'.repeat(256 * 1024)
    useAppStore.setState({
      activeRound: { ...activeRound, contentMd: largeContent },
      selectedProjectId: activeRound.projectId,
      selectedRoundId: activeRound.id,
      editorContent: largeContent,
      editorNote: '',
      editorMode: 'wysiwyg',
      detailOpen: true,
      contentTransitionLocked: false,
      markdownSafetyPending: true,
    })

    render(<DetailPane onCompositionChange={vi.fn()} />)
    const wysiwyg = screen.getByRole('button', { name: '所见即所得' })
    expect(wysiwyg).toBeDisabled()
    expect(screen.getByText('正在分析 Markdown 安全性')).toBeInTheDocument()
    expect(screen.getByText('正在加载编辑器…')).toBeInTheDocument()
    expect(document.querySelector('.wysiwyg-editor')).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(wysiwyg).toBeDisabled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(wysiwyg).toBeEnabled()
    expect(useAppStore.getState().markdownSafetyPending).toBe(false)
  })

  it('备注输入法组合期间收起详情会复位全局组合状态', () => {
    useAppStore.setState({
      activeRound,
      selectedProjectId: activeRound.projectId,
      selectedRoundId: activeRound.id,
      editorContent: activeRound.contentMd,
      editorNote: '',
      editorMode: 'source',
      detailOpen: true,
      contentTransitionLocked: false,
    })
    const onCompositionChange = vi.fn()
    render(<DetailPane onCompositionChange={onCompositionChange} />)

    fireEvent.compositionStart(screen.getByRole('textbox', { name: '轮次备注' }))
    fireEvent.click(screen.getByRole('button', { name: '收起详情（Esc）' }))

    expect(screen.getByText('详情已收起')).toBeInTheDocument()
    expect(onCompositionChange).toHaveBeenNthCalledWith(1, true)
    expect(onCompositionChange).toHaveBeenLastCalledWith(false)
  })

  it('点击收起详情后请求把焦点归还给当前时间线卡片', () => {
    useAppStore.setState({
      activeRound,
      selectedProjectId: activeRound.projectId,
      selectedRoundId: activeRound.id,
      editorContent: activeRound.contentMd,
      editorNote: activeRound.note,
      detailOpen: true,
      contentTransitionLocked: false,
    })
    const focusRequest = vi.fn()
    window.addEventListener('vpr:focus-selected-round', focusRequest)

    render(<DetailPane onCompositionChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '收起详情（Esc）' }))

    expect(useAppStore.getState().detailOpen).toBe(false)
    expect(focusRequest).toHaveBeenCalledOnce()
    window.removeEventListener('vpr:focus-selected-round', focusRequest)
  })
})
