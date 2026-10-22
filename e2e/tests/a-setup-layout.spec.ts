import { expect, test } from '@playwright/test'
import { measureLayout, settleAnimations, WIDTHS } from '../support/layout'

// Runs first (file order, one worker): /setup only exists until household-library creates the first admin, so the
// zz-layout sweep can never reach it (#9). Looks only; creates nothing.
test('the first-run setup page fits every width', async ({ browser }) => {
  for (const size of WIDTHS) {
    const context = await browser.newContext({ viewport: size, hasTouch: size.width < 1024 })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('button', { name: 'Create admin account' })).toBeVisible()
    await settleAnimations(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `setup @${size.width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    await context.close()
  }
})
