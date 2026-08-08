import { Copy, Download, GitCompareArrows, ShieldCheck, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { api, isTauri, writeClipboard } from '../../lib/api'
import { sanitizeWindowsFileName } from '../../lib/export'
import { formatFullTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'

async function textHash(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  const bytes = new Uint8Array(encoded.byteLength)
  bytes.set(encoded)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function exportConflictMarkdown(fileName: string, content: string): Promise<boolean> {
  if (isTauri()) return Boolean(await api.saveTextFile(fileName, content))
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
  return true
}

export function ConflictDialog() {
  const conflict = useAppStore((state) => state.revisionConflict)
  const resolveConflict = useAppStore((state) => state.resolveRevisionConflict)
  const showToast = useAppStore((state) => state.showToast)
  const [hashes, setHashes] = useState({ database: '计算中…', local: '计算中…' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!conflict) return
    let active = true
    void Promise.all([textHash(conflict.databaseRound.contentMd), textHash(conflict.localContent)])
      .then(([database, local]) => {
        if (active) setHashes({ database, local })
      })
      .catch(() => {
        if (active) setHashes({ database: '计算失败', local: '计算失败' })
      })
    return () => {
      active = false
    }
  }, [conflict])

  if (!conflict) return null
  const fileName = `${sanitizeWindowsFileName(conflict.localNote || '冲突恢复版本')}-${new Date(
    conflict.detectedAt,
  )
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)}.md`

  const run = async (choice: 'keep-both' | 'replace-local' | 'keep-database') => {
    if (
      choice === 'replace-local' &&
      !window.confirm('将先创建完整恢复点，再用本地版替换数据库版。确认继续？')
    ) {
      return
    }
    if (
      choice === 'keep-database' &&
      !window.confirm('尚未导出的本地缓冲将被放弃。确认只保留数据库版？')
    ) {
      return
    }
    setBusy(true)
    try {
      await resolveConflict(choice)
    } catch (error) {
      showToast(`冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const copyVersion = async (content: string) => {
    try {
      await writeClipboard(content)
      showToast('冲突版本已复制', 'success')
    } catch {
      showToast('复制失败，请改用导出本地版', 'danger')
    }
  }

  const exportLocal = async () => {
    setBusy(true)
    try {
      if (await exportConflictMarkdown(fileName, conflict.localContent)) {
        showToast('本地冲突版本已按 Markdown 原文导出', 'success')
      }
    } catch (error) {
      showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      wide
      className="conflict-dialog"
      title="检测到轮次版本冲突"
      description="自动保存已暂停。任何选择前，数据库版与当前内存缓冲都不会被覆盖。"
      onClose={() => showToast('请先选择一种保留方式；本地缓冲仍在内存中', 'warning')}
    >
      <div className="conflict-summary" role="status">
        <GitCompareArrows aria-hidden="true" />
        <span>
          <strong>默认建议保留两份</strong>
          <small>数据库版留在原轮，本地版保存为相邻的新正式轮次。</small>
        </span>
      </div>
      <div className="conflict-versions">
        <section>
          <header>
            <div>
              <span className="eyebrow">数据库版本</span>
              <strong>{formatFullTime(conflict.databaseRound.updatedAt)}</strong>
            </div>
            <span>{[...conflict.databaseRound.contentMd].length.toLocaleString('zh-CN')} 字符</span>
          </header>
          <code title={hashes.database}>SHA-256 {hashes.database.slice(0, 16)}…</code>
          <textarea readOnly value={conflict.databaseRound.contentMd} aria-label="数据库版本全文" />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void copyVersion(conflict.databaseRound.contentMd)}
          >
            <Copy aria-hidden="true" /> 复制数据库版
          </button>
        </section>
        <section>
          <header>
            <div>
              <span className="eyebrow">本地内存版本</span>
              <strong>{formatFullTime(conflict.detectedAt)}</strong>
            </div>
            <span>{[...conflict.localContent].length.toLocaleString('zh-CN')} 字符</span>
          </header>
          <code title={hashes.local}>SHA-256 {hashes.local.slice(0, 16)}…</code>
          <textarea readOnly value={conflict.localContent} aria-label="本地版本全文" />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void copyVersion(conflict.localContent)}
          >
            <Copy aria-hidden="true" /> 复制本地版
          </button>
        </section>
      </div>
      <footer className="dialog-footer conflict-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void exportLocal()}
        >
          <Download aria-hidden="true" /> 仅导出本地版
        </button>
        <span className="settings-footer__spacer" />
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={() => void run('keep-database')}
        >
          <XCircle aria-hidden="true" /> 保留数据库版
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void run('replace-local')}
        >
          用本地版替换
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => void run('keep-both')}
        >
          <ShieldCheck aria-hidden="true" /> 保留两份（推荐）
        </button>
      </footer>
    </Dialog>
  )
}
