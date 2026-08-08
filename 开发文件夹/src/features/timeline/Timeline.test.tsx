import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useAppStore } from '../../stores/appStore'
import { DEFAULT_SETTINGS, type RoundDetail, type RoundSummary } from '../../types'
import { Timeline } from './Timeline'

vi.mock('react-virtuoso', () => ({
  Virtuoso: () => <div data-testid="virtual-list" />,
}))

const summaries: RoundSummary[] = [
  {
    id: 'first',
    projectId: 'project',
    position: 0,
    status: 'final',
    previewMd: '```ts',
    createdAt: 1,
    finalizedAt: 2,
    updatedAt: 2,
    revision: 0,
    note: '',
    charCount: 23,
  },
  {
    id: 'second',
    projectId: 'project',
    position: 1,
    status: 'final',
    previewMd: '下一轮',
    createdAt: 3,
    finalizedAt: 4,
    updatedAt: 4,
    revision: 0,
    note: '',
    charCount: 3,
  },
]

const details: Record<string, RoundDetail> = {
  first: {
    ...summaries[0]!,
    contentMd: '```ts\nconst open = true',
  },
  second: {
    ...summaries[1]!,
    contentMd: '下一轮原文',
  },
}

beforeEach(() => {
  useAppStore.setState({
    rounds: summaries,
    selectedProjectId: 'project',
    selectedRoundId: 'first',
    timelineAnchorRoundId: 'first',
    timelineAnchorOffsetPx: 0,
    settings: { ...DEFAULT_SETTINGS },
    contentTransitionLocked: false,
    flushActive: vi.fn(() => Promise.resolve(true)),
    toast: null,
  })
  vi.spyOn(api, 'getRound').mockImplementation((id) => Promise.resolve(details[id]!))
})

function choosePlainCopy(): void {
  fireEvent.click(screen.getByRole('button', { name: '选择复制全部格式' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /纯原文拼接/ }))
}

describe('复制全部·纯原文边界确认', () => {
  it('用户取消时不写剪贴板并解释风险', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<Timeline />)

    choosePlainCopy()

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce())
    expect(writeText).not.toHaveBeenCalled()
    expect(useAppStore.getState().toast?.message).toMatch(/已取消纯原文复制/)
  })

  it('用户明确继续时不补围栏、不改写拼接正文', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<Timeline />)

    choosePlainCopy()

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('```ts\nconst open = true\n\n下一轮原文'),
    )
  })
})
