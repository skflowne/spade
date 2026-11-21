import { useState } from 'react'
import { IMAGE_ENTITY, type ImageConfig } from '@shared/builtinEntities'
import { resolveProjectPath } from '@shared/paths'
import { TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityCreateFormProps, EntityMenuAction } from '../types'
import { ImageBody } from './ImageBody'
import { copyImagePath, requestImage, revealImage, useFailureNotices } from './imageRequests'

function ImageCreateForm({ project, formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  useFailureNotices()
  const [path, setPath] = useState('')
  const [caption, setCaption] = useState('')
  const [pickFailure, setPickFailure] = useState<string | null>(null)

  const choose = async (): Promise<void> => {
    setPickFailure(null)
    try {
      const chosen = await window.spadeHost.files.pickImage(project.id)
      if (chosen !== null) setPath(chosen)
    } catch (error) {
      setPickFailure(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmedCaption = caption.trim()
        onSubmit({
          entityType: IMAGE_ENTITY,
          config: { source: { kind: 'path', path: path.trim() }, ...(trimmedCaption ? { caption: trimmedCaption } : {}) }
        })
      }}
    >
      <div className="image-form__pick">
        <TextField
          label="Path"
          value={path}
          onChange={setPath}
          required
          autoFocus
          monospace
          hint={
            pickFailure ? (
              <span className="image-form__error">{pickFailure}</span>
            ) : (
              'PNG, JPEG, GIF, WebP, or SVG. Absolute, or relative to the project root.'
            )
          }
        />
        <button type="button" className="cr-button" onClick={() => void choose()}>
          Choose image…
        </button>
      </div>
      <TextField label="Caption" value={caption} onChange={setCaption} />
    </form>
  )
}

export const imageRenderer = defineEntityRenderer<ImageConfig>({
  type: IMAGE_ENTITY,
  icon: 'I',
  Body: ImageBody,
  CreateForm: ImageCreateForm,
  menuActions: ({ node, config, project }) => {
    const path = config.source.kind === 'path' ? resolveProjectPath(project.rootPath, config.source.path) : null
    const fileActions: EntityMenuAction[] = path
      ? [
          { id: 'reveal', label: 'Reveal in Explorer', onSelect: () => void revealImage(project.id, path) },
          { id: 'copy-path', label: 'Copy path', onSelect: () => void copyImagePath(path) }
        ]
      : []
    return [
      ...fileActions,
      { id: 'full-size', label: 'Open full size', disabled: node.collapsed, onSelect: () => requestImage(node.id, 'full-size') },
      { id: 'reload', label: 'Reload', disabled: node.collapsed, onSelect: () => requestImage(node.id, 'reload') }
    ]
  }
})
