import { useRef, useState } from 'react'
import type { ConversationExpansionPreferences } from '@shared/domain'
import { effectiveExpansion, PANE_KINDS, withOverride, type ExpansionOverride, type PaneKind } from './expansion'
import { Popover } from './Popover'

type ExpansionControlProps = {
  global: ConversationExpansionPreferences
  override: ExpansionOverride | undefined
  onChange(override: ExpansionOverride | undefined): void
}

// Edits this conversation's override of which pane types start expanded.
export function ExpansionControl({ global, override, onChange }: ExpansionControlProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const effective = effectiveExpansion(global, override)
  const overridden = override !== undefined

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={overridden ? 'agent-toolbar__button agent-toolbar__button--set' : 'agent-toolbar__button'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Which panes start expanded in this conversation"
        onClick={() => setOpen(!open)}
      >
        Panes{overridden ? ' · custom' : ''}
      </button>
      {open && trigger.current ? (
        <Popover anchor={trigger.current} label="Expanded panes" onClose={() => setOpen(false)} className="agent-expansion">
          <p className="agent-expansion__title">Start expanded in this conversation</p>
          {PANE_KINDS.map(({ kind, label }) => (
            <ExpansionRow
              key={kind}
              kind={kind}
              label={label}
              checked={effective[kind]}
              custom={override?.[kind] !== undefined}
              onToggle={(value) => onChange(withOverride(override, kind, value, global))}
            />
          ))}
          <div className="agent-expansion__footer">
            <span className="agent-expansion__hint">Other panes follow the app defaults.</span>
            <button type="button" className="cr-button cr-button--ghost" disabled={!overridden} onClick={() => onChange(undefined)}>
              Use defaults
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  )
}

function ExpansionRow(props: {
  kind: PaneKind
  label: string
  checked: boolean
  custom: boolean
  onToggle(value: boolean): void
}): React.JSX.Element {
  return (
    <label className="cr-choice agent-expansion__row">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onToggle(event.target.checked)} />
      <span>{props.label}</span>
      {props.custom ? <span className="agent-expansion__custom">this conversation</span> : null}
    </label>
  )
}
