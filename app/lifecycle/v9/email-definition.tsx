'use client';
import { EmailAssets } from './email-assets';
import { EmailMergeInput } from './email-merge-input';
import { RecipientPicker } from './recipient-picker';
import { useMemo, useState, type ReactNode } from 'react';
import { EmailBodyEditor } from '@/components/email-body-editor';
import { legacyBodyToDoc, docToLegacyText } from '@/lib/email-body/legacy';
import { renderEmailBody, emailHtmlNearLimit } from '@/lib/email-body/render';
import { lifecycleEmailFieldGroups } from '@/lib/lifecycle-v9-email-fields';
import { personnelMergeLabels } from '@/lib/lifecycle-v9-personnel-merge-fields';
import { v9ImageCid } from '@/lib/lifecycle-v9-email-content';
import type { EmailTemplate, Template } from '@/lib/lifecycle-v9-model';
const descriptions: Record<Template['type'], string> = { Form: 'Form · link to fill in and sign', Acknowledgement: 'Acknowledgement · link to sign', Letter: 'Letter · link, plus a PDF copy', Attachment: 'Attachment · sent as a PDF' };
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="v9-field"><span>{label}</span>{children}</label>; }
export function EmailDefinition({ email, templates, disabled, change, selectModule, hideName = false, revision, uploadsReady = false, groups = [], users = [], sender, previewCases = [], loadPreview }: { previewCases?: { id: string; module: EmailTemplate['module']; label: string }[]; loadPreview?: (caseId: string) => Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }>; sender?: { name: string | null; configured: boolean }; groups?: import('@/lib/lifecycle-v9-model').Group[]; users?: { id: string; name: string }[]; revision?: number; uploadsReady?: boolean; email: EmailTemplate; templates: Template[]; disabled: boolean; hideName?: boolean; selectModule?: (module: EmailTemplate['module']) => void; change: (update: (next: EmailTemplate) => void) => void }) {
  const available = templates.filter(template => template.module === email.module), selected = available.filter(template => email.links.includes(template.id) || email.attachments.includes(template.id));
  const linkedInBody = useMemo(() => new Set<string>(JSON.stringify(email.bodyDoc ?? {}).match(/"documentId":"[^"]+"/g)?.map(match => match.slice(14, -1)) ?? []), [email.bodyDoc]);
  function toggle(template: Template, checked: boolean) { change(next => { next.links = next.links.filter(id => id !== template.id); next.attachments = next.attachments.filter(id => id !== template.id); if (!checked) return; if (template.type !== 'Attachment') next.links.push(template.id); if (template.type === 'Letter' || template.type === 'Attachment') next.attachments.push(template.id); }); }
  return <>
    {!hideName && <Field label="Name"><input className="v9-input" maxLength={200} value={email.name} disabled={disabled} onChange={event => change(next => { next.name = event.target.value; })}/></Field>}
    <div className="v9-email-metadata">
    <Field label="Module"><select value={email.module} disabled={disabled} onChange={event => { const module = event.target.value as EmailTemplate['module']; change(next => { next.module = module; next.links = []; next.attachments = []; }); selectModule?.(module); }}><option value="onb">Onboarding</option><option value="off">Offboarding</option></select></Field>
    <div className="v9-field" data-email-sender><span id="v9-email-sender-label">Sender</span><output aria-labelledby="v9-email-sender-label" className="v9-input v9-readonly">{sender ? sender.name ?? 'Email delivery is not set up' : 'Set by your email administrator'}</output><small className="v9-muted">Every On/Off Boarding email uses this sender name. Your email administrator manages it in Admin, Settings, Email delivery.</small></div>
    <label className="v9-actions"><input type="checkbox" checked={email.active} disabled={disabled || !email.subject.trim()} onChange={event => change(next => { next.active = event.target.checked; })}/>Active</label>
    </div>
    <EmailMergeInput label="Subject" value={email.subject} disabled={disabled} onChange={value => change(next => { next.subject = value; })}/>
    <RichBody email={email} templates={available} disabled={disabled} change={change} toggle={toggle} previewCases={previewCases.filter(c => c.module === email.module)} loadPreview={loadPreview}/>
    <p className="v9-muted">Use Insert field to add the employee's details at the cursor. Sensitive identity, tax and banking fields can't be emailed, so they aren't listed.</p>
    <EmailAssets section="images" richBody email={email} revision={revision} ready={uploadsReady} disabled={disabled} change={change}/>
    <h3>Default CC</h3>{email.recipientReview && <div className="v9-notice v9-warning" data-recipient-review><span>The Default CC of this template was converted automatically. Check it.</span> <button type="button" className="v9-button" disabled={disabled} onClick={() => change(next => { delete next.recipientReview; })}>Recipients checked</button></div>}<RecipientPicker module={email.module} label="CC by default" value={email.cc} groups={groups} users={users} disabled={disabled} change={value => change(next => { next.cc = value; })}/>

    <fieldset className="v9-stack" disabled={disabled}><legend>Documents</legend>{available.map(template => <label key={template.id} className="v9-actions"><input type="checkbox" aria-label={`Include ${template.name}`} checked={selected.some(value => value.id === template.id)} onChange={event => { if (!event.target.checked && linkedInBody.has(template.id)) { window.alert(`${template.name} is linked in the body. Remove the link first.`); return; } toggle(template, event.target.checked); }}/><span>{template.name}<small className="v9-muted"> · {descriptions[template.type]}</small></span></label>)}{!available.length && <p className="v9-muted">No document templates in this module.</p>}
    {selected.filter(template => template.type === 'Letter' || template.type === 'Attachment').map(template => <label key={template.id} className="v9-actions"><input type="checkbox" checked={email.attachments.includes(template.id)} disabled={disabled || template.type === 'Attachment'} onChange={event => change(next => { next.attachments = next.attachments.filter(id => id !== template.id); if (event.target.checked) next.attachments.push(template.id); })}/>{template.type === 'Letter' ? `Also attach a PDF copy of ${template.name}` : `${template.name} · always sent as a PDF`}</label>)}</fieldset>
    <EmailAssets section="files" email={email} revision={revision} ready={uploadsReady} disabled={disabled} change={change}/>
    <h3>Files uploaded per person</h3><p className="v9-muted">Upload a different file on each case, such as the person’s voucher or supporting letter. Required files hold the email until they are uploaded.</p>
    {email.slots.map(slot => <div className="v9-panel v9-stack" key={slot.id}><Field label="File label"><input className="v9-input" maxLength={500} value={slot.label} disabled={disabled} onChange={event => change(next => { next.slots.find(value => value.id === slot.id)!.label = event.target.value; })}/></Field><div className="v9-actions"><label><input type="checkbox" checked={slot.required} disabled={disabled} onChange={event => change(next => { next.slots.find(value => value.id === slot.id)!.required = event.target.checked; })}/>Required before sending</label><button type="button" className="v9-button v9-button-danger" disabled={disabled} onClick={() => change(next => { next.slots = next.slots.filter(value => value.id !== slot.id); })}>Remove file slot</button></div></div>)}
    <button type="button" className="v9-button" disabled={disabled || email.slots.length >= 50} onClick={() => change(next => { next.slots.push({ id: crypto.randomUUID(), label: 'File for this person', required: false }); })}>Add a file per person</button>
  </>;
}

const fields = lifecycleEmailFieldGroups.flatMap(group => group.fields.map(field => ({ key: field.key, label: field.label })));
/** Board 6bdda222: the rich body. A legacy text body opens converted without loss; nothing is written until it is edited. */
function RichBody({ email, templates, disabled, change, toggle, previewCases, loadPreview }: { email: EmailTemplate; templates: Template[]; disabled: boolean; change: (update: (next: EmailTemplate) => void) => void; toggle: (template: Template, checked: boolean) => void; previewCases: { id: string; label: string }[]; loadPreview?: (caseId: string) => Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }> }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit'), [width, setWidth] = useState<'desktop' | 'phone'>('desktop'), [format, setFormat] = useState<'email' | 'text'>('email');
  const [sample, setSample] = useState(''), [values, setValues] = useState<Record<string, string>>({}), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const doc = useMemo(() => email.bodyDoc ?? legacyBodyToDoc(email.body, (email.images ?? []).map(image => ({ id: image.id, name: image.name }))), [email.bodyDoc, email.body, email.images]);
  const preview = useMemo(() => { if (mode !== 'preview') return null; try { return renderEmailBody(doc, { values, readableMissing: true, missingLabel: key => personnelMergeLabels.get(key), images: (email.images ?? []).map(image => ({ id: image.id, alt: image.alt || image.name, cid: v9ImageCid(image.id) })), documentLink: id => { const template = templates.find(candidate => candidate.id === id); return template ? { name: template.name } : null; } }); } catch (cause) { return { error: cause instanceof Error ? cause.message : 'The preview could not be shown.' }; } }, [mode, doc, values, email.images, templates]);
  const html = preview && 'html' in preview ? preview.html.replace(/src="cid:v9-image\.([0-9a-f-]{36})@aihr"/g, (_, id: string) => `src="/lifecycle/v9/email-assets/${id}"`) : '';
  return <div className="v9-stack" data-rich-body>
    <div className="v9-actions" role="tablist" aria-label="Body view">{(['edit', 'preview'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={mode === value} className={'v9-button' + (mode === value ? ' v9-button-primary' : '')} onClick={() => setMode(value)}>{value === 'edit' ? 'Edit' : 'Preview'}</button>)}</div>
    {mode === 'edit' ? <EmailBodyEditor aria-label="Body" value={doc} disabled={disabled} fields={fields} images={(email.images ?? []).map(image => ({ id: image.id, name: image.name, alt: image.alt ?? '', src: `/lifecycle/v9/email-assets/${image.id}` }))} documents={templates.map(template => ({ id: template.id, name: template.name, kind: template.type === 'Acknowledgement' ? 'acknowledgement' : 'form' }))}
      onDocumentLinked={id => { const template = templates.find(candidate => candidate.id === id); if (template && !email.links.includes(id)) { toggle(template, true); setNotice(`${template.name} is now ticked under Documents.`); } }}
      onChange={next => { if (JSON.stringify(next) === JSON.stringify(doc)) return; change(draft => { draft.bodyDoc = next; draft.body = docToLegacyText(next); }); }}/>
    : <div className="v9-stack">
      <div className="v9-actions">
        <label className="v9-field"><span>Sample person</span><select value={sample} onChange={event => { const id = event.target.value; setSample(id); setError(''); if (!id) { setValues({}); return; } void loadPreview?.(id).then(result => { if (result.ok) setValues(result.values); else setError(result.error); }); }}><option value="">Sample data</option>{previewCases.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <div role="group" aria-label="Width" className="v9-actions">{(['desktop', 'phone'] as const).map(value => <button key={value} type="button" aria-pressed={width === value} className="v9-button" onClick={() => setWidth(value)}>{value === 'desktop' ? 'Desktop' : 'Phone'}</button>)}</div>
        <div role="group" aria-label="Format" className="v9-actions">{(['email', 'text'] as const).map(value => <button key={value} type="button" aria-pressed={format === value} className="v9-button" onClick={() => setFormat(value)}>{value === 'email' ? 'Email' : 'Plain text'}</button>)}</div>
      </div>
      {error && <p role="alert" className="v9-notice v9-error">{error}</p>}
      {preview && 'error' in preview ? <p role="alert" className="v9-notice v9-error">{preview.error}</p> : preview && <>
        {preview.missing.length > 0 && <p role="status" className="v9-notice v9-warning" data-preview-missing>Missing values: {preview.missing.map(key => personnelMergeLabels.get(key) ?? key).join(', ')}. Emails are never sent with brackets.</p>}
        {emailHtmlNearLimit(preview.html) && <p role="status" className="v9-notice v9-warning">This email is close to 100 KB. Gmail may cut off the end.</p>}
        <div className="v9-panel" data-preview-width={width} style={{ maxWidth: width === 'phone' ? 360 : 640 }}>{format === 'email' ? <div data-preview-html dangerouslySetInnerHTML={{ __html: html }}/> : <pre className="v9-prewrap" data-preview-text>{preview.text}</pre>}</div>
      </>}
    </div>}
    {notice && <p role="status" className="v9-muted">{notice}</p>}
  </div>;
}
