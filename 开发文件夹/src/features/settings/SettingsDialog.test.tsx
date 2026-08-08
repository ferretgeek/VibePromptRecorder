import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useAppStore } from '../../stores/appStore'
import { DEFAULT_SETTINGS, type TrashItem } from '../../types'
import { SettingsDialog } from './SettingsDialog'

const nativeDialog = vi.hoisted(() => ({
  close: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: nativeDialog.close }),
}))

const originalActions = {
  flushActive: useAppStore.getState().flushActive,
  refreshProjects: useAppStore.getState().refreshProjects,
  loadProject: useAppStore.getState().loadProject,
}

const deletedProject: TrashItem = {
  id: 'deleted-project',
  kind: 'project',
  name: '待恢复项目',
  projectId: null,
  deletedAt: 1,
}

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
  nativeDialog.close.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({
    settingsOpen: true,
    settings: { ...DEFAULT_SETTINGS },
    fonts: [],
    dataDir: 'C:\\isolated-data',
    appVersion: '0.1.4',
    projects: [],
    rounds: [],
    selectedProjectId: null,
    selectedRoundId: null,
    toast: null,
    ...originalActions,
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  useAppStore.setState({ settingsOpen: false, ...originalActions })
})

async function openTrash(): Promise<void> {
  vi.spyOn(api, 'listTrash').mockResolvedValue([deletedProject])
  render(<SettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: '数据与备份' }))
  await screen.findByText('待恢复项目')
}

describe('SettingsDialog 数据变更门禁', () => {
  it('当前编辑保存失败时不恢复最近删除内容', async () => {
    const flush = vi.fn(() => Promise.resolve(false))
    useAppStore.setState({ flushActive: flush })
    const restore = vi.spyOn(api, 'restoreProject')
    await openTrash()

    fireEvent.click(screen.getByRole('button', { name: '恢复' }))

    await waitFor(() => expect(flush).toHaveBeenCalledOnce())
    expect(restore).not.toHaveBeenCalled()
    expect(useAppStore.getState().toast?.message).toMatch(/当前内容尚未安全保存，已取消恢复/)
  })

  it('当前编辑保存失败时不执行永久删除', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const flush = vi.fn(() => Promise.resolve(false))
    useAppStore.setState({ flushActive: flush })
    const purge = vi.spyOn(api, 'permanentlyDelete')
    await openTrash()

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))

    await waitFor(() => expect(flush).toHaveBeenCalledOnce())
    expect(purge).not.toHaveBeenCalled()
    expect(useAppStore.getState().toast?.message).toMatch(/当前内容尚未安全保存，已取消永久删除/)
  })
})

describe('SettingsDialog 恢复准备状态机', () => {
  it('用户拒绝立即退出时撤销 prepared 状态而不是留到下次启动', async () => {
    useAppStore.setState({ flushActive: vi.fn(() => Promise.resolve(true)) })
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    vi.spyOn(api, 'prepareBackupRestore').mockResolvedValue({
      restoreId: 'restore-id',
      backupPath: 'C:\\isolated\\backup.vcpbackup',
      recoveryPointPath: 'C:\\isolated\\recovery-before.vcpbackup',
      requiresRestart: true,
    })
    const cancel = vi.spyOn(api, 'cancelPreparedRestore').mockResolvedValue(undefined)
    render(<SettingsDialog />)
    fireEvent.click(screen.getByRole('button', { name: '数据与备份' }))

    fireEvent.click(screen.getByRole('button', { name: /从备份恢复/ }))

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(nativeDialog.close).not.toHaveBeenCalled()
    expect(screen.queryByText('备份恢复已安全准备')).not.toBeInTheDocument()
    expect(useAppStore.getState().toast?.message).toMatch(/已取消本次恢复/)
  })

  it('prepared 状态撤销失败时保持设置和数据操作锁定', async () => {
    useAppStore.setState({ flushActive: vi.fn(() => Promise.resolve(true)) })
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    vi.spyOn(api, 'prepareBackupRestore').mockResolvedValue({
      restoreId: 'restore-id',
      backupPath: 'C:\\isolated\\backup.vcpbackup',
      recoveryPointPath: 'C:\\isolated\\recovery-before.vcpbackup',
      requiresRestart: true,
    })
    vi.spyOn(api, 'cancelPreparedRestore').mockRejectedValue(new Error('磁盘占用'))
    render(<SettingsDialog />)
    fireEvent.click(screen.getByRole('button', { name: '数据与备份' }))

    fireEvent.click(screen.getByRole('button', { name: /从备份恢复/ }))

    expect(await screen.findByText('备份恢复已安全准备')).toBeInTheDocument()
    expect(document.querySelector('.settings-layout')).toHaveAttribute('inert')
    expect(useAppStore.getState().toast?.message).toMatch(/编辑已锁定/)
  })
})
