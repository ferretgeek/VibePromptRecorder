import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { browserRepository, resetBrowserRepository } from './browserRepository'

describe('浏览器验收仓库', () => {
  beforeEach(() => resetBrowserRepository())

  it('完成一轮时原子生成正式轮与新草稿', async () => {
    const bootstrap = await browserRepository.bootstrap()
    const projectId = bootstrap.projects[0]?.id
    expect(projectId).toBeTruthy()
    const [draft] = await browserRepository.listRounds(projectId!)
    await browserRepository.saveRound(draft!.id, '# 第一轮', '说明', draft!.revision)
    const result = await browserRepository.finalizeDraft(projectId!)
    expect(result.finalizedRound.contentMd).toBe('# 第一轮')
    expect(result.draft.contentMd).toBe('')
    expect((await browserRepository.listRounds(projectId!)).map((round) => round.status)).toEqual([
      'final',
      'draft',
    ])
  })

  it('拒绝陈旧 revision 且不覆盖数据库版本', async () => {
    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    const draft = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.saveRound(draft.id, '数据库新版', '', 0)
    await expect(browserRepository.saveRound(draft.id, '旧缓冲', '', 0)).rejects.toThrow(
      'REVISION_CONFLICT',
    )
    expect((await browserRepository.getRound(draft.id)).contentMd).toBe('数据库新版')
  })

  it('API 适配层把冲突替换的 expectedRevision 完整传给浏览器仓库', async () => {
    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    const draft = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.saveRound(draft.id, '数据库版本', '', 0)

    const replaced = await api.resolveConflictReplaceLocal(draft.id, '本地版本', '', 1)

    expect(replaced.contentMd).toBe('本地版本')
    expect(replaced.revision).toBe(2)
  })

  it('API 适配层把设置 patch 传给浏览器仓库', async () => {
    await api.saveSettings({ theme: 'warm', bodyLineHeight: 1.9 })

    expect((await api.bootstrap()).settings).toMatchObject({
      theme: 'warm',
      bodyLineHeight: 1.9,
    })
  })

  it('远程图片命令有显式浏览器契约且不会从浏览器直接联网', async () => {
    await expect(api.fetchRemoteImage('https://example.com/image.png')).rejects.toThrow(
      '仅在 Windows 应用中可用',
    )
  })

  it('浏览器验收模式与原生端共享设置、项目名和冲突校验', async () => {
    await expect(browserRepository.saveSettings({ uiFontWeight: 450 })).rejects.toThrow(
      '设置字段无效',
    )
    await expect(browserRepository.saveSettings({ bodyLineHeight: 9 })).rejects.toThrow(
      '设置字段无效',
    )
    await expect(browserRepository.createProject('控制\n字符')).rejects.toThrow('控制字符')

    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    const draft = (await browserRepository.listRounds(projectId))[0]!
    await expect(
      browserRepository.resolveConflictKeepBoth(draft.id, '本地版本', '非法\n备注'),
    ).rejects.toThrow('单行文字')
  })

  it('自定义名称的新建项目也消耗单调默认编号', async () => {
    await browserRepository.createProject('自定义名称')
    const generated = await browserRepository.createProject()

    expect(generated.name).toBe('Vibe Coding 项目-3')
  })

  it('搜索覆盖草稿和代码并支持软删除恢复', async () => {
    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    const draft = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.saveRound(draft.id, '中文内容 TypeScript', '重点', 0)
    expect(await browserRepository.searchAll('中', 100, 0)).toHaveLength(1)
    expect(await browserRepository.searchAll('typescript', 100, 0)).toHaveLength(1)
    await browserRepository.finalizeDraft(projectId)
    const final = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.deleteRound(final.id)
    expect(await browserRepository.listTrash()).toHaveLength(1)
    await browserRepository.restoreRound(final.id)
    expect(await browserRepository.listTrash()).toHaveLength(0)
  })

  it('损坏的 localStorage 会报错并保留原始数据', async () => {
    const damaged = '{"projects":"broken"'
    localStorage.setItem('vpr-browser-database-v1', damaged)

    await expect(browserRepository.bootstrap()).rejects.toThrow('原始数据已保留')
    expect(localStorage.getItem('vpr-browser-database-v1')).toBe(damaged)
  })

  it('可解析但不符合 schema 的数据不会被断言为数据库', async () => {
    const invalid = JSON.stringify({
      nextProjectNumber: 2,
      projects: [],
      rounds: [{ id: 'orphan', projectId: 'missing' }],
      settings: {},
      viewStates: [],
    })
    localStorage.setItem('vpr-browser-database-v1', invalid)

    await expect(browserRepository.bootstrap()).rejects.toThrow('轮次记录无效')
    expect(localStorage.getItem('vpr-browser-database-v1')).toBe(invalid)
  })

  it('恢复轮次时为原位置腾挪并保持 position 唯一', async () => {
    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    let draft = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.saveRound(draft.id, '第一轮', '', draft.revision)
    const first = (await browserRepository.finalizeDraft(projectId)).finalizedRound
    draft = (await browserRepository.listRounds(projectId)).find(
      (round) => round.status === 'draft',
    )!
    await browserRepository.saveRound(draft.id, '第二轮', '', draft.revision)
    const second = (await browserRepository.finalizeDraft(projectId)).finalizedRound

    await browserRepository.deleteRound(first.id)
    await browserRepository.reorderRounds(projectId, [second.id])
    await browserRepository.restoreRound(first.id)

    const finals = (await browserRepository.listRounds(projectId)).filter(
      (round) => round.status === 'final',
    )
    expect(finals.map((round) => round.id)).toEqual([first.id, second.id])
    expect(finals.map((round) => round.position)).toEqual([0, 1])
  })

  it('软删除与启动修复都会清空悬空的视图状态引用', async () => {
    const projectId = (await browserRepository.bootstrap()).projects[0]!.id
    const draft = (await browserRepository.listRounds(projectId))[0]!
    await browserRepository.saveRound(draft.id, '正式轮', '', draft.revision)
    const final = (await browserRepository.finalizeDraft(projectId)).finalizedRound
    await browserRepository.saveViewState({
      projectId,
      selectedRoundId: final.id,
      timelineAnchorRoundId: final.id,
      anchorOffsetPx: 42,
      editorMode: 'source',
      cursorAnchor: 2,
      cursorHead: 3,
      detailOpen: true,
      updatedAt: Date.now(),
    })

    await browserRepository.deleteRound(final.id)
    expect(await browserRepository.getViewState(projectId)).toMatchObject({
      selectedRoundId: null,
      timelineAnchorRoundId: null,
      anchorOffsetPx: 0,
    })

    const raw: unknown = JSON.parse(localStorage.getItem('vpr-browser-database-v1')!)
    if (typeof raw !== 'object' || raw === null || !('viewStates' in raw)) {
      throw new Error('测试数据库缺少视图状态')
    }
    const viewStates = raw.viewStates
    const viewState: unknown = Array.isArray(viewStates) ? viewStates[0] : null
    if (typeof viewState !== 'object' || viewState === null) {
      throw new Error('测试数据库视图状态无效')
    }
    Object.assign(viewState, {
      selectedRoundId: final.id,
      timelineAnchorRoundId: final.id,
      anchorOffsetPx: 99,
    })
    localStorage.setItem('vpr-browser-database-v1', JSON.stringify(raw))
    expect(await browserRepository.getViewState(projectId)).toMatchObject({
      selectedRoundId: null,
      timelineAnchorRoundId: null,
      anchorOffsetPx: 0,
    })

    if (!('rounds' in raw) || !Array.isArray(raw.rounds)) {
      throw new Error('测试数据库缺少轮次')
    }
    const expiredRound: unknown = raw.rounds.find(
      (candidate: unknown) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'id' in candidate &&
        candidate.id === final.id,
    )
    if (typeof expiredRound !== 'object' || expiredRound === null) {
      throw new Error('测试数据库缺少待过期轮次')
    }
    Object.assign(expiredRound, { deletedAt: Date.now() - 31 * 24 * 60 * 60 * 1_000 })
    localStorage.setItem('vpr-browser-database-v1', JSON.stringify(raw))
    await browserRepository.bootstrap()
    await expect(browserRepository.getRound(final.id)).rejects.toThrow('轮次不存在或已删除')
  })

  it('配额写入失败给出可恢复说明并保留旧值', async () => {
    await browserRepository.bootstrap()
    const previous = localStorage.getItem('vpr-browser-database-v1')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    await expect(browserRepository.createProject('无法写入')).rejects.toThrow(
      '本次更改未写入，原有数据仍保持不变',
    )
    expect(localStorage.getItem('vpr-browser-database-v1')).toBe(previous)
  })

  it('明确标记浏览器验收壳版本', async () => {
    expect((await browserRepository.bootstrap()).appVersion).toBe('0.0.0-web')
  })

  it('写操作通过 Web Locks 在标签页之间串行化', async () => {
    const request = vi.fn((_name: string, operation: () => unknown) => Promise.resolve(operation()))
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    try {
      await browserRepository.bootstrap()
      await browserRepository.createProject('并发保护')
      expect(request).toHaveBeenCalledWith('vpr-browser-database-write-v1', expect.any(Function))
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })
})
