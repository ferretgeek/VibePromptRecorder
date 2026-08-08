import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { DEFAULT_SETTINGS, type RoundDetail } from '../types'
import { App } from './App'

vi.mock('../features/editor/DetailPane', () => ({ DetailPane: () => null }))
vi.mock('../features/editor/ConflictDialog', () => ({ ConflictDialog: () => null }))
vi.mock('../features/projects/ProjectSidebar', () => ({ ProjectSidebar: () => null }))
vi.mock('../features/search/SearchDialog', () => ({ SearchDialog: () => null }))
vi.mock('../features/settings/SettingsDialog', () => ({ SettingsDialog: () => null }))
vi.mock('../features/timeline/Timeline', () => ({ Timeline: () => null }))
vi.mock('../components/Toast', () => ({ Toast: () => null }))
vi.mock('./TopBar', () => ({ TopBar: () => null }))
vi.mock('../lib/theme', () => ({
  applyAppearance: vi.fn(),
  loadAppearanceFonts: vi.fn(() => Promise.resolve()),
  observeSystemTheme: vi.fn(() => () => undefined),
}))

const originalInitialize = useAppStore.getState().initialize
const activeRound: RoundDetail = {
  id: 'shortcut-round',
  projectId: 'shortcut-project',
  position: 0,
  status: 'draft',
  contentMd: '待完成内容',
  createdAt: 1,
  finalizedAt: null,
  updatedAt: 1,
  revision: 0,
  note: '',
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({
    initialized: true,
    loading: false,
    fatalError: null,
    selectedProjectId: null,
    activeRound: null,
    settings: { ...DEFAULT_SETTINGS, autoBackup: true },
    editSequence: 0,
    persistedSequence: 0,
    dataChangeSequence: 0,
    initialize: vi.fn(() => Promise.resolve()),
  })
})

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState({ initialize: originalInitialize })
})

describe('自动备份调度', () => {
  it('任意持久化数据变更在编辑已落库后触发一次防抖备份', async () => {
    const backup = vi.spyOn(api, 'runAutoBackup').mockResolvedValue(null)
    useAppStore.setState({ dataChangeSequence: 1 })

    render(<App />)
    await act(() => vi.advanceTimersByTimeAsync(5_000))

    expect(backup).toHaveBeenCalledOnce()
  })

  it('只有视图活动且没有持久化数据变更时不触发备份', async () => {
    const backup = vi.spyOn(api, 'runAutoBackup').mockResolvedValue(null)

    render(<App />)
    await act(() => vi.advanceTimersByTimeAsync(6_000))

    expect(backup).not.toHaveBeenCalled()
  })
})

describe('完成当前轮快捷键', () => {
  it('只在单独按下并松开 Ctrl 时完成当前轮', () => {
    const finalize = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      selectedProjectId: activeRound.projectId,
      activeRound,
      finalizeActiveDraft: finalize,
    })
    render(<App />)

    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true })
    fireEvent.keyUp(document, { key: 'Control' })
    expect(finalize).toHaveBeenCalledOnce()

    finalize.mockClear()
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })
    fireEvent.keyUp(document, { key: 'Enter', ctrlKey: true })
    fireEvent.keyUp(document, { key: 'Control' })
    expect(finalize).not.toHaveBeenCalled()
  })
})
