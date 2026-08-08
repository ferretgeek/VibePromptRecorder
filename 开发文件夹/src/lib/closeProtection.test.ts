import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloseProtection, type CloseFailureState } from './closeProtection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function setup(overrides: Partial<Parameters<typeof createCloseProtection>[0]> = {}) {
  let failure: CloseFailureState | null = null
  const dependencies: Parameters<typeof createCloseProtection>[0] = {
    isComposing: vi.fn(() => false),
    getBuffer: vi.fn(() => '尚未保存的正文'),
    setEditingLocked: vi.fn(),
    flushActive: vi.fn(() => Promise.resolve(true)),
    persistViewState: vi.fn(() => Promise.resolve()),
    persistWindowState: vi.fn(() => Promise.resolve()),
    markCleanShutdown: vi.fn(() => Promise.resolve()),
    cancelCleanShutdown: vi.fn(() => Promise.resolve()),
    destroyWindow: vi.fn(() => Promise.resolve()),
    copyBuffer: vi.fn(() => Promise.resolve()),
    showFailure: vi.fn((next: CloseFailureState | null) => {
      failure = next
    }),
    notify: vi.fn(),
    timeoutMs: 10_000,
    ...overrides,
  }
  return {
    dependencies,
    coordinator: createCloseProtection(dependencies),
    getFailure: () => failure,
  }
}

describe('窗口关闭保护', () => {
  beforeEach(() => vi.useRealTimers())

  it('输入法组合期间拒绝关闭且不启动保存', async () => {
    const context = setup({ isComposing: () => true })

    await context.coordinator.requestClose()

    expect(context.dependencies.flushActive).not.toHaveBeenCalled()
    expect(context.dependencies.destroyWindow).not.toHaveBeenCalled()
    expect(context.dependencies.notify).toHaveBeenCalledWith(
      expect.stringContaining('输入法'),
      'warning',
    )
  })

  it('合并重复关闭请求并仅执行一次正常关闭链路', async () => {
    const saving = deferred<boolean>()
    const context = setup({ flushActive: vi.fn(() => saving.promise) })

    const first = context.coordinator.requestClose()
    const second = context.coordinator.requestClose()
    saving.resolve(true)
    await Promise.all([first, second])

    expect(context.dependencies.flushActive).toHaveBeenCalledOnce()
    expect(context.dependencies.markCleanShutdown).toHaveBeenCalledOnce()
    expect(context.dependencies.markCleanShutdown).toHaveBeenCalledWith(1)
    expect(context.dependencies.destroyWindow).toHaveBeenCalledOnce()
  })

  it('约十秒超时后恢复编辑并给出逃生选择', async () => {
    vi.useFakeTimers()
    const context = setup({ flushActive: vi.fn(() => new Promise<boolean>(() => undefined)) })

    const closing = context.coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(10_000)
    await closing

    expect(context.getFailure()?.message).toContain('10 秒')
    expect(context.getFailure()?.buffer).toBe('尚未保存的正文')
    expect(context.dependencies.setEditingLocked).toHaveBeenLastCalledWith(false)
    expect(context.dependencies.destroyWindow).not.toHaveBeenCalled()
  })

  it('复制缓冲并强制退出时不写 clean-shutdown 标记', async () => {
    const context = setup({ flushActive: vi.fn(() => Promise.resolve(false)) })
    await context.coordinator.requestClose()

    await context.coordinator.copyBufferAndExit()

    expect(context.dependencies.copyBuffer).toHaveBeenCalledWith('尚未保存的正文')
    expect(context.dependencies.destroyWindow).toHaveBeenCalledOnce()
    expect(context.dependencies.markCleanShutdown).not.toHaveBeenCalled()
  })

  it('明确仍退出时不复制、撤销 clean 意图再销毁窗口', async () => {
    const context = setup({ flushActive: vi.fn(() => Promise.resolve(false)) })
    await context.coordinator.requestClose()

    await context.coordinator.exitAnyway()

    expect(context.dependencies.copyBuffer).not.toHaveBeenCalled()
    expect(context.dependencies.cancelCleanShutdown).toHaveBeenCalled()
    expect(context.dependencies.cancelCleanShutdown).toHaveBeenCalledWith(1)
    expect(context.dependencies.destroyWindow).toHaveBeenCalledOnce()
    expect(context.dependencies.markCleanShutdown).not.toHaveBeenCalled()
  })

  it('窗口销毁失败时撤销已经登记的 clean 意图', async () => {
    const context = setup({
      destroyWindow: vi.fn(() => Promise.reject(new Error('窗口拒绝销毁'))),
    })

    await context.coordinator.requestClose()

    expect(context.dependencies.markCleanShutdown).toHaveBeenCalledOnce()
    expect(context.dependencies.cancelCleanShutdown).toHaveBeenCalled()
    expect(context.getFailure()?.message).toContain('窗口拒绝销毁')
    expect(context.dependencies.setEditingLocked).toHaveBeenLastCalledWith(false)
  })

  it('复制缓冲期间合并新的关闭请求且不能被继续编辑取消', async () => {
    const copying = deferred<void>()
    const context = setup({
      flushActive: vi.fn(() => Promise.resolve(false)),
      copyBuffer: vi.fn(() => copying.promise),
    })
    await context.coordinator.requestClose()

    const force = context.coordinator.copyBufferAndExit()
    const repeated = context.coordinator.requestClose()
    context.coordinator.continueEditing()
    copying.resolve()
    await Promise.all([force, repeated])

    expect(context.dependencies.flushActive).toHaveBeenCalledOnce()
    expect(context.dependencies.destroyWindow).toHaveBeenCalledOnce()
    expect(context.dependencies.setEditingLocked).not.toHaveBeenLastCalledWith(false)
  })
})
