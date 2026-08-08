import { describe, expect, it } from 'vitest'

import capability from '../../src-tauri/capabilities/default.json'
import rustAppSource from '../../src-tauri/src/lib.rs?raw'
import tauriConfig from '../../src-tauri/tauri.conf.json'
import packageConfig from '../../package.json'

describe('Tauri 主窗口权限', () => {
  it('使用应用内标题栏并开放所需的最小窗口控制权限', () => {
    expect(rustAppSource).toContain('.decorations(false)')
    expect(capability.permissions).toEqual(
      expect.arrayContaining([
        'core:window:allow-is-maximized',
        'core:window:allow-minimize',
        'core:window:allow-toggle-maximize',
        'core:window:allow-start-dragging',
      ]),
    )
  })

  it('允许请求关闭并在安全保存完成后销毁窗口', () => {
    expect(capability.permissions).toContain('core:window:allow-close')
    expect(capability.permissions).toContain('core:window:allow-destroy')
  })

  it('本地文件选择只由 Rust 原生层发起，不向 renderer 开放文件对话框', () => {
    expect(capability.permissions.every((permission) => !permission.startsWith('dialog:'))).toBe(
      true,
    )
    expect(rustAppSource).not.toContain('tauri_plugin_dialog')
    expect(packageConfig.dependencies).not.toHaveProperty('@tauri-apps/plugin-dialog')
  })

  it('远程图片只能经原生代理转换为 data URL', () => {
    const csp = tauriConfig.app.security.csp
    const imagePolicy = csp.match(/img-src[^;]*/)?.[0] ?? ''
    expect(imagePolicy).toContain('data:')
    expect(imagePolicy).not.toContain('https:')
    expect(imagePolicy.replace('http://asset.localhost', '')).not.toMatch(/\bhttp:/)
    expect(csp).toMatch(/connect-src ipc: http:\/\/ipc\.localhost;/)
    expect(csp).toContain("script-src 'self'")
  })
})
