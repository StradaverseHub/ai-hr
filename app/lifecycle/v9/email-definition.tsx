'use client';
import { managedEmailSenderProfiles, managedEmailSenderNames } from '@/lib/managed-email-policy';
import { EmailAssets } from './email-assets';
import { RecipientPicker } from './recipient-picker';
import type { ReactNode } from 'react';
import type { EmailTemplate, Template } from '@/lib/lifecycle-v9-model';
const descriptions: Record<Template['type'], string> = { Form: 'Form · link to fill in and sign', Acknowledgement: 'Acknowledgement · link to sign', Letter: 'Letter · link, plus a PDF copy', Attachment: 'Attachment · sent as a PDF' };
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="v9-field"><span>{label}</span>{children}</label>; }
export function EmailDefinition({ email, templates, disabled, change, selectModule, hideName = false, revision, uploadsReady = false, groups = [], users = [] }: { groups?: import('@/lib/lifecycle-v9-model').Group[]; users?: { id: string; name: string }[]; revision?: number; uploadsReady?: boolean; email: EmailTemplate; templates: Template[]; disabled: boolean; hideName?: boolean; selectModule?: (module: EmailTemplate['module']) => void; change: (update: (next: EmailTemplate) => void) => void }) {
  const available = templates.filter(template => template.module === email.module), selected = available.filter(template => email.links.includes(template.id) || email.attachments.includes(template.id));
  function toggle(template: Template, checked: boolean) { change(next => { next.links = next.links.filter(id => id !== template.id); next.attachments = next.attachments.filter(id => id !== template.id); if (!checked) return; if (template.type !== 'Attachment') next.links.push(template.id); if (template.type === 'Letter' || template.type === 'Attachment') next.attachments.push(template.id); }); }
  return <>
    {!hideName && <Field label="Name"><input className="v9-input" maxLength={200} value={email.name} disabled={disabled} onChange={event => change(next => { next.name = event.target.value; })}/></Field>}
    <div className="v9-email-metadata">
    <Field label="Module"><select value={email.module} disabled={disabled} onChange={event => { const module = event.target.value as EmailTemplate['module']; change(next => { next.module = module; next.links = []; next.attachments = []; }); selectModule?.(module); }}><option value="onb">Onboarding</option><option value="off">Offboarding</option></select></Field>
    <Field label="Sender"><select value={email.sender} disabled={disabled} onChange={event => change(next => { next.sender = event.target.value; })}>{managedEmailSenderProfiles.map(profile => <option key={profile} value={profile}>{managedEmailSenderNames[profile]}</option>)}</select></Field>
    <label className="v9-actions"><input type="checkbox" checked={email.active} disabled={disabled || !email.subject.trim()} onChange={event => change(next => { next.active = event.target.checked; })}/>Active</label>
    </div>
    <Field label="Subject"><input className="v9-input" maxLength={1000} value={email.subject} disabled={disabled} onChange={event => change(next => { next.subject = event.target.value; })}/></Field>
    <Field label="Body"><textarea rows={12} maxLength={20000} value={email.body} disabled={disabled} onChange={event => change(next => { next.body = event.target.value; })}/></Field>

    <p className="v9-muted">Merge fields use {'{employee.name}'}, {'{company.name}'}, {'{joiner.joinDate}'} and {'{leaver.lastDay}'}. Sensitive identity, tax and banking fields cannot be emailed.</p>
    <EmailAssets section="images" email={email} revision={revision} ready={uploadsReady} disabled={disabled} change={change}/>
    <h3>Default CC</h3><RecipientPicker label="CC by default" value={email.cc} groups={groups} users={users} disabled={disabled} change={value => change(next => { next.cc = value; })}/>

    <fieldset className="v9-stack" disabled={disabled}><legend>Documents</legend>{available.map(template => <label key={template.id} className="v9-actions"><input type="checkbox" aria-label={`Include ${template.name}`} checked={selected.some(value => value.id === template.id)} onChange={event => toggle(template, event.target.checked)}/><span>{template.name}<small className="v9-muted"> · {descriptions[template.type]}</small></span></label>)}{!available.length && <p className="v9-muted">No document templates in this module.</p>}
    {selected.filter(template => template.type === 'Letter' || template.type === 'Attachment').map(template => <label key={template.id} className="v9-actions"><input type="checkbox" checked={email.attachments.includes(template.id)} disabled={disabled || template.type === 'Attachment'} onChange={event => change(next => { next.attachments = next.attachments.filter(id => id !== template.id); if (event.target.checked) next.attachments.push(template.id); })}/>{template.type === 'Letter' ? `Also attach a PDF copy of ${template.name}` : `${template.name} · always sent as a PDF`}</label>)}</fieldset>
    <EmailAssets section="files" email={email} revision={revision} ready={uploadsReady} disabled={disabled} change={change}/>
    <h3>Files uploaded per person</h3><p className="v9-muted">Upload a different file on each case, such as the person’s voucher or supporting letter. Required files hold the email until they are uploaded.</p>
    {email.slots.map(slot => <div className="v9-panel v9-stack" key={slot.id}><Field label="File label"><input className="v9-input" maxLength={500} value={slot.label} disabled={disabled} onChange={event => change(next => { next.slots.find(value => value.id === slot.id)!.label = event.target.value; })}/></Field><div className="v9-actions"><label><input type="checkbox" checked={slot.required} disabled={disabled} onChange={event => change(next => { next.slots.find(value => value.id === slot.id)!.required = event.target.checked; })}/>Required before sending</label><button type="button" className="v9-button v9-button-danger" disabled={disabled} onClick={() => change(next => { next.slots = next.slots.filter(value => value.id !== slot.id); })}>Remove file slot</button></div></div>)}
    <button type="button" className="v9-button" disabled={disabled || email.slots.length >= 50} onClick={() => change(next => { next.slots.push({ id: crypto.randomUUID(), label: 'File for this person', required: false }); })}>Add a file per person</button>
  </>;
}
