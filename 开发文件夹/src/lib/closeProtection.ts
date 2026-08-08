export const CLOSE_WAIT_TIMEOUT_MS = 10_000

export interface CloseFailureState {
  message: string
  buffer: string
}

interface CloseProtectionDependencies {
  isComposing: () => boolean
  getBuffer: () => string
  setEditingLocked: (locked: boolean) => void
  flushActive: () => Promise<boolean>
  persistViewState: () => Promise<void>
  persistWindowState: () => Promise<void>
  markCleanShutdown: (generation: number) => Promise<void>
  cancelCleanShutdown: (generation: number) => Promise<void>
  destroyWindow: () => Promise<void>
  copyBuffer: (buffer: string) => Promise<void>
  showFailure: (failure: CloseFailureState | null) => void
  notify: (message: string, tone: 'warning' | 'danger') => void
  timeoutMs?: number
}

export interface CloseProtectionCoordinator {
  requestClose: () => Promise<void>
  continueEditing: () => void
  copyBufferAndExit: () => Promise<void>
  exitAnyway: () => Promise<void>
  dispose: () => void
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '发生了未知错误'
}

export function waitWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`关闭前保存等待超过 ${Math.round(timeoutMs / 1_000)} 秒`)),
      timeoutMs,
    )
    task.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * 串行化窗口关闭请求，并把正常关闭和不写 clean-shutdown 标记的强制退出明确分开。
 * generation 检查不能取消已经发出的 IPC，但会阻止超时请求继续进入后续关闭阶段。
 */
export function createCloseProtection(
  dependencies: CloseProtectionDependencies,
): CloseProtectionCoordinator {
  let generation = 0
  let gracefulClose: Promise<void> | null = null
  let forceClose: Promise<void> | null = null
  let failure: CloseFailureState | null = null
  let exiting = false
  let disposed = false

  const ensureCurrent = (attempt: number) => {
    if (disposed || attempt !== generation) throw new Error('关闭请求已取消')
  }

  const showFailure = (message: string) => {
    failure = { message, buffer: dependencies.getBuffer() }
    dependencies.showFailure(failure)
  }

  const requestClose = (): Promise<void> => {
    if (disposed || exiting) return forceClose ?? Promise.resolve()
    if (forceClose) return forceClose
    if (dependencies.isComposing()) {
      dependencies.notify('正在使用输入法组合文字；请先完成输入，再关闭窗口', 'warning')
      return Promise.resolve()
    }
    if (gracefulClose) return gracefulClose

    const attempt = ++generation
    dependencies.showFailure(null)
    dependencies.setEditingLocked(true)
    const workflow = (async () => {
      const saved = await dependencies.flushActive()
      ensureCurrent(attempt)
      if (!saved) throw new Error('当前内容尚未安全保存')
      await dependencies.persistViewState()
      ensureCurrent(attempt)
      await dependencies.persistWindowState()
      ensureCurrent(attempt)
      await dependencies.markCleanShutdown(attempt)
      try {
        ensureCurrent(attempt)
      } catch (error) {
        // 标记命令只登记正常关闭意图；若请求已超时/取消，撤销该意图，
        // 防止后续强退在窗口 Destroyed 事件中被误记为 clean shutdown。
        await dependencies.cancelCleanShutdown(attempt).catch(() => undefined)
        throw error
      }
    })()

    const running = (async () => {
      try {
        await waitWithTimeout(workflow, dependencies.timeoutMs ?? CLOSE_WAIT_TIMEOUT_MS)
        ensureCurrent(attempt)
        exiting = true
        await dependencies.destroyWindow()
      } catch (error) {
        await dependencies.cancelCleanShutdown(attempt).catch(() => undefined)
        if (disposed || attempt !== generation) return
        generation += 1
        exiting = false
        dependencies.setEditingLocked(false)
        showFailure(messageFrom(error))
      } finally {
        gracefulClose = null
      }
    })()
    gracefulClose = running
    return running
  }

  const continueEditing = () => {
    if (disposed || exiting) return
    generation += 1
    failure = null
    dependencies.showFailure(null)
    dependencies.setEditingLocked(false)
  }

  const forceExit = (copyFirst: boolean): Promise<void> => {
    if (disposed || exiting) return forceClose ?? Promise.resolve()
    if (forceClose) return forceClose
    const buffer = failure?.buffer ?? dependencies.getBuffer()
    const cancelledAttempt = generation
    generation += 1
    // 从复制开始即进入退出状态：重复系统关闭请求和“继续编辑”不能并发启动另一条链路。
    exiting = true
    dependencies.setEditingLocked(true)
    const running = (async () => {
      try {
        if (cancelledAttempt > 0) {
          await dependencies.cancelCleanShutdown(cancelledAttempt).catch(() => undefined)
        }
        if (copyFirst) await dependencies.copyBuffer(buffer)
        dependencies.showFailure(null)
        // 强制退出分支有意不登记 clean-shutdown 意图。
        await dependencies.destroyWindow()
      } catch (error) {
        exiting = false
        dependencies.setEditingLocked(false)
        const action = copyFirst ? '复制未保存缓冲失败' : '强制退出失败'
        dependencies.notify(`${action}：${messageFrom(error)}`, 'danger')
        showFailure(messageFrom(error))
      } finally {
        forceClose = null
      }
    })()
    forceClose = running
    return running
  }

  return {
    requestClose,
    continueEditing,
    copyBufferAndExit: () => forceExit(true),
    exitAnyway: () => forceExit(false),
    dispose: () => {
      disposed = true
      generation += 1
      failure = null
    },
  }
}
