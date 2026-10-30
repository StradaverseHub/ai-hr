'use client';
import { useState, useTransition } from 'react';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import type { EmailAsset, EmailTemplate } from '@/lib/lifecycle-v9-model';
const size = (bytes: number) => bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function EmailAssets({ email, revision, ready, disabled, change, section = 'both' }: { section?: 'images' | 'files' | 'both'; email: EmailTemplate; revision?: number; ready: boolean; disabled: boolean; change: (update: (email: EmailTemplate) => void) => void }) {
  const [busy, start] = useTransition(), [error, setError] = useState('');
  function upload(file: File | undefined, kind: 'file' | 'image') {
    if (!file || !revision || !ready || disabled || busy) return;
    setError('');
    if (!(kind === 'image' ? /\.(png|jpe?g|gif|webp)$/i : /\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|txt|csv)$/i).test(file.name)) { setError(kind === 'image' ? 'Use PNG, JPG, GIF or WebP for an email image.' : 'Use PDF, Word, Excel, CSV, text or an image.'); return; }
    if (!file.size || file.size > (kind === 'image' ? 1048576 : 10485760)) { setError(kind === 'image' ? 'Images in emails can be up to 1 MB.' : 'Files can be up to 10 MB.'); return; }
    const data = new FormData(); data.set('file', file); data.set('emailId', email.id); data.set('revision', String(revision)); data.set('kind', kind);
    start(async () => {
      try {
        const response = await fetch('/lifecycle/v9/email-assets', { method: 'POST', body: data }), result = await response.json() as { asset?: EmailAsset; error?: string };
        if (!response.ok || !result.asset) { setError(result.error ?? 'The email file could not be uploaded. Try again.'); return; }
        const asset = result.asset;
        change(next => { const field = kind === 'image' ? 'images' : 'files'; if (!next[field]?.some(existing => existing.id === asset.id)) next[field] = [...(next[field] ?? []), asset]; });
      } catch { setError('The email file could not be uploaded. Try again.'); }
    });
  }
  const blocked = disabled || busy || !revision || !ready;
  return <div className="v9-stack">
    {section !== 'files' && <><h3>Images in email</h3><p className="v9-muted">Upload up to three images, then insert them in the body. Use PNG, JPG, GIF or WebP, up to 1 MB each.</p>
    {(email.images ?? []).map(image => <div className="v9-panel v9-stack" key={image.id}><div className="v9-heading"><img src={`/lifecycle/v9/email-assets/${image.id}`} alt={image.name} style={{ maxWidth: 160, maxHeight: 100, objectFit: 'contain' }}/><div><strong>{image.name}</strong><p className="v9-muted">{size(image.size)} · {`{image:${image.id}}`}</p></div></div><div className="v9-actions"><button type="button" className="v9-button" disabled={disabled || busy} onClick={() => change(next => { next.body = next.body.trimEnd() + `\n\n{image:${image.id}}\n`; })}>Insert {image.name}</button><button type="button" className="v9-button" disabled={disabled || busy} onClick={() => change(next => { next.images = (next.images ?? []).filter(asset => asset.id !== image.id); next.body = next.body.split(`{image:${image.id}}`).join(''); })}>Remove image {image.name}</button></div></div>)}
    {(email.images?.length ?? 0) < 3 && <label className="v9-field"><span>Add image</span><input type="file" accept=".png,.jpg,.jpeg,.gif,.webp" disabled={blocked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; upload(file, 'image'); }}/></label>}
    </>}{section !== 'images' && <><h3>Files attached to every email</h3><p className="v9-muted">Shared files, such as the handbook, are attached to every email sent from this template.</p>
    <ul className="v9-list">{(email.files ?? []).map(file => <li key={file.id}><div className="v9-heading"><a className="v9-link" href={`/lifecycle/v9/email-assets/${file.id}`}>{file.name}</a><button type="button" className="v9-button" disabled={disabled || busy} onClick={() => change(next => { next.files = (next.files ?? []).filter(asset => asset.id !== file.id); })}>Remove file {file.name}</button></div><p className="v9-muted">{size(file.size)} · uploaded {new Date(file.at).toLocaleDateString('en-GB',{timeZone:HR_LOCAL_TZ})} by {file.by}</p></li>)}</ul>
    {(email.files?.length ?? 0) < 20 && <label className="v9-field"><span>Upload a shared file</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv" disabled={blocked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; upload(file, 'file'); }}/></label>}
    </>}{busy && <p role="status">Uploading…</p>}{error && <p role="alert" className="v9-error">{error}</p>}
  </div>;
}
