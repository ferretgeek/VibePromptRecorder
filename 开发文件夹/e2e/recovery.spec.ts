import { expect, test } from '@playwright/test'

test('损坏数据进入只读恢复状态且不覆盖现场', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '恢复状态视觉证据只运行一次')
  await page.addInitScript(() => {
    localStorage.setItem('vpr-browser-database-v1', '{"projects":"broken"')
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: '工作区未能安全打开' })).toBeVisible()
  await expect(page.getByText(/原始数据已保留/)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('vpr-browser-database-v1'))).toBe(
    '{"projects":"broken"',
  )
  await page.screenshot({ path: testInfo.outputPath('recovery-error.png'), fullPage: true })
})
