import { useId, useState } from 'react'
import type { ConversationExpansionPreferences } from '@shared/domain'
import type { AppState } from '@shared/ipc'
import { useSpadeStore } from '../store/hooks'
import { Dialog } from '../ui/Dialog'
import { TextField } from '../ui/fields'

const EXPANSION_LABELS: Array<[keyof ConversationExpansionPreferences, string]> = [
  ['toolCall', 'Tool calls'],
  ['diff', 'Diffs'],
  ['html', 'HTML answers'],
  ['thinking', 'Thinking'],
  ['read', 'File reads']
]

// App-wide settings: conversation expansion defaults (plan §7.1) and the Paseo daemon address.
export function SettingsDialog({ app, onDone }: { app: AppState; onDone(): void }): React.JSX.Element {
  const store = useSpadeStore()
  const formId = useId()
  const [expansion, setExpansion] = useState(app.settings.conversationExpansion)
  const [paseoUrl, setPaseoUrl] = useState(app.settings.paseoUrl ?? '')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    const url = paseoUrl.trim()
    const saved = await store.updateSettings({ conversationExpansion: expansion, paseoUrl: url === '' ? null : url })
    setBusy(false)
    if (saved) onDone()
  }

  return (
    <Dialog
      open
      title="Settings"
      onCancel={onDone}
      footer={
        <>
          <button type="button" className="cr-button" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" form={formId} className="cr-button cr-button--primary" disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <fieldset className="settings-group">
          <legend>Conversations open expanded</legend>
          <p className="settings-group__hint">
            What an agent conversation shows expanded at first. You can still open or close any single item.
          </p>
          {EXPANSION_LABELS.map(([key, label]) => (
            <label key={key} className="cr-choice">
              <input
                type="checkbox"
                checked={expansion[key]}
                onChange={(event) => setExpansion((current) => ({ ...current, [key]: event.target.checked }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <TextField
          label="Paseo daemon URL"
          value={paseoUrl}
          onChange={setPaseoUrl}
          monospace
          placeholder="ws://127.0.0.1:6767/ws"
          hint={
            <>
              Empty: SPADE finds the local daemon automatically
              {app.paseo.url ? (
                <>
                  {' '}
                  (now <span className="mono">{app.paseo.url}</span>)
                </>
              ) : null}
              . Also accepts host:port or a port. Saving reconnects to the daemon at once.
            </>
          }
        />
      </form>
    </Dialog>
  )
}
