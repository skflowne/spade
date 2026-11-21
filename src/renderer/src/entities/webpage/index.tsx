import { useState } from 'react'
import { WEB_PAGE_ENTITY, type WebPageConfig } from '@shared/builtinEntities'
import type { CanvasNode } from '@shared/domain'
import type { Result } from '@shared/ipc'
import { TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityCreateFormProps } from '../types'
import { reloaderOf } from './reloadRequests'
import { normalizeWebAddress } from './webAddress'
import { WebPageBody } from './WebPageBody'

function WebPageCreateForm({ formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const [address, setAddress] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        const url = normalizeWebAddress(address)
        if (url === null) {
          setInvalid(true)
          return
        }
        onSubmit({ entityType: WEB_PAGE_ENTITY, config: { url } })
      }}
    >
      <TextField
        label="URL"
        value={address}
        onChange={(value) => {
          setAddress(value)
          setInvalid(false)
        }}
        required
        autoFocus
        placeholder="example.com"
        monospace
        hint={invalid ? <span className="webpage-form__error">Enter an http or https address.</span> : 'http or https; a bare host opens over https.'}
      />
    </form>
  )
}

// Why Reload cannot work right now, or null when it can.
function reloadUnavailable(node: CanvasNode): string | null {
  if (node.collapsed) return 'node collapsed'
  return reloaderOf(node.id) ? null : 'page not loaded'
}

export const webPageRenderer = defineEntityRenderer<WebPageConfig>({
  type: WEB_PAGE_ENTITY,
  icon: 'W',
  Body: WebPageBody,
  CreateForm: WebPageCreateForm,
  menuActions: ({ node, config, host }) => {
    const report =
      (action: string) =>
      (result: Result): void => {
        if (!result.ok) host.notify(`${action}: ${result.error.message}`)
      }
    const unavailable = reloadUnavailable(node)
    return [
      {
        id: 'open-external',
        label: 'Open in default browser',
        onSelect: () => void window.spadeHost.files.openExternal(config.url).then(report('Could not open the page'))
      },
      {
        id: 'copy-url',
        label: 'Copy URL',
        onSelect: () => void window.spadeHost.files.copyText(config.url).then(report('Could not copy the URL'))
      },
      {
        id: 'reload',
        label: unavailable ? `Reload (${unavailable})` : 'Reload',
        disabled: unavailable !== null,
        onSelect: () => {
          // The page may have gone between opening the menu and choosing.
          const reload = reloaderOf(node.id)
          if (reload) reload()
          else host.notify('The page is not loaded, so it cannot be reloaded.')
        }
      }
    ]
  }
})
