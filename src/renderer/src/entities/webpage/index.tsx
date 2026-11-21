import { useState } from 'react'
import { WEB_PAGE_ENTITY, type WebPageConfig } from '@shared/builtinEntities'
import { DetailList, TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityBodyProps, EntityCreateFormProps } from '../types'

// Minimal placeholder: the viewer slice replaces this file wholesale.

function WebPageBody({ config }: EntityBodyProps<WebPageConfig>): React.JSX.Element {
  return (
    <div className="entity-summary">
      <DetailList rows={[['URL', <span className="mono">{config.url}</span>]]} />
    </div>
  )
}

function WebPageCreateForm({ formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          entityType: WEB_PAGE_ENTITY,
          config: { url: url.trim() },
          ...(title.trim() ? { title: title.trim() } : {})
        })
      }}
    >
      <TextField label="Title" value={title} onChange={setTitle} autoFocus />
      <TextField label="URL" value={url} onChange={setUrl} required placeholder="https://" monospace />
    </form>
  )
}

export const webPageRenderer = defineEntityRenderer<WebPageConfig>({
  type: WEB_PAGE_ENTITY,
  icon: 'W',
  Body: WebPageBody,
  CreateForm: WebPageCreateForm
})
