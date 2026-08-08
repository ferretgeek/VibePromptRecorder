import { describe, expect, it, vi } from 'vitest'
import type { ProjectSummary, RoundDetail } from '../types'
import { buildCopyAll, buildMarkdownExport, sanitizeWindowsFileName } from './export'

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '测试项目',
  isPinned: false,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 2,
  roundCount: 1,
  hasDraft: true,
}

const rounds: RoundDetail[] = [
  {
    id: '00000000-0000-4000-8000-000000000002',
    projectId: project.id,
    position: 2_147_483_647,
    status: 'draft',
    contentMd: '草稿😀',
    createdAt: 3,
    finalizedAt: null,
    updatedAt: 4,
    revision: 0,
    note: '',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    projectId: project.id,
    position: 0,
    status: 'final',
    contentMd: '# 正式轮次\n\n```ts\nconst ok = true\n```',
    createdAt: 1,
    finalizedAt: 2,
    updatedAt: 2,
    revision: 1,
    note: '关键备注',
  },
]

describe('原文复制与 Markdown 导出', () => {
  it('按正式轮次后草稿排序且绝不改写正文', () => {
    const copied = buildCopyAll(rounds, { withLabels: true, includeDraft: true })
    expect(copied).toContain('===== 第 1 轮 =====\n' + rounds[1]?.contentMd)
    expect(copied).toContain('===== 当前草稿 =====\n草稿😀')
    expect(copied.indexOf('第 1 轮')).toBeLessThan(copied.indexOf('当前草稿'))
  })

  it('写入稳定的 UTF-8 字节数与 SHA-256 完整性标记', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000099')
    const output = await buildMarkdownExport(project, rounds, 1_700_000_000_000)
    const bytes = new TextEncoder().encode('草稿😀').byteLength
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('草稿😀'))
    const hash = [...new Uint8Array(hashBuffer)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    expect(output).toContain(`bytes=${bytes} sha256=${hash}`)
    expect(output).toContain(rounds[1]?.contentMd ?? '')
  })

  it('生成 Windows 安全文件名', () => {
    expect(sanitizeWindowsFileName('CON')).not.toBe('CON')
    expect(sanitizeWindowsFileName('a<b>:c?.')).toBe('a_b__c_')
    const longEmojiName = sanitizeWindowsFileName('😀'.repeat(100))
    expect(longEmojiName.length).toBe(180)
    expect(longEmojiName.endsWith('\ud83d')).toBe(false)
  })
})
