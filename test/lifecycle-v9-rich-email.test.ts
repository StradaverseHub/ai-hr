/** Board 6bdda222: a saved rich body renders escaped HTML and text on send; a legacy body is untouched. */
import { expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { documentLinkToken } from '../lib/email-body/render';
import type { EmailBodyDoc } from '../lib/email-body/doc';

const image: M.EmailAsset = { id: '9ea43e78-c325-4f88-8313-1b6fc3a1a78e', kind: 'image', name: 'Fictional logo.png', mimeType: 'image/png', size: 20, contentHash: 'a'.repeat(64), at: '2026-10-29T00:00:00.000Z', by: 'Fictional HR', alt: 'Fictional company logo' };
const doc: EmailBodyDoc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Dear ' }, { type: 'field', attrs: { key: 'employee.name' } }, { type: 'text', text: ',', marks: [{ type: 'bold' }] }] },
  { type: 'table', attrs: { headerRow: true, widths: 'equal' }, content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'System' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Access' }] }] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Email' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'field', attrs: { key: 'company.name' } }] }] }] },
  ] },
  { type: 'paragraph', content: [{ type: 'image', attrs: { assetId: image.id, alt: 'Logo' } }, { type: 'text', text: 'Open the policy', marks: [{ type: 'link', attrs: { kind: 'web', href: 'https://policy.fictional.invalid/handbook' } }] }] },
] };
function fixture() {
  let sequence = 0;
  const environment: M.Environment = { today: '2026-10-30', now: '2026-10-30T00:00:00Z', actor: { id: 'hr', name: 'Fictional HR' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: () => true, userName: id => id, mergeValues: { 'employee.name': '<b>Ana & "Co"</b> {image:x} {employee.icNo}', 'company.name': 'Fictional Company' } };
  const c: M.Case = { version: 9, id: 'case', number: 'OFB-1', module: 'off', revision: 1, state: 'submitted', facts: { name: 'Fictional Person', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2026-10-01', lastDay: '2026-11-30', noticeDate: '2026-09-30', employeeUserId: 'employee', supervisorUserId: 'manager', pbpUserId: null, taUserId: null, businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'source', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '', finalFigures: null, review: null };
  const config: M.Config = { version: 9, revision: 1, checklists: [], templates: [], emails: [{ id: 'rich', name: 'Fictional rich email', module: 'off', active: true, sender: 'noreply', subject: 'Welcome {employee.name}', body: 'Dear {employee.name},', bodyDoc: doc, cc: [], links: [], attachments: [], slots: [], images: [image] }], workflows: [], groups: [], peopleOpsGroup: null, bpRules: [] };
  return { c, config, environment };
}
it('queues a version 2 delivery whose HTML escapes every merged value and whose text is readable', () => {
  const { c, config, environment } = fixture();
  M.queueEmail(c, config, 'rich', environment);
  const mail = c.mails[0];
  expect(mail.delivery).toMatchObject({ version: 2, sender: 'noreply', assets: [image] });
  const html = mail.delivery!.html!;
  expect(html).toContain('&lt;b&gt;Ana &amp; &quot;Co&quot;&lt;/b&gt; &#123;image:x&#125; &#123;employee.icNo&#125;');
  expect(html).not.toContain('<b>Ana');
  expect(html).toContain(`src="cid:v9-image.${image.id}@aihr"`); expect(html).toContain('alt="Fictional company logo"');
  expect(html).toContain('href="https://policy.fictional.invalid/handbook"'); expect(html).toContain('rel="noopener noreferrer"');
  expect(mail.body).toContain('System: Email'); expect(mail.body).toContain('Access: Fictional Company');
  expect(mail.body).toContain('Open the policy (https://policy.fictional.invalid/handbook)'); expect(mail.body).toContain('[Image: Fictional company logo]');
  expect(M.previewEmail(c, config, 'rich', environment)).toMatchObject({ html: expect.stringContaining('<table') });
});
it('keeps the legacy text path for a template without a rich body, and for a per-person text edit', () => {
  const { c, config, environment } = fixture();
  delete config.emails[0].bodyDoc; environment.mergeValues['employee.name'] = '<b>Ana & "Co"</b>';
  M.queueEmail(c, config, 'rich', environment);
  expect(c.mails[0].delivery?.version).toBe(1); expect(c.mails[0].delivery?.html).toBeUndefined();
  expect(c.mails[0].body).toBe('Dear <b>Ana & "Co"</b>,');
  const edited = fixture(); edited.environment.mergeValues['employee.name'] = 'Ana'; edited.c.emailEdits = { rich: { subject: 'Edited', body: 'Edited text for {employee.name}' } };
  M.queueEmail(edited.c, edited.config, 'rich', edited.environment);
  expect(edited.c.mails[0]).toMatchObject({ subject: 'Edited', delivery: { version: 1 } });
});
it('holds a rich send with missing values and refuses sensitive fields', () => {
  const { c, config, environment } = fixture(); delete environment.mergeValues['company.name'];
  expect(() => M.queueEmail(c, config, 'rich', environment)).toThrow('Complete missing merge fields: company.name');
  const sensitive = fixture(); sensitive.config.emails[0].bodyDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'field', attrs: { key: 'employee.icNo' } }] }] };
  expect(() => M.queueEmail(sensitive.c, sensitive.config, 'rich', sensitive.environment)).toThrow('Sensitive');
});
it('validates the stored body on save: unsafe links, unticked document links, missing alt text and free HTML', () => {
  const base = v9Defaults(), email = { ...structuredClone(fixture().config.emails[0]), module: 'off' as const };
  const withBody = (bodyDoc: unknown, patch: Partial<M.EmailTemplate> = {}) => { const config = structuredClone(base); config.emails.push({ ...email, ...patch, bodyDoc: bodyDoc as EmailBodyDoc }); return config; };
  expect(() => parseV9Config(withBody(doc))).not.toThrow();
  const link = (href: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { kind: 'web', href } }] }] }] });
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'https://{employee.name}.invalid', 'https://nodomain']) expect(() => parseV9Config(withBody(link(href)))).toThrow();
  expect(() => parseV9Config(withBody({ type: 'doc', content: [{ type: 'html', html: '<script>x</script>' }] }))).toThrow();
  const form = base.templates.find(template => template.module === 'off' && template.type === 'Form')!;
  const docLink = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open', marks: [{ type: 'link', attrs: { kind: 'document', documentId: form.id } }] }] }] };
  expect(() => parseV9Config(withBody(docLink))).toThrow('must also be ticked');
  expect(() => parseV9Config(withBody(docLink, { links: [form.id] }))).not.toThrow();
  expect(() => parseV9Config(withBody(doc, { images: [{ ...image, alt: '' }] }))).toThrow('alt text');
  expect(documentLinkToken(form.id)).toContain(form.id);
});
