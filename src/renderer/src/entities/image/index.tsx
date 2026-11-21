import { useState } from 'react'
import { IMAGE_ENTITY, type ImageConfig } from '@shared/builtinEntities'
import { DetailList, TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityBodyProps, EntityCreateFormProps } from '../types'

// Minimal placeholder: the viewer slice replaces this file wholesale.

function ImageBody({ config }: EntityBodyProps<ImageConfig>): React.JSX.Element {
  const source = config.source.kind === 'path' ? config.source.path : `SPADE asset ${config.source.assetId}`
  return (
    <div className="entity-summary">
      <DetailList
        rows={[
          ['Source', <span className="mono">{source}</span>],
          ['Caption', config.caption ?? 'None']
        ]}
      />
    </div>
  )
}

function ImageCreateForm({ formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [path, setPath] = useState('')
  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          entityType: IMAGE_ENTITY,
          config: { source: { kind: 'path', path: path.trim() } },
          ...(title.trim() ? { title: title.trim() } : {})
        })
      }}
    >
      <TextField label="Title" value={title} onChange={setTitle} autoFocus />
      <TextField label="Path" value={path} onChange={setPath} required monospace hint="Absolute, or relative to the project root." />
    </form>
  )
}

export const imageRenderer = defineEntityRenderer<ImageConfig>({
  type: IMAGE_ENTITY,
  icon: 'I',
  Body: ImageBody,
  CreateForm: ImageCreateForm
})
