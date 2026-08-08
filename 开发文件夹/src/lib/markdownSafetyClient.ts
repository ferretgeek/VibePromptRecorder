import { inspectMarkdownSafety, type MarkdownSafety } from './markdown'

interface WorkerResponse {
  id: number
  safety: MarkdownSafety
}

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<
  number,
  { resolve: (value: MarkdownSafety) => void; reject: (reason: unknown) => void }
>()

function sharedWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (worker) return worker
  worker = new Worker(new URL('../workers/markdownSafety.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    request.resolve(event.data.safety)
  })
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Markdown 安全分析 Worker 失败')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
  })
  return worker
}

export function analyzeMarkdownSafety(markdown: string): Promise<MarkdownSafety> {
  const target = sharedWorker()
  if (!target) {
    // jsdom 等测试环境没有 Worker；异步回退保持相同调用契约。正式 Vite 构建始终走 Worker。
    return Promise.resolve().then(() => inspectMarkdownSafety(markdown))
  }
  const id = ++nextRequestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    target.postMessage({ id, markdown })
  })
}
