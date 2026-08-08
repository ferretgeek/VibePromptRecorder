/// <reference lib="webworker" />

import { inspectMarkdownSafety } from '../lib/markdown'

interface MarkdownSafetyRequest {
  id: number
  markdown: string
}

self.addEventListener('message', (event: MessageEvent<MarkdownSafetyRequest>) => {
  const { id, markdown } = event.data
  self.postMessage({ id, safety: inspectMarkdownSafety(markdown) })
})
