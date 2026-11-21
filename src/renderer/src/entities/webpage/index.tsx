import { useState } from 'react'
import { WEB_PAGE_ENTITY, type WebPageConfig } from '@shared/builtinEntities'
import { TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityCreateFormProps } from '../types'
import { requestReload } from './reloadRequests'
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

function report(action: string): (result: { ok: boolean }) => void {
  return (result) => {
    if (!result.ok) console.error(`${action} failed`, result)
  }
}

export const webPageRenderer = defineEntityRenderer<WebPageConfig>({
  type: WEB_PAGE_ENTITY,
  icon: 'W',
  Body: WebPageBody,
  CreateForm: WebPageCreateForm,
  menuActions: ({ node, config }) => [
    {
      id: 'open-external',
      label: 'Open in default browser',
      onSelect: () => void window.spadeHost.files.openExternal(config.url).then(report('Opening the page'))
    },
    {
      id: 'copy-url',
      label: 'Copy URL',
      onSelect: () => void window.spadeHost.files.copyText(config.url).then(report('Copying the URL'))
    },
    { id: 'reload', label: 'Reload', disabled: node.collapsed, onSelect: () => requestReload(node.id) }
  ]
})
