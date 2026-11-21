import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react'
import { Dialog } from './Dialog'
import { TextField } from './fields'

export type ConfirmOptions = {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
}

export type TextPromptOptions = {
  title: string
  label: string
  initialValue: string
  confirmLabel: string
  // The field may be left empty; the prompt then resolves with ''.
  optional?: boolean
  hint?: string
}

type Prompts = {
  confirm(options: ConfirmOptions): Promise<boolean>
  // Resolves with the trimmed text, or null when cancelled.
  promptText(options: TextPromptOptions): Promise<string | null>
}

const PromptsContext = createContext<Prompts | null>(null)

export function usePrompts(): Prompts {
  const prompts = useContext(PromptsContext)
  if (!prompts) throw new Error('usePrompts must be used inside PromptsProvider')
  return prompts
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve(value: boolean): void }
  | { kind: 'text'; options: TextPromptOptions; resolve(value: string | null): void }

// App-wide confirmation and single-field dialogs, one at a time.
export function PromptsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    []
  )
  const promptText = useCallback(
    (options: TextPromptOptions) =>
      new Promise<string | null>((resolve) => setPending({ kind: 'text', options, resolve })),
    []
  )
  const prompts = useMemo(() => ({ confirm, promptText }), [confirm, promptText])

  return (
    <PromptsContext.Provider value={prompts}>
      {children}
      {pending?.kind === 'confirm' ? (
        <ConfirmDialog
          options={pending.options}
          onDone={(value) => {
            setPending(null)
            pending.resolve(value)
          }}
        />
      ) : null}
      {pending?.kind === 'text' ? (
        <TextPromptDialog
          options={pending.options}
          onDone={(value) => {
            setPending(null)
            pending.resolve(value)
          }}
        />
      ) : null}
    </PromptsContext.Provider>
  )
}

function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone(value: boolean): void }): React.JSX.Element {
  return (
    <Dialog
      open
      alert
      title={options.title}
      description={options.message}
      onCancel={() => onDone(false)}
      footer={
        <>
          <button type="button" className="cr-button" onClick={() => onDone(false)} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className={options.danger ? 'cr-button cr-button--danger' : 'cr-button cr-button--primary'}
            onClick={() => onDone(true)}
          >
            {options.confirmLabel}
          </button>
        </>
      }
    />
  )
}

function TextPromptDialog({
  options,
  onDone
}: {
  options: TextPromptOptions
  onDone(value: string | null): void
}): React.JSX.Element {
  const [value, setValue] = useState(options.initialValue)
  const formId = useId()
  return (
    <Dialog
      open
      title={options.title}
      onCancel={() => onDone(null)}
      footer={
        <>
          <button type="button" className="cr-button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="cr-button cr-button--primary"
            disabled={!options.optional && !value.trim()}
          >
            {options.confirmLabel}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault()
          if (options.optional || value.trim()) onDone(value.trim())
        }}
      >
        <TextField
          label={options.label}
          value={value}
          onChange={setValue}
          required={!options.optional}
          hint={options.hint}
          autoFocus
        />
      </form>
    </Dialog>
  )
}
