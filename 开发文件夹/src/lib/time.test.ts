import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './time'

describe('formatRelativeTime', () => {
  const reference = new Date('2026-07-27T12:00:00Z').getTime()

  it('区分过去、现在和未来', () => {
    expect(formatRelativeTime(reference - 30_000, reference)).toBe('刚刚')
    expect(formatRelativeTime(reference + 30_000, reference)).toBe('即将')
    expect(formatRelativeTime(reference + 2 * 60_000, reference)).toBe('2 分钟后')
    expect(formatRelativeTime(reference + 3 * 3_600_000, reference)).toBe('3 小时后')
    expect(formatRelativeTime(reference + 2 * 86_400_000, reference)).toBe('2 天后')
  })
})
