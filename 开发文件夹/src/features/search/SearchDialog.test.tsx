import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { caseInsensitiveUtf16Range } from '../../lib/markdown'
import { useAppStore } from '../../stores/appStore'
import type { SearchResult } from '../../types'
import { SearchDialog } from './SearchDialog'

const originalActions = {
  flushActive: useAppStore.getState().flushActive,
  loadProject: useAppStore.getState().loadProject,
  selectRound: useAppStore.getState().selectRound,
}

afterEach(() => {
  useAppStore.setState({ ...originalActions, searchOpen: false })
})

describe('SearchDialog 打开结果', () => {
  it('使用当前完整正文和当前 query 重算 UTF-16 match range', async () => {
    const completeContent = '😀 prefix Needle suffix'
    const result: SearchResult = {
      projectId: 'project-result',
      projectName: '搜索项目',
      roundId: 'round-result',
      status: 'final',
      position: 0,
      note: '',
      excerpt: '有界摘要 needle',
      // 模拟后端摘要坐标；前端不能直接使用这组过期范围。
      matchStart: 0,
      matchEnd: 1,
      matchField: 'content',
      updatedAt: 1,
    }
    vi.spyOn(api, 'searchAll').mockResolvedValue([result])
    useAppStore.setState({
      searchOpen: true,
      selectedProjectId: 'origin-project',
      selectedRoundId: 'origin-round',
      editorMode: 'wysiwyg',
      editorContent: '原点正文',
      flushActive: vi.fn(() => Promise.resolve(true)),
      loadProject: vi.fn((projectId: string) => {
        useAppStore.setState({ selectedProjectId: projectId })
        return Promise.resolve()
      }),
      selectRound: vi.fn((roundId: string) => {
        useAppStore.setState({
          selectedRoundId: roundId,
          editorContent: completeContent,
          detailOpen: true,
        })
        return Promise.resolve()
      }),
    })

    render(<SearchDialog />)
    fireEvent.change(screen.getByRole('searchbox', { name: '全文搜索' }), {
      target: { value: 'needle' },
    })
    const option = await screen.findByRole('option')
    fireEvent.click(option)

    await waitFor(() => expect(useAppStore.getState().searchOpen).toBe(false))
    const expected = caseInsensitiveUtf16Range(completeContent, 'needle')!
    expect(useAppStore.getState()).toMatchObject({
      editorMode: 'source',
      cursorAnchor: expected.start,
      cursorHead: expected.end,
    })
    expect(expected).not.toEqual({ start: result.matchStart, end: result.matchEnd })
  })
})
