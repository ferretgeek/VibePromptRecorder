import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { IconButton } from './IconButton'

const icons = {
  neutral: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
}

export function Toast() {
  const toast = useAppStore((state) => state.toast)
  const dismiss = useAppStore((state) => state.dismissToast)
  const undo = useAppStore((state) => state.undoLast)

  useEffect(() => {
    if (!toast) return
    // 可撤销提示保留 8 秒；普通提示至少保留 3 秒，给读屏与窄屏重排留出感知时间。
    const duration = toast.undoLabel ? 8_000 : toast.tone === 'success' ? 3_000 : 4_000
    const timeout = window.setTimeout(dismiss, duration)
    return () => window.clearTimeout(timeout)
  }, [dismiss, toast])

  if (!toast) return null
  const Icon = icons[toast.tone]
  return (
    <div
      className={`toast toast--${toast.tone}`}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon aria-hidden="true" />
      <span>{toast.message}</span>
      {toast.undoLabel ? (
        <button type="button" className="toast__action" onClick={() => void undo()}>
          {toast.undoLabel}
        </button>
      ) : null}
      <IconButton label="关闭提示" onClick={dismiss}>
        <X aria-hidden="true" />
      </IconButton>
    </div>
  )
}
