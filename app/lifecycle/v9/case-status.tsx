'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Item, Task } from '@/lib/lifecycle-v9-model';
type Status = Task['status'] | Item['status'];
const labels: Record<Status, string> = { todo: 'To do', progress: 'In progress', done: 'Done', notNeeded: 'Not needed', notReturned: 'Not returned' };
export function CaseStatus({ name, kind, value, reason, busy, editable, documentLinked = false, change }: { name: string; kind: 'task' | 'item'; value: Status; reason: string; busy: boolean; editable: boolean; documentLinked?: boolean; change: (status: Status, reason: string) => Promise<{ ok: boolean; error?: string }> }) {
  const [pending, setPending] = useState<'notNeeded' | 'notReturned' | null>(null), [text, setText] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), fieldId = useId(), disabled = busy || saving || !editable;
  useEffect(() => { if (pending) dialog.current?.showModal(); }, [pending]);
  async function apply(status: Status, reason: string) {
    if (disabled || documentLinked && status === 'done') return;
    setSaving(true); setError('');
    try { const result = await change(status, reason); if (result.ok) setPending(null); else setError(result.error ?? 'The change could not be saved.'); }
    catch { setError('The change could not be saved. Your reason is still here. Try again.'); }
    finally { setSaving(false); }
  }
  function choose(status: Status) {
    if (kind === 'task' && status === 'notReturned') return;
    if (status === 'notNeeded' || status === 'notReturned') { setText(reason); setError(''); setPending(status); }
    else void apply(status, '');
  }
  return <div className="v9-stack"><select aria-label={`Status for ${name}`} value={value} disabled={disabled} onChange={event => choose(event.target.value as Status)}>{(['todo', 'progress', 'done', 'notNeeded', ...(kind === 'item' ? ['notReturned'] : [])] as Status[]).map(status => <option key={status} value={status} disabled={documentLinked && status === 'done'}>{labels[status]}</option>)}</select>
    {(value === 'notNeeded' || value === 'notReturned') && <div className="v9-muted">{reason}<button type="button" className="v9-link" disabled={disabled} onClick={() => choose(value)}>Edit reason</button></div>}
    {!pending && error && <p role="alert" className="v9-error">{error}</p>}
    {pending && <dialog ref={dialog} className="v9-dialog" aria-label={`${labels[pending]}: ${name}`} onCancel={event => { if (saving) event.preventDefault(); else setPending(null); }}><header><h2>{labels[pending]}: {name}</h2><button type="button" className="v9-button" disabled={saving} aria-label="Close reason" onClick={() => setPending(null)}>Close</button></header><div className="v9-stack"><label className="v9-field" htmlFor={fieldId}>Reason required<textarea id={fieldId} rows={4} maxLength={4000} value={text} disabled={busy || saving} onChange={event => setText(event.target.value)}/></label>{error && <p className="v9-notice v9-error" role="alert">{error}</p>}<button type="button" className="v9-button v9-button-primary" disabled={disabled || !text.trim()} onClick={() => void apply(pending, text.trim())}>{saving ? 'Saving…' : 'Confirm'}</button></div></dialog>}
  </div>;
}
