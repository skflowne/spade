import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { canvasNode } from './ui-harness'

// Helpers shared by the entity renderer specs (image, web page).

// Opens the node menu and returns one of its entries, whose name starts with `label` (a disabled entry
// carries its reason after the label).
export async function menuEntry(page: Page, title: string, label: string): Promise<Locator> {
  await canvasNode(page, title).getByRole('button', { name: 'Node actions' }).click()
  return page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: new RegExp(`^${label}`) })
}

// From now on, calls of a bridge method fail in the main process with `message`.
export async function failInMain(app: ElectronApplication, method: string, message: string): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, [channel, text]) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({ ok: false, error: { code: 'scripted', message: text } }))
    },
    [`spade:${method}`, message] as const
  )
}

export function noticeAlerts(page: Page): Locator {
  return page.getByRole('region', { name: 'Notices' }).getByRole('alert')
}
