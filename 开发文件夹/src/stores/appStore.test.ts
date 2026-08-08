import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { DEFAULT_SETTINGS, type RoundDetail } from '../types'
import { clearStructuralUndoHistory, STRUCTURAL_UNDO_BUDGET_BYTES, useAppStore } from './appStore'

beforeEach(() => {
  clearStructuralUndoHistory()
  useAppStore.setState({ dataChangeSequence: 0 })
})

const databaseRound: RoundDetail = {
  id: 'round-1',
  projectId: 'project-1',
  position: 2_147_483_647,
  status: 'draft',
  contentMd: '数据库版本',
  createdAt: 1,
  finalizedAt: null,
  updatedAt: 2,
  revision: 2,
  note: '数据库备注',
}

function summary(round: RoundDetail) {
  return {
    id: round.id,
    projectId: round.projectId,
    position: round.position,
    status: round.status,
    previewMd: round.contentMd,
    createdAt: round.createdAt,
    finalizedAt: round.finalizedAt,
    updatedAt: round.updatedAt,
    revision: round.revision,
    note: round.note,
    charCount: [...round.contentMd].length,
  }
}

describe('appStore 导航 generation', () => {
  it('项目加载被选轮请求取代时由当前 generation 对称清理 loading 与编辑锁', async () => {
    let resolveRounds!: (rounds: []) => void
    const delayedRounds = new Promise<[]>((resolve) => {
      resolveRounds = resolve
    })
    let resolveDetail!: (detail: RoundDetail) => void
    const delayedDetail = new Promise<RoundDetail>((resolve) => {
      resolveDetail = resolve
    })
    const selectedDetail = {
      ...databaseRound,
      id: 'round-new',
      projectId: 'project-old',
      contentMd: '新轮次',
    }
    useAppStore.setState({
      loading: false,
      selectedProjectId: 'project-old',
      selectedRoundId: 'round-old',
      activeRound: null,
      rounds: [],
      editorContent: '',
      editorNote: '',
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    vi.spyOn(api, 'openProject').mockResolvedValue(undefined)
    vi.spyOn(api, 'listRounds').mockReturnValue(delayedRounds)
    vi.spyOn(api, 'getViewState').mockResolvedValue(null)
    vi.spyOn(api, 'getRound').mockReturnValue(delayedDetail)
    vi.spyOn(api, 'saveViewState').mockResolvedValue(undefined)

    const oldNavigation = useAppStore.getState().loadProject('project-delayed')
    await vi.waitFor(() => expect(api.listRounds).toHaveBeenCalledWith('project-delayed'))
    const currentNavigation = useAppStore.getState().selectRound(selectedDetail.id)
    await vi.waitFor(() => expect(api.getRound).toHaveBeenCalledWith(selectedDetail.id))

    // 旧 generation 先返回时不得释放新选轮请求仍持有的锁。
    resolveRounds([])
    await oldNavigation
    expect(useAppStore.getState()).toMatchObject({
      loading: true,
      contentTransitionLocked: true,
      selectedRoundId: 'round-old',
    })

    // 当前 generation 完成后对称清掉 inherited loading 与编辑锁。
    resolveDetail(selectedDetail)
    await currentNavigation
    expect(useAppStore.getState()).toMatchObject({
      loading: false,
      contentTransitionLocked: false,
      selectedRoundId: selectedDetail.id,
    })
  })

  it('当前选轮请求失败时也在 finally 释放两种导航状态', async () => {
    useAppStore.setState({
      loading: true,
      selectedRoundId: 'round-old',
      activeRound: null,
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    vi.spyOn(api, 'getRound').mockRejectedValue(new Error('读取失败'))

    await useAppStore.getState().selectRound('round-missing')

    expect(useAppStore.getState()).toMatchObject({
      loading: false,
      contentTransitionLocked: false,
    })
  })
})

describe('appStore 删除轮次', () => {
  it('目标不存在时在 flush 和加锁前退出', async () => {
    useAppStore.setState({
      rounds: [],
      selectedRoundId: 'missing',
      contentTransitionLocked: false,
      activeRound: databaseRound,
      editSequence: 1,
      persistedSequence: 0,
    })
    const save = vi.spyOn(api, 'saveRound')

    await useAppStore.getState().deleteRound('missing')

    expect(save).not.toHaveBeenCalled()
    expect(useAppStore.getState().contentTransitionLocked).toBe(false)
  })

  it('草稿快照读取失败时不删除且通过 finally 解锁', async () => {
    useAppStore.setState({
      rounds: [
        {
          id: databaseRound.id,
          projectId: databaseRound.projectId,
          position: databaseRound.position,
          status: databaseRound.status,
          previewMd: databaseRound.contentMd,
          createdAt: databaseRound.createdAt,
          finalizedAt: databaseRound.finalizedAt,
          updatedAt: databaseRound.updatedAt,
          revision: databaseRound.revision,
          note: databaseRound.note,
          charCount: databaseRound.contentMd.length,
        },
      ],
      selectedProjectId: databaseRound.projectId,
      selectedRoundId: databaseRound.id,
      activeRound: databaseRound,
      editorContent: databaseRound.contentMd,
      editorNote: databaseRound.note,
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    vi.spyOn(api, 'getRound').mockRejectedValue(new Error('快照读取失败'))
    const remove = vi.spyOn(api, 'deleteRound')

    await useAppStore.getState().deleteRound(databaseRound.id)

    expect(remove).not.toHaveBeenCalled()
    expect(useAppStore.getState().contentTransitionLocked).toBe(false)
  })

  it('删除选中的最后一个正式轮后选择上一正式轮而不是草稿', async () => {
    const first = {
      ...databaseRound,
      id: 'final-first',
      position: 0,
      status: 'final' as const,
      contentMd: '第一轮',
      finalizedAt: 2,
    }
    const last = {
      ...first,
      id: 'final-last',
      position: 1,
      contentMd: '最后一轮',
    }
    const draft = {
      ...databaseRound,
      id: 'draft-current',
      contentMd: '',
      note: '',
    }
    useAppStore.setState({
      rounds: [summary(first), summary(last), summary(draft)],
      selectedProjectId: databaseRound.projectId,
      selectedRoundId: last.id,
      activeRound: last,
      editorContent: last.contentMd,
      editorNote: last.note,
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    vi.spyOn(api, 'deleteRound').mockResolvedValue(undefined)
    vi.spyOn(api, 'listRounds').mockResolvedValue([summary(first), summary(draft)])
    vi.spyOn(api, 'getRound').mockResolvedValue(first)
    vi.spyOn(api, 'listProjects').mockResolvedValue([])
    vi.spyOn(api, 'saveViewState').mockResolvedValue(undefined)

    await useAppStore.getState().deleteRound(last.id)

    expect(useAppStore.getState()).toMatchObject({
      selectedRoundId: first.id,
      editorContent: first.contentMd,
      contentTransitionLocked: false,
    })
  })

  it('删除未选中的正式轮不会改变当前编辑轮次', async () => {
    const selected = {
      ...databaseRound,
      id: 'selected-final',
      position: 0,
      status: 'final' as const,
      contentMd: '保持选中',
      finalizedAt: 2,
    }
    const removed = {
      ...selected,
      id: 'removed-final',
      position: 1,
      contentMd: '删除目标',
    }
    const draft = { ...databaseRound, id: 'remaining-draft', contentMd: '', note: '' }
    useAppStore.setState({
      rounds: [summary(selected), summary(removed), summary(draft)],
      selectedProjectId: databaseRound.projectId,
      selectedRoundId: selected.id,
      activeRound: selected,
      editorContent: selected.contentMd,
      editorNote: selected.note,
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    vi.spyOn(api, 'deleteRound').mockResolvedValue(undefined)
    vi.spyOn(api, 'listRounds').mockResolvedValue([summary(selected), summary(draft)])
    const getRound = vi.spyOn(api, 'getRound')
    vi.spyOn(api, 'listProjects').mockResolvedValue([])

    await useAppStore.getState().deleteRound(removed.id)

    expect(getRound).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({
      selectedRoundId: selected.id,
      editorContent: selected.contentMd,
    })
  })
})

describe('appStore 视图状态', () => {
  it('同一轮重新展开详情时立即持久化视图状态', async () => {
    useAppStore.setState({
      selectedProjectId: databaseRound.projectId,
      selectedRoundId: databaseRound.id,
      activeRound: databaseRound,
      detailOpen: false,
    })
    const save = vi.spyOn(api, 'saveViewState').mockResolvedValue(undefined)

    await useAppStore.getState().selectRound(databaseRound.id, true)

    expect(useAppStore.getState().detailOpen).toBe(true)
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      selectedRoundId: databaseRound.id,
      detailOpen: true,
    })
  })
})

describe('appStore 结构撤销预算', () => {
  it('总快照超过约 64 MiB 时淘汰最旧操作', async () => {
    useAppStore.setState({ selectedProjectId: 'budget-project', undoAction: null, toast: null })
    const actions = Array.from({ length: 5 }, () => vi.fn(() => Promise.resolve()))
    for (const action of actions) {
      useAppStore
        .getState()
        .pushStructuralUndo('budget-project', '预算测试', action, STRUCTURAL_UNDO_BUDGET_BYTES / 4)
    }

    for (let index = 0; index < 4; index += 1) await useAppStore.getState().undoLast()

    expect(actions[0]).not.toHaveBeenCalled()
    expect(actions.slice(1).every((action) => action.mock.calls.length === 1)).toBe(true)
  })
})

describe('appStore 冲突恢复', () => {
  beforeEach(() => {
    useAppStore.setState({
      rounds: [],
      selectedProjectId: 'project-1',
      selectedRoundId: 'round-1',
      activeRound: { ...databaseRound, contentMd: '初始版本', revision: 0 },
      editorContent: '保存请求快照',
      editorNote: '旧备注',
      editSequence: 1,
      persistedSequence: 0,
      saveState: 'pending',
      saveError: null,
      revisionConflict: null,
      contentTransitionLocked: false,
      toast: null,
    })
  })

  it('保留读取冲突详情期间继续输入的最新内容', async () => {
    let resolveDatabaseRound!: (round: RoundDetail) => void
    const databaseRoundPromise = new Promise<RoundDetail>((resolve) => {
      resolveDatabaseRound = resolve
    })
    vi.spyOn(api, 'saveRound').mockRejectedValue(new Error('REVISION_CONFLICT:round-1'))
    vi.spyOn(api, 'getRound').mockReturnValue(databaseRoundPromise)

    const saving = useAppStore.getState().flushActive()
    await vi.waitFor(() => expect(api.getRound).toHaveBeenCalledWith('round-1'))
    useAppStore.getState().updateEditorContent('等待期间的新输入')
    useAppStore.getState().updateEditorNote('新备注')
    resolveDatabaseRound(databaseRound)

    await expect(saving).resolves.toBe(false)
    expect(useAppStore.getState().revisionConflict).toMatchObject({
      localContent: '等待期间的新输入',
      localNote: '新备注',
    })
    await expect(useAppStore.getState().flushActive()).resolves.toBe(false)
    expect(api.saveRound).toHaveBeenCalledTimes(1)

    const resolved = {
      ...databaseRound,
      id: 'recovered-round',
      contentMd: '等待期间的新输入',
      note: '新备注',
      revision: 3,
    }
    vi.spyOn(api, 'resolveConflictKeepBoth').mockResolvedValue(resolved)
    vi.spyOn(api, 'listRounds').mockResolvedValue([])
    vi.spyOn(api, 'listProjects').mockResolvedValue([])

    await useAppStore.getState().resolveRevisionConflict('keep-both')

    expect(api.resolveConflictKeepBoth).toHaveBeenCalledWith(
      'round-1',
      '等待期间的新输入',
      '新备注',
    )
    expect(useAppStore.getState()).toMatchObject({
      editorContent: '等待期间的新输入',
      revisionConflict: null,
      contentTransitionLocked: false,
    })
  })
})

describe('appStore 设置保存', () => {
  beforeEach(() => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  it('合并并串行保存快速连续的独立字段修改', async () => {
    let finishFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const save = vi
      .spyOn(api, 'saveSettings')
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce(undefined)

    const themeWrite = useAppStore.getState().updateSettings({ theme: 'graphite' })
    const topWrite = useAppStore.getState().updateSettings({ alwaysOnTop: true })

    expect(useAppStore.getState().settings).toMatchObject({
      theme: 'graphite',
      alwaysOnTop: true,
    })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    finishFirst()
    await Promise.all([themeWrite, topWrite])

    expect(save).toHaveBeenNthCalledWith(1, { theme: 'graphite' })
    expect(save).toHaveBeenNthCalledWith(2, { alwaysOnTop: true })
  })

  it('连续两个同字段写入都失败时恢复最后确认值', async () => {
    vi.spyOn(api, 'saveSettings')
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockRejectedValueOnce(new Error('第二次失败'))

    const first = useAppStore.getState().updateSettings({ theme: 'warm' })
    const second = useAppStore.getState().updateSettings({ theme: 'graphite' })
    await expect(first).rejects.toThrow('第一次失败')
    await expect(second).rejects.toThrow('第二次失败')
    expect(useAppStore.getState().settings.theme).toBe(DEFAULT_SETTINGS.theme)
  })

  it('单次保存失败时恢复提交前的设置', async () => {
    vi.spyOn(api, 'saveSettings').mockRejectedValueOnce(new Error('写入失败'))

    await expect(useAppStore.getState().updateSettings({ theme: 'graphite' })).rejects.toThrow(
      '写入失败',
    )
    expect(useAppStore.getState().settings.theme).toBe(DEFAULT_SETTINGS.theme)
  })

  it('通过设置 patch 切换原生置顶并在失败时恢复关闭态', async () => {
    const saveSettings = vi
      .spyOn(api, 'saveSettings')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('窗口拒绝操作'))

    await useAppStore.getState().setAlwaysOnTop(true)
    expect(saveSettings).toHaveBeenCalledWith({ alwaysOnTop: true })
    expect(useAppStore.getState().settings.alwaysOnTop).toBe(true)

    await expect(useAppStore.getState().setAlwaysOnTop(false)).rejects.toThrow('窗口拒绝操作')
    expect(useAppStore.getState().settings.alwaysOnTop).toBe(true)
  })
})

describe('appStore 完成轮次', () => {
  it('慢保存期间继续接收输入并在切换前追上最新内容', async () => {
    let resolveFirstSave!: (value: {
      revision: number
      savedAt: number
      databaseBytes: number
    }) => void
    const firstSave = new Promise<{
      revision: number
      savedAt: number
      databaseBytes: number
    }>((resolve) => {
      resolveFirstSave = resolve
    })
    const nextDraft = {
      ...databaseRound,
      id: 'round-next',
      contentMd: '',
      note: '',
      revision: 0,
      updatedAt: 5,
    }
    useAppStore.setState({
      selectedProjectId: databaseRound.projectId,
      selectedRoundId: databaseRound.id,
      activeRound: databaseRound,
      rounds: [summary(databaseRound)],
      editorContent: '保存前内容',
      editorNote: '',
      editSequence: 1,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    const save = vi
      .spyOn(api, 'saveRound')
      .mockReturnValueOnce(firstSave)
      .mockResolvedValueOnce({ revision: 4, savedAt: 4, databaseBytes: 1024 })
    const finalize = vi.spyOn(api, 'finalizeDraft').mockResolvedValue({
      finalizedRound: { ...databaseRound, status: 'final' },
      draft: nextDraft,
    })
    vi.spyOn(api, 'listRounds').mockResolvedValue([])
    vi.spyOn(api, 'listProjects').mockResolvedValue([])

    const completing = useAppStore.getState().finalizeActiveDraft()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(useAppStore.getState().contentTransitionLocked).toBe(false)
    useAppStore.getState().updateEditorContent('保存期间继续输入')
    expect(useAppStore.getState().editorContent).toBe('保存期间继续输入')

    resolveFirstSave({ revision: 3, savedAt: 3, databaseBytes: 1024 })
    await completing

    expect(save).toHaveBeenNthCalledWith(2, databaseRound.id, '保存期间继续输入', '', 3)
    expect(finalize).toHaveBeenCalledOnce()
    expect(useAppStore.getState().activeRound?.id).toBe(nextDraft.id)
  })

  it('并发触发时只提交一次完成请求', async () => {
    const nextDraft = {
      ...databaseRound,
      id: 'round-2',
      contentMd: '',
      note: '',
      revision: 0,
      updatedAt: 3,
    }
    useAppStore.setState({
      selectedProjectId: 'project-1',
      selectedRoundId: databaseRound.id,
      activeRound: databaseRound,
      rounds: [],
      editorContent: databaseRound.contentMd,
      editorNote: databaseRound.note,
      editSequence: 0,
      persistedSequence: 0,
      contentTransitionLocked: false,
    })
    const finalize = vi.spyOn(api, 'finalizeDraft').mockResolvedValue({
      finalizedRound: { ...databaseRound, status: 'final' },
      draft: nextDraft,
    })
    vi.spyOn(api, 'listRounds').mockResolvedValue([])
    vi.spyOn(api, 'listProjects').mockResolvedValue([])

    const first = useAppStore.getState().finalizeActiveDraft()
    const second = useAppStore.getState().finalizeActiveDraft()
    await Promise.all([first, second])

    expect(finalize).toHaveBeenCalledOnce()
    expect(useAppStore.getState().activeRound?.id).toBe('round-2')
    expect(useAppStore.getState().contentTransitionLocked).toBe(false)
    expect(useAppStore.getState().dataChangeSequence).toBe(1)
  })
})

describe('appStore 自动备份变更序列', () => {
  it('正文保存与实质设置写入递增，而最近项目视图写入不递增', async () => {
    useAppStore.setState({
      activeRound: { ...databaseRound, revision: 0 },
      editorContent: '新正文',
      editorNote: '',
      editSequence: 1,
      persistedSequence: 0,
      settings: { ...DEFAULT_SETTINGS },
      dataChangeSequence: 0,
    })
    vi.spyOn(api, 'saveRound').mockResolvedValue({
      revision: 1,
      savedAt: 3,
      databaseBytes: 1024,
    })
    vi.spyOn(api, 'saveSettings').mockResolvedValue(undefined)

    await useAppStore.getState().flushActive()
    await useAppStore.getState().updateSettings({ lastProjectId: 'project-2' })
    await useAppStore.getState().updateSettings({ theme: 'warm' })

    expect(useAppStore.getState().dataChangeSequence).toBe(2)
  })
})
