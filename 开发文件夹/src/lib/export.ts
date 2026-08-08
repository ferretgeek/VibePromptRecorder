import type { ProjectSummary, RoundDetail } from '../types'
import { formatFullTime } from './time'

export interface CopyAllOptions {
  withLabels: boolean
  includeDraft: boolean
}

// 剪贴板统一使用 LF，避免把 CRLF 混入其它 AI/编程工具。
const toLf = (value: string): string => value.replace(/\r\n?/g, '\n')

export function buildCopyAll(rounds: RoundDetail[], options: CopyAllOptions): string {
  const included = rounds
    .filter((round) => round.status === 'final' || (options.includeDraft && round.contentMd.trim()))
    .sort(
      (left, right) =>
        Number(left.status === 'draft') - Number(right.status === 'draft') ||
        left.position - right.position,
    )
  if (!options.withLabels) return included.map((round) => toLf(round.contentMd)).join('\n\n')
  let number = 0
  return included
    .map((round) => {
      if (round.status === 'draft') return `===== 当前草稿 =====\n${toLf(round.contentMd)}`
      number += 1
      return `===== 第 ${number} 轮 =====\n${toLf(round.contentMd)}`
    })
    .join('\n\n')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength)
  stableBytes.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', stableBytes.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildMarkdownExport(
  project: ProjectSummary,
  rounds: RoundDetail[],
  exportedAt = Date.now(),
): Promise<string> {
  const exportId = crypto.randomUUID()
  const encoder = new TextEncoder()
  const ordered = rounds
    .filter((round) => round.status === 'final' || round.contentMd.trim())
    .sort(
      (left, right) =>
        Number(left.status === 'draft') - Number(right.status === 'draft') ||
        left.position - right.position,
    )
  const blocks = await Promise.all(
    ordered.map(async (round, index) => {
      const title =
        round.status === 'draft'
          ? '## 当前草稿'
          : `## 第 ${index + 1} 轮${round.note ? ` · ${round.note}` : ''}`
      const time = round.finalizedAt ?? round.updatedAt
      const bytes = encoder.encode(round.contentMd)
      const metadata = `<!-- vpr-round export=${exportId} id=${round.id} bytes=${bytes.byteLength} sha256=${await sha256Hex(bytes)} -->`
      return `${metadata}\n${title}\n\n> 保存时间：${formatFullTime(time)}\n\n${round.contentMd}`
    }),
  )
  return [
    `<!-- vpr-export:v1 export=${exportId} -->`,
    `# ${project.name}`,
    '',
    `> 导出时间：${formatFullTime(exportedAt)}`,
    '',
    ...blocks.flatMap((block) => [block, '']),
  ]
    .join('\n')
    .replace(/\n+$/, '\n')
}

function truncateUtf16(value: string, maxUnits: number): string {
  let result = ''
  let units = 0
  for (const character of value) {
    if (units + character.length > maxUnits) break
    result += character
    units += character.length
  }
  return result
}

export function sanitizeWindowsFileName(value: string): string {
  const sanitized = truncateUtf16(
    [...value.trim()]
      .map((character) =>
        character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character,
      )
      .join(''),
    180,
  ).replace(/[. ]+$/g, '')
  if (!sanitized) return '未命名项目'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)
    ? `_${sanitized}`
    : sanitized
}
