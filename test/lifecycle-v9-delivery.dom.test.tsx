import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../app/(app)/me/lifecycle/actions', () => ({ saveOwnLifecycleDocument: vi.fn(), updateOwnLifecycleTask: vi.fn() }));
import { EmployeeLifecycle } from '../app/(app)/me/lifecycle/view';
import { CaseMailHistory } from '../app/(app)/lifecycle/v9/mail-history';
import { CaseDocument } from '../app/(app)/lifecycle/v9/case-document';
import type { LifecycleV9OwnCase } from '../packs/lifecycle/service';
import type { Document, Mail } from '../lib/lifecycle-v9-model';
const doc: Document = { id: 'document', templateId: 'template', name: 'Fictional saved form', version: 1, status: 'sent', blocks: [{ id: 'note', type: 'text', text: 'Saved content', section: 'main' }], fields: [], values: {}, edits: {}, hrSignature: null, employeeSignature: null, createdAt: '2026-10-29T00:00:00Z', sentAt: '2026-10-29T00:00:00Z' };
const mail: Mail = { id: 'mail', key: 'message', workflowId: null, templateId: null, to: ['employee'], cc: ['manager'], subject: 'Fictional saved subject', body: 'Saved message', documentIds: [doc.id], fileIds: [], status: 'uncertain', test: false, at: '', deliveredAt: null, failure: 'uncertain', delivery: { version: 1, queuedBy: { id: 'hr', name: 'Fictional HR' }, sender: 'hr', linkDocumentIds: [doc.id], pdfDocumentIds: [], toNames: ['Original recipient'], ccNames: ['Original manager'] } };
it('shows the saved recipient labels and explicit uncertain outcome without claiming delivery', () => {
  render(<CaseMailHistory mails={[mail]} userName={() => 'Changed current name'}/>);
  expect(screen.getByText(/Delivery outcome uncertain · Original recipient · CC Original manager/)).toBeInTheDocument();
  expect(screen.getByText(/Review the delivery receipt before sending another copy/)).toBeInTheDocument();
  expect(screen.queryByText('Changed current name')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Sent/)).not.toBeInTheDocument();
});
it('opens only an existing authorized document selection and ignores an unknown document', () => {
  const c = { id: 'case', number: 'OB-FICTIONAL', state: 'submitted', own: true, facts: { name: 'Fictional employee' }, tasks: [], items: [], documents: [doc] } as unknown as LifecycleV9OwnCase;
  const view = render(<EmployeeLifecycle cases={[c]} initialSelection={{ caseId: c.id, documentId: doc.id }}/>);
  expect(screen.getByRole('heading', { level: 1, name: 'Fictional saved form' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', '/lifecycle/v9/documents/case/document');
  view.unmount(); render(<EmployeeLifecycle cases={[c]} initialSelection={{ caseId: c.id, documentId: 'unavailable-document' }}/>);
  expect(screen.getByRole('heading', { level: 1, name: 'My onboarding & offboarding' })).toBeInTheDocument();
});
it('keeps a queued draft read-only and hides signing and source refresh controls', () => {
  const draft = { ...doc, status: 'draft' as const, fields: [{ id: 'hr-note', label: 'HR note', type: 'text' as const, owner: 'hr' as const, pmKey: null, required: false, sensitive: false, options: [], section: 'main', when: null }], blocks: [{ id: 'hr-field', type: 'field' as const, text: '', fieldId: 'hr-note', section: 'main' }], hrStep: 'before' as const, signatoryUserId: 'hr' };
  render(<CaseDocument c={{ state: 'submitted', mails: [{ ...mail, status: 'pending', failure: null }] }} document={draft} actor={{ id: 'hr', name: 'Fictional HR' }} busy={false} command={vi.fn()}/>);
  expect(screen.getByLabelText('HR note')).toBeDisabled();
  expect(screen.getByText('This document is frozen for email delivery.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign and submit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Refresh Personnel values' })).not.toBeInTheDocument();
});
