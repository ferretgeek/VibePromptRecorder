import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('为切换按钮保留显式关闭态', () => {
    render(
      <IconButton label="置顶" active={false}>
        图标
      </IconButton>,
    )

    expect(screen.getByRole('button', { name: '置顶' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('不把普通按钮误报为切换按钮', () => {
    render(<IconButton label="设置">图标</IconButton>)

    expect(screen.getByRole('button', { name: '设置' })).not.toHaveAttribute('aria-pressed')
  })
})
