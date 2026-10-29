'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Case, Config } from '@/lib/lifecycle-v9-model';
export function CaseFiles({ c, config }: { c: Case; config: Config }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter(), [busy, start] = useTransition(), [slot, setSlot] = useState(''), [file, setFile] = useState<File | null>(null), [error, setError] = useState('');
  const options = new Map<string, string>(config.emails.filter(e => e.module === c.module).flatMap(e => e.slots.map(s => [`${e.id}:${s.id}`, `${e.name} · ${s.label}`] as const)));
  for (const workflow of [...config.workflows.filter(w => w.module === c.module), ...c.runs.flatMap(r => r.definition ? [r.definition] : [])]) for (const step of workflow.steps) if (step.type === 'waitFile') options.set(step.slot, step.label);
  return <section className="v9-panel v9-stack"><h2>Case files</h2><ul className="v9-list">{c.files.map(f => <li key={f.id}><a className="v9-link" href={`/lifecycle/v9/files/${c.id}?file=${encodeURIComponent(f.storageId)}`}>{f.name}</a><div className="v9-muted">{options.get(f.slot) ?? f.slot}</div></li>)}</ul>{!c.files.length && <p className="v9-muted">No files uploaded.</p>}
    {['pending', 'submitted'].includes(c.state) && options.size > 0 && <form className="v9-stack" onSubmit={event => {
      event.preventDefault(); if (!file || !slot) return; setError('');
      if (file.size > 10 * 1024 * 1024) { setError('Choose a file of at most 10 MB.'); return; }
      const data = new FormData(); data.set('file', file); data.set('slot', slot); data.set('revision', String(c.revision));
      start(async () => { try { const response = await fetch(`/lifecycle/v9/files/${c.id}`, { method: 'POST', body: data }); const result = await response.json(); if (!response.ok) setError(result.error ?? 'Upload failed. Refresh and try again.'); else { setFile(null); if (input.current) input.current.value = ''; router.refresh(); } } catch { setError('Upload failed. Refresh and try again.'); } });
    }}><label className="v9-field"><span>Attachment for</span><select value={slot} disabled={busy} required onChange={e => setSlot(e.target.value)}><option value="">Choose…</option>{[...options].map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label className="v9-field"><span>File (up to 10 MB)</span><input ref={input} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt" disabled={busy} required onChange={e => setFile(e.target.files?.[0] ?? null)}/></label><button type="submit" className="v9-button" disabled={busy || !slot || !file}>{busy ? 'Uploading…' : 'Upload file'}</button></form>}
    {error && <p role="alert" className="v9-error">{error}</p>}
  </section>;
}
