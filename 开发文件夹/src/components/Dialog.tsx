import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'

const openDialogs: symbol[] = []
const dialogContainers = new Map<symbol, HTMLElement>()
let appRootState:
  | {
      element: HTMLElement
      inert: boolean
      ariaHidden: string | null
    }
  | undefined

function isTopDialog(id: symbol) {
  return openDialogs.at(-1) === id
}

function updateDialogLayers(): void {
  const top = openDialogs.at(-1)
  for (const [id, container] of dialogContainers) {
    const isTop = id === top
    container.inert = !isTop
    if (isTop) {
      container.removeAttribute('inert')
      container.removeAttribute('aria-hidden')
    } else {
      container.setAttribute('inert', '')
      container.setAttribute('aria-hidden', 'true')
    }
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')
    if (isTop) panel?.setAttribute('aria-modal', 'true')
    else panel?.removeAttribute('aria-modal')
  }
}

interface DialogProps {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  className?: string
  wide?: boolean
}

export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  className = '',
  wide = false,
}: DialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const dialogIdRef = useRef(Symbol('dialog'))

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const dialogId = dialogIdRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const appRoot = document.getElementById('root')
    if (appRoot) {
      if (!appRootState) {
        appRootState = {
          element: appRoot,
          inert: appRoot.inert,
          ariaHidden: appRoot.getAttribute('aria-hidden'),
        }
      }
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    const backdrop = backdropRef.current
    if (backdrop) dialogContainers.set(dialogId, backdrop)
    openDialogs.push(dialogId)
    updateDialogLayers()
    const alreadyFocused =
      document.activeElement instanceof HTMLElement &&
      panelRef.current?.contains(document.activeElement)
        ? document.activeElement
        : null
    const panel = panelRef.current
    const focusable =
      alreadyFocused ??
      panel?.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
      panel?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
    focusable?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(dialogId)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const index = openDialogs.lastIndexOf(dialogId)
      const wasTop = isTopDialog(dialogId)
      if (index >= 0) openDialogs.splice(index, 1)
      dialogContainers.delete(dialogId)
      updateDialogLayers()
      if (openDialogs.length === 0 && appRootState) {
        appRootState.element.inert = appRootState.inert
        if (appRootState.ariaHidden === null) {
          appRootState.element.removeAttribute('aria-hidden')
        } else {
          appRootState.element.setAttribute('aria-hidden', appRootState.ariaHidden)
        }
        appRootState = undefined
      }
      if (wasTop && previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      ref={backdropRef}
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (isTopDialog(dialogIdRef.current)) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`dialog-panel ${wide ? 'dialog-panel--wide' : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </IconButton>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  )
}
