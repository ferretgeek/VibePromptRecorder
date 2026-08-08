const fullFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'longOffset',
})

const compactFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatTime(timestamp: number): string {
  return compactFormatter.format(timestamp).replaceAll('/', '-').replace(',', '')
}

export function formatFullTime(timestamp: number): string {
  return fullFormatter.format(timestamp).replaceAll('/', '-').replace(',', '')
}

export function formatClock(timestamp: number): string {
  return clockFormatter.format(timestamp)
}

export function formatRelativeTime(timestamp: number, reference = Date.now()): string {
  const delta = reference - timestamp
  if (delta < 0) {
    const futureDelta = -delta
    if (futureDelta < 60_000) return '即将'
    if (futureDelta < 3_600_000) return `${Math.floor(futureDelta / 60_000)} 分钟后`
    if (futureDelta < 86_400_000) return `${Math.floor(futureDelta / 3_600_000)} 小时后`
    if (futureDelta < 7 * 86_400_000) return `${Math.floor(futureDelta / 86_400_000)} 天后`
    return formatTime(timestamp)
  }
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return formatTime(timestamp)
}
