import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  active?: boolean
  variant?: 'ghost' | 'soft' | 'danger'
}

export function IconButton({
  label,
  children,
  active,
  variant = 'ghost',
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button icon-button--${variant} ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      aria-pressed={props['aria-pressed'] ?? (active === undefined ? undefined : active)}
      title={label}
      {...props}
    >
      {children}
    </button>
  )
}
