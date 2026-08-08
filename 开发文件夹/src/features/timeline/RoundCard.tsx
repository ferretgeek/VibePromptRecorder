import { ArrowDown, ArrowUp, Copy, GripVertical, Maximize2, Trash2 } from 'lucide-react'
import {
  memo,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { writeClipboard } from '../../lib/api'
import { roundContentForCopy } from '../../lib/roundCopy'
import { formatFullTime, formatTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'
import type { RoundSummary } from '../../types'
import { IconButton } from '../../components/IconButton'
import { MarkdownPreview } from '../../components/MarkdownPreview'

interface RoundCardProps {
  round: RoundSummary
  index: number
  finalCount: number
  selected: boolean
  previewLines: number
  showNumber: boolean
  onSelect: (roundId: string) => void
  onDragStart: (roundId: string) => void
  onDrop: (roundId: string) => void
}

export const RoundCard = memo(function RoundCard({
  round,
  index,
  finalCount,
  selected,
  previewLines,
  showNumber,
  onSelect,
  onDragStart,
  onDrop,
}: RoundCardProps) {
  const deleteRound = useAppStore((state) => state.deleteRound)
  const moveRound = useAppStore((state) => state.moveRound)
  const showToast = useAppStore((state) => state.showToast)
  const isDraft = round.status === 'draft'
  const roundNumber = index + 1
  const style = {
    '--preview-lines': previewLines,
  } as CSSProperties
  const timeDescription = [
    '创建：' + formatFullTime(round.createdAt),
    round.finalizedAt ? '正式保存：' + formatFullTime(round.finalizedAt) : null,
    '最后修改：' + formatFullTime(round.updatedAt),
  ]
    .filter(Boolean)
    .join('；')

  const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()
  const copy = async (event: MouseEvent) => {
    stop(event)
    try {
      await writeClipboard(await roundContentForCopy(round.id, selected))
      showToast('已复制当前轮 Markdown 原文', 'success')
    } catch {
      showToast('复制失败，请打开详情后重试', 'danger')
    }
  }

  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', round.id)
    onDragStart(round.id)
  }

  return (
    <article
      role="option"
      aria-selected={selected}
      className={`round-card ${selected ? 'is-selected' : ''} ${isDraft ? 'is-draft' : ''}`}
      data-round-id={round.id}
      aria-current={selected ? 'true' : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(round.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(round.id)
        }
      }}
      onDragOver={(event) => {
        if (isDraft) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (isDraft) return
        event.preventDefault()
        onDrop(round.id)
      }}
    >
      <header className="round-card__header">
        <div className="round-card__identity">
          {showNumber && !isDraft ? <span className="round-badge">{roundNumber}</span> : null}
          <div>
            <strong>{isDraft ? '当前草稿' : round.note || `第 ${roundNumber} 轮`}</strong>
            {round.note && !isDraft ? <span>第 {roundNumber} 轮</span> : null}
          </div>
        </div>
        <div className="round-card__actions" onClick={stop} onKeyDown={stop}>
          {!isDraft ? (
            <>
              <IconButton
                label="向上移动轮次（Alt+Shift+↑）"
                disabled={index === 0}
                onClick={() => void moveRound(round.id, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </IconButton>
              <IconButton
                label="向下移动轮次（Alt+Shift+↓）"
                disabled={index >= finalCount - 1}
                onClick={() => void moveRound(round.id, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </IconButton>
              <IconButton
                label="拖动调整轮次顺序"
                draggable
                onDragStart={handleDragStart}
                className="drag-handle"
              >
                <GripVertical aria-hidden="true" />
              </IconButton>
            </>
          ) : null}
          <IconButton label="复制这一轮" onClick={(event) => void copy(event)}>
            <Copy aria-hidden="true" />
          </IconButton>
          <IconButton
            label={isDraft ? '清空草稿' : '删除这一轮'}
            variant="danger"
            onClick={() => void deleteRound(round.id)}
          >
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <div
        className={`round-card__preview ${previewLines === 0 ? 'is-unfolded' : ''}`}
        style={style}
      >
        <MarkdownPreview markdown={round.previewMd} compact />
        {previewLines > 0 ? <span className="round-card__fade" aria-hidden="true" /> : null}
      </div>
      <footer className="round-card__footer">
        <time
          dateTime={new Date(round.updatedAt).toISOString()}
          aria-label={timeDescription}
          title={`创建：${formatFullTime(round.createdAt)}\n${round.finalizedAt ? `正式保存：${formatFullTime(round.finalizedAt)}\n` : ''}最后修改：${formatFullTime(round.updatedAt)}`}
        >
          {isDraft
            ? round.previewMd.trim()
              ? `已自动保存 ${formatTime(round.updatedAt)}`
              : '等待输入'
            : formatTime(round.finalizedAt ?? round.updatedAt)}
        </time>
        <span>{round.charCount.toLocaleString('zh-CN')} 字</span>
        <span className="round-card__expand">
          <Maximize2 aria-hidden="true" /> 展开
        </span>
      </footer>
    </article>
  )
})
