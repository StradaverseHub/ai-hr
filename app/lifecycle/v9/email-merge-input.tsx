'use client';

import { useId, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { lifecycleEmailFieldGroups } from '@/lib/lifecycle-v9-email-fields';

export function EmailMergeInput({ label, value, disabled, onChange, fieldGroups=lifecycleEmailFieldGroups, tokenBraces=1, copy }: {
  copy?:(key:string,values?:Record<string,string|number>)=>string;
  fieldGroups?:{label:string;fields:{key:string;label:string}[]}[];tokenBraces?:1|2;
  label: 'Subject' | 'Body';
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const l=(key:string,fallback:string,values?:Record<string,string|number>)=>copy?.(key,values)??fallback;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pickerId = useId();
  const field=l(label==='Subject'?'subject':'body',label.toLowerCase());
  const maxLength = label === 'Subject' ? 1000 : 20000;
  const term = query.trim().toLowerCase();
  const groups = fieldGroups.map(group => ({
    ...group,
    fields: group.fields.filter(option =>
      `${group.label} ${option.label} ${option.key} Personnel Management`.toLowerCase().includes(term)),
  })).filter(group => group.fields.length);

  function rememberSelection() {
    const element = input.current;
    if (element?.selectionStart != null && element.selectionEnd != null) {
      selection.current = { start: element.selectionStart, end: element.selectionEnd };
    }
  }

  function insert(key: string, name: string) {
    if (disabled) return;
    const { start, end } = selection.current ?? { start: value.length, end: value.length };
    const token = '{'.repeat(tokenBraces) + key + '}'.repeat(tokenBraces);
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > maxLength) {
      setAnnouncement(l('tooLong',`${name} exceeds the ${field} length limit.`,{name,field}));
      return;
    }
    const cursor = start + token.length;
    selection.current = { start: cursor, end: cursor };
    onChange(next);
    setOpen(false);
    setAnnouncement(l('inserted',`${name} inserted into the ${field}.`,{name,field}));
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }

  const inputProps = {
    value, maxLength, disabled,
    onSelect: rememberSelection, onBlur: rememberSelection,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };

  return <div className="v9-stack" onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <label className="v9-field">
      <span>{l(label==='Subject'?'subject':'body',label)}</span>
      {label === 'Subject'
        ? <input {...inputProps} className="v9-input" ref={element => { input.current = element; }} />
        : <textarea {...inputProps} rows={12} ref={element => { input.current = element; }} />}
    </label>
    <div className="v9-actions">
      <button ref={trigger} className="v9-button" type="button" disabled={disabled}
        aria-label={l('insertInto',`Insert field into ${field}`,{field})} aria-expanded={open && !disabled} aria-controls={pickerId}
        onClick={() => { setQuery(''); setOpen(!open); }}>
        {l('insertField','Insert field')} <ChevronDown aria-hidden size={14}/>
      </button>
      <span className="v9-muted" role="status">{announcement}</span>
    </div>
    {open && !disabled && <section id={pickerId} aria-label={l('fieldPanel',`${label} Personnel fields`,{field})}
      className="v9-panel v9-stack" style={{ width: 'min(24rem, 100%)', maxHeight: '18rem', overflowY: 'auto' }}>
      <input className="v9-input" type="search" autoFocus placeholder={l('searchFields','Search Personnel fields')}
        aria-label={l('searchFieldLabel',`Search ${field} fields`,{field})} value={query} onChange={event => setQuery(event.target.value)} />
      {groups.map(group => <div className="v9-stack" key={group.label}>
        <strong>{group.label}</strong>
        {group.fields.map(option => <button key={option.key} className="rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button"
          aria-label={`${option.label} · {${option.key}} · ${l('fieldSource','Personnel Management')}`}
          onClick={() => insert(option.key, option.label)}>
          <span className="block font-medium">{option.label}</span>
          <small className="v9-muted">{'{' + option.key + '}'} · {l('fieldSource','Personnel Management')}</small>
        </button>)}
      </div>)}
      {!groups.length && <p className="v9-muted">{l('noFields','No matching Personnel fields.')}</p>}
    </section>}
  </div>;
}
