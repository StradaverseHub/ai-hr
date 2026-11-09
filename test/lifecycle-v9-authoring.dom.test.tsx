import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EmailDefinition } from '../app/lifecycle/v9/email-definition';
import { newV9Email, newV9Template } from '../lib/lifecycle-v9-authoring';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { aiReviewDomHtml, captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
import type { Template } from '../lib/lifecycle-v9-model';
const actor = { id: 'fixture-hr', name: 'Fictional HR' };
const types: Template['type'][] = ['Form', 'Acknowledgement', 'Letter', 'Attachment'];
const templates = types.map(type => newV9Template(type, actor, type, '2026-10-29T02:00:00Z'));
function Editor() {
  const [email, setEmail] = useState(newV9Email('email'));
  return <><EmailDefinition email={email} templates={templates} disabled={false} change={update => setEmail(value => { const next = structuredClone(value); update(next); return next; })}/><output data-testid="definition">{JSON.stringify(email)}</output></>;
}
function saved() { return JSON.parse(screen.getByTestId('definition').textContent!); }
it('uses the source document transport rules and preserves the link when a letter PDF is unticked', () => {
  render(<Editor/>);
  for (const type of types) fireEvent.click(screen.getByRole('checkbox', { name: `Include New ${type.toLowerCase()}` }));
  expect(saved()).toMatchObject({ links: ['Form', 'Acknowledgement', 'Letter'], attachments: ['Letter', 'Attachment'] });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Also attach a PDF copy of New letter' }));
  expect(saved()).toMatchObject({ links: ['Form', 'Acknowledgement', 'Letter'], attachments: ['Attachment'] });
  expect(screen.getByRole('checkbox', { name: 'New attachment · always sent as a PDF' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'off' } });
  expect(saved()).toMatchObject({ module: 'off', links: [], attachments: [] });
});
it('creates per-person required file slots and saves an incomplete inactive email without activating it', () => {
  render(<Editor/>);
  expect(screen.getByRole('checkbox', { name: 'Active' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add a file per person' }));
  fireEvent.change(screen.getByLabelText('File label'), { target: { value: 'Individual voucher' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Required before sending' }));
  const config = v9Defaults(); config.emails.push(saved());
  expect(parseV9Config(config).emails.at(-1)).toMatchObject({ active: false, subject: '', slots: [{ label: 'Individual voucher', required: true }] });
  config.emails.at(-1)!.active = true;
  expect(() => parseV9Config(config)).toThrow('subject before activating');
  fireEvent.click(screen.getByRole('button', { name: 'Remove file slot' }));
  expect(saved().slots).toEqual([]);
});
it('creates unsigned editable drafts without introducing a signature into attachment PDFs', () => {
  const config = v9Defaults(); config.templates.push(...templates);
  const parsed = parseV9Config(config);
  expect(parsed.templates.find(template => template.id === 'Attachment')!.versions[0].blocks.some(block => block.type === 'signature')).toBe(false);
  expect(parsed.templates.find(template => template.id === 'Form')!.versions[0].fields).toMatchObject([{ id: 'field1', owner: 'employee' }]);
  expect(parsed.templates.find(template => template.id === 'Letter')).toMatchObject({ hrStep: 'before', employeeAck: true, versions: [{ state: 'draft', by: actor.name }] });
});
it('keeps an explicit default CC mailbox separate from directory people', () => {
  render(<Editor/>); fireEvent.click(screen.getByRole('button', { name: 'CC by default' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email address for CC by default' }), { target: { value: 'archive@fictional.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add email address' }));
  expect(saved().cc).toEqual(['address:archive@fictional.invalid']);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email: archive@fictional.invalid' }));
  expect(saved().cc).toEqual([]);
});

it('inserts allowed Personnel fields at the selected cursor range in the correct email input', () => {
  render(<Editor/>);
  const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' });
  fireEvent.change(body, { target: { value: 'Hello replacement today' } });
  body.focus();
  body.setSelectionRange(6, 17);
  fireEvent.blur(body);
  fireEvent.click(screen.getByRole('button', { name: 'Insert field into body' }));
  expect(screen.getByRole('button', { name: /Business unit · \{employee.businessUnit\}/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /IC number|Passport number|Religion|Race/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Position · \{employee.position\}/ }));
  expect(saved().body).toBe('Hello {employee.position} today');
  expect(screen.getByText('Position inserted into the body.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Insert field into subject' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search subject fields' }), { target: { value: 'date' } });
  expect(screen.getByRole('button', { name: /Last working date/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Join date/ }));
  expect(saved()).toMatchObject({ subject: '{joiner.joinDate}', body: 'Hello {employee.position} today' });
});

it('renders the Personnel field picker in the email template drawer', async () => {
  const view = render(<div className="v9-shell"><section className="v9-panel v9-stack">
    <h1>Email template</h1><Editor/>
  </section></div>);
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Welcome, {employee.name}' } });
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Welcome to {company.name}.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert field into body' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search body fields' }), { target: { value: 'organisation' } });
  expect(screen.getByRole('button', { name: /Business unit/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /Direct superior/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /Nationality/ })).toBeNull();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'lifecycle-email-template',
    'Actual template editor and filtered Personnel picker with fictional email content');
}, 120_000);
