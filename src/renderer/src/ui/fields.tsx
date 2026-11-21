import { useId, type ReactNode } from 'react'

type TextFieldProps = {
  label: string
  value: string
  onChange(value: string): void
  multiline?: boolean
  required?: boolean
  placeholder?: string
  hint?: ReactNode
  autoFocus?: boolean
  monospace?: boolean
}

// A labelled text input in the Control Room style. The label is always visible; placeholders are only examples.
export function TextField(props: TextFieldProps): React.JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const shared = {
    id,
    value: props.value,
    required: props.required,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus,
    'aria-describedby': props.hint ? hintId : undefined,
    className: props.monospace ? 'cr-input cr-input--mono' : 'cr-input'
  }
  return (
    <div className="cr-field">
      <label htmlFor={id}>{props.label}</label>
      {props.multiline ? (
        <textarea {...shared} rows={4} onChange={(event) => props.onChange(event.target.value)} />
      ) : (
        <input {...shared} type="text" onChange={(event) => props.onChange(event.target.value)} />
      )}
      {props.hint ? (
        <small id={hintId} className="cr-field__hint">
          {props.hint}
        </small>
      ) : null}
    </div>
  )
}

// Read-only key/value rows for showing a record's settings.
export function DetailList({ rows }: { rows: Array<[label: string, value: ReactNode]> }): React.JSX.Element {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div key={label} className="detail-list__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
