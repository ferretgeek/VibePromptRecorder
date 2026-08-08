import { expect, test, type Page } from '@playwright/test'

async function openSourceEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Markdown 源码' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
}

async function enterMarkdown(page: Page, markdown: string): Promise<void> {
  await openSourceEditor(page)
  await page.locator('.cm-content').fill(markdown)
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.name === 'vpr-e2e-storage-ready') return
    localStorage.clear()
    window.name = 'vpr-e2e-storage-ready'
  })
})

test('首次启动、自动保存、完成轮次、复制与搜索主流程', async ({ page }, testInfo) => {
  const startedAt = Date.now()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Vibe Coding 项目-1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '当前草稿' })).toBeVisible()
  expect(Date.now() - startedAt).toBeLessThan(5_000)

  const markdown = '# 第一轮\n\n请保留中文与代码。\n\n```ts\nconst answer = 42\n```'
  await enterMarkdown(page, markdown)
  await page
    .locator('.detail-pane')
    .getByRole('button', { name: /完成并新建下一轮/ })
    .click()
  await expect(page.getByText('本轮已保存，已开始新的草稿')).toBeVisible()
  await expect(page.getByText('第 1 轮', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: /搜索/ }).first().click()
  const search = page.getByRole('searchbox', { name: '全文搜索' })
  await search.fill('answer')
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option')).toContainText('const answer = 42')
  await page.getByRole('option').click()
  await expect(page.locator('.cm-content')).toContainText('const answer = 42')

  await page.screenshot({
    path: testInfo.outputPath('main-flow.png'),
    fullPage: true,
  })
})

test('项目管理、设置临时预览与取消回滚', async ({ page }) => {
  await page.goto('/')
  if ((page.viewportSize()?.width ?? 1_440) < 880) {
    await page.getByRole('button', { name: '打开项目列表' }).click()
  }
  await page.getByTestId('new-project').click()
  await expect(page.getByRole('heading', { name: 'Vibe Coding 项目-2' })).toBeVisible()

  if ((page.viewportSize()?.width ?? 1_440) < 880) {
    await page.getByRole('button', { name: '打开项目列表' }).click()
  }
  await page.getByRole('button', { name: '打开“Vibe Coding 项目-2”菜单' }).click()
  await page.getByRole('menuitem', { name: /重命名/ }).click()
  const nameInput = page.getByRole('textbox', { name: '项目名称' })
  await nameInput.fill('中文 项目：代码审阅')
  await nameInput.press('Enter')
  await expect(page.getByRole('heading', { name: '中文 项目：代码审阅' })).toBeVisible()
  if ((page.viewportSize()?.width ?? 1_440) < 880) {
    await page.getByRole('button', { name: '收起项目栏' }).click()
  }

  await page.getByRole('button', { name: /打开设置/ }).click()
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
  await page.getByRole('button', { name: /珊瑚暖杏/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm')
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neutral')
})

test('未编辑反复切换双模式保持 Markdown 原文字节', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '原文往返压力只运行一次')
  test.slow()
  await page.goto('/')
  const markdown =
    '# 原文保真\n\n- [x] 中文任务\n  - 二级列表\n\n| A | B |\n| --- | :---: |\n| `x` | [链接](https://example.com/a?b=1) |\n\n```ts\nconst value = "保持原样"\n```'
  await enterMarkdown(page, markdown)

  for (let index = 0; index < 20; index += 1) {
    await page.getByRole('button', { name: '所见即所得' }).click()
    await expect(page.locator('.wysiwyg-editor')).toBeVisible()
    await page.getByRole('button', { name: 'Markdown 源码' }).click()
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  const persisted = await page.evaluate(() => {
    const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
      rounds?: Array<{ status: string; contentMd: string }>
    }
    return database.rounds?.find((round) => round.status === 'draft')?.contentMd
  })
  expect(persisted).toBe(markdown)
})

test('安全限制解除后仍保持源码模式', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '编辑模式持久化只运行一次')
  await page.goto('/')
  await enterMarkdown(page, '初始内容')
  await page.evaluate(() => {
    const key = 'vpr-browser-database-v1'
    const database = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      rounds: Array<{ status: string; contentMd: string; revision: number }>
      viewStates: Array<{ editorMode: 'wysiwyg' | 'source' }>
    }
    const draft = database.rounds.find((round) => round.status === 'draft')
    if (!draft || !database.viewStates[0]) throw new Error('浏览器测试数据缺失')
    draft.contentMd = '<script>不安全内容</script>'
    draft.revision += 1
    database.viewStates[0].editorMode = 'wysiwyg'
    localStorage.setItem(key, JSON.stringify(database))
  })
  await page.reload()

  const sourceButton = page.getByRole('button', { name: 'Markdown 源码' })
  await expect(sourceButton).toHaveClass(/is-active/)
  await page.locator('.cm-content').fill('恢复为安全内容')
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })
  await expect(sourceButton).toHaveClass(/is-active/)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('恢复当前项目的轮次后时间线立即更新', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '回收站回归只运行一次')
  await page.goto('/')
  await enterMarkdown(page, '需要恢复的正式轮次')
  await page
    .locator('.detail-pane')
    .getByRole('button', { name: /完成并新建下一轮/ })
    .click()
  const finalRound = page.getByRole('option').filter({ hasText: '需要恢复的正式轮次' })
  await expect(finalRound).toBeVisible()
  await finalRound.getByRole('button', { name: '删除这一轮' }).click()
  await expect(finalRound).toHaveCount(0)

  await page.getByRole('button', { name: /打开设置/ }).click()
  await page.getByRole('button', { name: '数据与备份' }).click()
  const trashItem = page.locator('.trash-item').filter({ hasText: '需要恢复的正式轮次' })
  await expect(trashItem).toBeVisible()
  await trashItem.getByRole('button', { name: '恢复' }).click()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('option').filter({ hasText: '需要恢复的正式轮次' })).toBeVisible()
})

test('组合输入期间不保存半成品，结束后立即落盘', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '组合事件耐久性只运行一次')
  await page.goto('/')
  await openSourceEditor(page)
  const editor = page.locator('.cm-content')
  await editor.dispatchEvent('compositionstart', { data: '' })
  await editor.fill('中文组合输入完成')
  await page.waitForTimeout(450)

  const duringComposition = await page.evaluate(() => {
    const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
      rounds?: Array<{ status: string; contentMd: string }>
    }
    return database.rounds?.find((round) => round.status === 'draft')?.contentMd
  })
  expect(duringComposition).toBe('')

  await editor.dispatchEvent('compositionend', { data: '中文组合输入完成' })
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })
  const afterComposition = await page.evaluate(() => {
    const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
      rounds?: Array<{ status: string; contentMd: string }>
    }
    return database.rounds?.find((round) => round.status === 'draft')?.contentMd
  })
  expect(afterComposition).toBe('中文组合输入完成')
})

test('所见即所得真实编辑仍会写回 Markdown', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '所见即所得写回只运行一次')
  await page.goto('/')
  const editor = page.locator('.wysiwyg-editor [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.fill('所见即所得真实编辑')
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
            rounds?: Array<{ status: string; contentMd: string }>
          }
          return database.rounds?.find((round) => round.status === 'draft')?.contentMd
        }),
      { timeout: 5_000 },
    )
    .toContain('所见即所得真实编辑')
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })
})

test('所见即所得保留源码单换行，并区分换行与分段', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '编辑器换行语义只运行一次')
  await page.goto('/')
  await enterMarkdown(page, '源码第一行\n源码第二行')
  const sourceTypography = await page.locator('.cm-content').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    }
  })
  await page.getByRole('button', { name: '所见即所得' }).click()

  const editor = page.locator('.wysiwyg-editor [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  const wysiwygTypography = await editor.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    }
  })
  expect(sourceTypography).toEqual(wysiwygTypography)
  const sourceLineLayout = await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const tops: Record<string, number> = {}
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent ?? ''
      for (const label of ['源码第一行', '源码第二行']) {
        const index = text.indexOf(label)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(walker.currentNode, index)
        range.setEnd(walker.currentNode, index + label.length)
        tops[label] = range.getBoundingClientRect().top
      }
    }
    return tops
  })
  expect(sourceLineLayout['源码第二行']).toBeGreaterThan(sourceLineLayout['源码第一行'])

  await editor.fill('当前文本')
  await editor.press('Enter')
  await editor.pressSequentially('继续换行')
  await editor.press('Control+Enter')
  await editor.pressSequentially('新的段落')

  await expect(editor.locator('p')).toHaveCount(2)
  await expect(editor.locator('p').first().locator('br')).toHaveCount(1)
  await expect(editor.locator('p').first()).toContainText('当前文本继续换行')
  await expect(editor.locator('p').nth(1)).toHaveText('新的段落')
  await page.screenshot({
    path: testInfo.outputPath('line-breaks.png'),
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Markdown 源码' }).click()
  const sourceEditor = page.locator('.cm-content')
  await sourceEditor.fill('源码段一')
  await sourceEditor.press('Control+Enter')
  await sourceEditor.pressSequentially('源码段二')
  await expect(page.locator('.source-editor .cm-line')).toHaveText(['源码段一', '', '源码段二'])
})

test('单独按 Ctrl 完成本轮，Ctrl+Enter 只用于分段', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '全局修饰键行为只运行一次')
  await page.goto('/')
  const editor = page.locator('.wysiwyg-editor [contenteditable="true"]').first()
  await editor.fill('准备完成的当前轮')
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })

  await editor.press('Control+Enter')
  await expect(page.getByText('本轮已保存，已开始新的草稿')).toHaveCount(0)
  await page.waitForTimeout(250)
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })

  await page.keyboard.press('Control')
  await expect(page.getByText('本轮已保存，已开始新的草稿')).toBeVisible()
  await expect(page.getByText('第 1 轮', { exact: true }).first()).toBeVisible()
})

test('源码光标位置在重启后恢复', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '光标持久化只运行一次')
  await page.goto('/')
  await openSourceEditor(page)
  const editor = page.locator('.cm-content')
  await editor.fill('abcdef')
  await editor.press('ArrowLeft')
  await editor.press('ArrowLeft')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
          rounds?: Array<{ status: string; contentMd: string }>
          viewStates?: Array<{ editorMode: string; cursorAnchor: number; cursorHead: number }>
        }
        const draft = database.rounds?.find((round) => round.status === 'draft')
        const view = database.viewStates?.[0]
        return {
          content: draft?.contentMd,
          mode: view?.editorMode,
          anchor: view?.cursorAnchor,
          head: view?.cursorHead,
        }
      }),
    )
    .toEqual({ content: 'abcdef', mode: 'source', anchor: 4, head: 4 })
  await page.reload()
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.locator('.cm-content').pressSequentially('X')
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 5_000 })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
          rounds?: Array<{ status: string; contentMd: string }>
        }
        return database.rounds?.find((round) => round.status === 'draft')?.contentMd
      }),
    )
    .toBe('abcdXef')
})

test('D1 与 D3 编辑性能测量入口', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '性能测量只运行一次')
  test.slow()
  await page.goto('/')
  await openSourceEditor(page)
  const editor = page.locator('.cm-content')

  const mediumContent = 'x'.repeat(100 * 1024)
  const mediumStartedAt = Date.now()
  await editor.fill(mediumContent)
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 15_000 })
  const mediumEditToSaveMs = Date.now() - mediumStartedAt

  const largeContent = 'x'.repeat(2 * 1024 * 1024)
  await page.evaluate((content) => {
    const key = 'vpr-browser-database-v1'
    const database = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      rounds: Array<{ status: string; contentMd: string; revision: number }>
    }
    const draft = database.rounds.find((round) => round.status === 'draft')
    if (!draft) throw new Error('D3 草稿不存在')
    draft.contentMd = content
    draft.revision += 1
    localStorage.setItem(key, JSON.stringify(database))
  }, largeContent)
  const largeLoadStartedAt = Date.now()
  await page.reload()
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '所见即所得' })).toBeDisabled()
  const largeLoadMs = Date.now() - largeLoadStartedAt
  await page.getByRole('button', { name: '安全预览' }).click()
  await expect(page.getByText('超大内容已使用有界纯文本预览')).toBeVisible()
  expect(
    await page.locator('.markdown-large-preview__content').evaluate((element) => {
      return element.textContent?.length ?? 0
    }),
  ).toBeLessThanOrEqual(256 * 1024)
  await page.screenshot({ path: testInfo.outputPath('large-bounded-preview.png'), fullPage: true })
  await page.getByRole('button', { name: 'Markdown 源码' }).click()
  const largeEditStartedAt = Date.now()
  await page.locator('.cm-content').press('End')
  await page.keyboard.type('y')
  await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 15_000 })
  const largeEditToSaveMs = Date.now() - largeEditStartedAt
  const measurements = { mediumEditToSaveMs, largeLoadMs, largeEditToSaveMs }
  console.info(
    `[PERF] D1 100KiB edit-to-save=${mediumEditToSaveMs}ms; D3 2MiB load=${largeLoadMs}ms edit-to-save=${largeEditToSaveMs}ms`,
  )
  await testInfo.attach('performance-d1-d3.json', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  })
})

test('窄屏抽屉、详情收起与模态焦点可用', async ({ page }, testInfo) => {
  test.skip(
    !['chromium-tablet', 'chromium-mobile'].includes(testInfo.project.name),
    '仅在窄屏项目运行',
  )
  await page.goto('/')
  await page.getByRole('button', { name: /收起详情/ }).click()
  await expect(page.getByRole('region', { name: '轮次时间线' })).toBeVisible()
  await page.getByRole('button', { name: '打开项目列表' }).click()
  await expect(page.getByRole('dialog', { name: '项目导航' })).toHaveClass(/is-open/)
  await page.getByRole('button', { name: '收起项目栏' }).click()

  await page.getByRole('button', { name: /搜索/ }).first().click()
  await expect(page.getByRole('searchbox', { name: '全文搜索' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '搜索全部项目' })).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true })
})

test('千轮时间线保持虚拟化并可定位尾部', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '压力用例只运行一次')
  const timestamp = Date.now()
  const projectId = 'stress-project'
  const rounds = Array.from({ length: 1_000 }, (_, index) => ({
    id: `stress-round-${index}`,
    projectId,
    position: index,
    status: 'final',
    contentMd: `## 压力轮次 ${index + 1}\n\n${'中文与 code sample\n'.repeat(100)}`,
    createdAt: timestamp + index,
    finalizedAt: timestamp + index,
    updatedAt: timestamp + index,
    revision: 1,
    note: `轮次 ${index + 1}`,
    deletedAt: null,
  }))
  const allRounds = [
    ...rounds,
    {
      id: 'stress-draft',
      projectId,
      position: 2_147_483_647,
      status: 'draft',
      contentMd: '',
      createdAt: timestamp + 2_000,
      finalizedAt: null,
      updatedAt: timestamp + 2_000,
      revision: 0,
      note: '',
      deletedAt: null,
    },
  ]
  await page.addInitScript(
    ({ projectId, rounds, timestamp }) => {
      localStorage.setItem(
        'vpr-browser-database-v1',
        JSON.stringify({
          nextProjectNumber: 2,
          projects: [
            {
              id: projectId,
              name: 'D2 千轮压力项目',
              isPinned: false,
              createdAt: timestamp,
              updatedAt: timestamp,
              lastOpenedAt: timestamp,
              deletedAt: null,
              revision: 1,
            },
          ],
          rounds,
          settings: {
            theme: 'neutral',
            previewLines: 5,
            showRoundNumbers: true,
            defaultEditorMode: 'source',
            alwaysOnTop: false,
            codeWrap: false,
            uiFontFamily: 'MiSans',
            uiFontSize: 14,
            uiFontWeight: 400,
            bodyFontFamily: 'MiSans',
            bodyFontSize: 16,
            bodyFontWeight: 400,
            bodyLineHeight: 1.65,
            codeFontFamily: 'Sarasa Mono SC',
            codeFontSize: 14,
            codeFontWeight: 400,
            codeLineHeight: 1.55,
            projectPanelWidth: 236,
            timelinePanelWidth: 340,
            autoBackup: true,
            lastProjectId: projectId,
          },
          viewStates: [
            {
              projectId,
              selectedRoundId: 'stress-draft',
              timelineAnchorRoundId: 'stress-round-0',
              anchorOffsetPx: 0,
              editorMode: 'source',
              cursorAnchor: 0,
              cursorHead: 0,
              detailOpen: false,
              updatedAt: timestamp,
            },
          ],
        }),
      )
    },
    { projectId, rounds: allRounds, timestamp },
  )
  const loadStartedAt = Date.now()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'D2 千轮压力项目' })).toBeVisible()
  const loadMs = Date.now() - loadStartedAt
  const cards = page.locator('.round-card')
  await expect(cards).not.toHaveCount(0)
  const initialDomCards = await cards.count()
  expect(initialDomCards).toBeLessThan(50)
  const scroller = page.locator('.timeline-list > div').first()
  const scrollStartedAt = Date.now()
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(page.getByText('当前草稿', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
  const scrollMs = Date.now() - scrollStartedAt
  const finalDomCards = await cards.count()
  expect(finalDomCards).toBeLessThan(50)
  expect(loadMs).toBeLessThan(5_000)
  expect(scrollMs).toBeLessThan(5_000)
  console.info(
    `[PERF] D2 1000x100 load=${loadMs}ms scroll-to-tail=${scrollMs}ms DOM=${initialDomCards}->${finalDomCards}`,
  )
  await testInfo.attach('performance.json', {
    body: JSON.stringify({ loadMs, scrollMs, initialDomCards, finalDomCards }, null, 2),
    contentType: 'application/json',
  })
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const database = JSON.parse(localStorage.getItem('vpr-browser-database-v1') ?? '{}') as {
          viewStates?: Array<{ projectId: string; timelineAnchorRoundId: string | null }>
        }
        return Boolean(
          database.viewStates?.find(
            (state) => state.projectId === id && state.timelineAnchorRoundId !== null,
          ),
        )
      }, projectId),
    )
    .toBe(true)
  await page.reload()
  await expect(page.getByText('当前草稿', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
})

test('100%、125%、150% 视觉缩放无横向溢出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '缩放矩阵只运行一次')
  await page.goto('/')
  for (const scale of [1, 1.25, 1.5]) {
    // 浏览器缩放会减少可用 CSS 像素；按固定 1440×900 物理窗口换算有效视口，
    // 比直接套 CSS zoom 更接近 Chromium 的响应式布局与断点行为。
    await page.setViewportSize({
      width: Math.floor(1440 / scale),
      height: Math.floor(900 / scale),
    })
    await expect(page.locator('.app-shell')).toBeVisible()
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    expect(overflow.document).toBeLessThanOrEqual(1)
    expect(overflow.body).toBeLessThanOrEqual(1)
    await page.screenshot({
      path: testInfo.outputPath(`zoom-${Math.round(scale * 100)}.png`),
      fullPage: true,
    })
  }
})
