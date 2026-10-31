import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CaseEmails } from '../app/(app)/lifecycle/v9/email-composer';
import { readV9Email } from '../app/(app)/lifecycle/v9/actions';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { Case, EmailPreview } from '../lib/lifecycle-v9-model';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/(app)/lifecycle/v9/actions', () => ({ readV9Email: vi.fn() }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
const c = { id: 'case-id', module: 'off', revision: 3, state: 'submitted', facts: { name: 'Fictional leaver' }, emailEdits: {} } as Case;
function preview(holds: string[] = []): EmailPreview { return { emailId: 'e3', name: 'Acceptance email', subject: 'Hello Fictional leaver', body: 'Your reviewed letter is attached.', edit: { subject: 'Hello {employee.name}', body: 'Your reviewed letter is attached.' }, to: [{ id: 'employee', name: 'Fictional leaver' }], cc: [{ id: 'manager', name: 'Fixture manager' }], documents: [], holds, canSend: !holds.length }; }
function config() { const config = v9Defaults(); config.emails = [config.emails.find(email => email.id === 'e3')!]; return config; }
it('opens a read-only preview and shows the HR signature hold without sending or saving', async () => {
  const definition = config(), command = vi.fn().mockResolvedValue({ ok: true }); vi.mocked(readV9Email).mockResolvedValueOnce({ ok: true, preview: preview(['HR must review and sign the acceptance letter before sending.']) });
  render(<CaseEmails c={c} config={definition} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button', { name: `Preview ${definition.emails[0].name}` }));
  expect(await screen.findByText('Hello Fictional leaver')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Before this email can be sent' })).toHaveTextContent('HR must review and sign');
  expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled();
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'emailTest', emailId: 'e3' });
});
it('keeps per-person edits separate from the shared template', async () => {
  const definition = config(), original = structuredClone(definition), command = vi.fn().mockResolvedValue({ ok: true }); vi.mocked(readV9Email).mockResolvedValueOnce({ ok: true, preview: preview() });
  render(<CaseEmails c={c} config={definition} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button', { name: `Preview ${definition.emails[0].name}` }));
  await screen.findByText('Hello Fictional leaver');
  fireEvent.click(screen.getByRole('button', { name: 'Edit for this person' }));
  expect(screen.getByLabelText('Subject')).toHaveValue('Hello {employee.name}');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Reviewed for this person only.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save for this person' }));
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'emailEdit', emailId: 'e3', subject: 'Hello {employee.name}', body: 'Reviewed for this person only.' });
  expect(definition).toEqual(original);
});

it('retains per-person edits when the server rejects a stale write', async () => {
  const definition = config(), command = vi.fn().mockResolvedValue({ ok: false, error: 'This case changed. Refresh before trying again.' });
  vi.mocked(readV9Email).mockResolvedValueOnce({ ok: true, preview: preview() });
  render(<CaseEmails c={c} config={definition} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button', { name: `Preview ${definition.emails[0].name}` }));
  await screen.findByText('Hello Fictional leaver');
  fireEvent.click(screen.getByRole('button', { name: 'Edit for this person' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Retain this unsaved text.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save for this person' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This case changed.');
  expect(screen.getByLabelText('Message')).toHaveValue('Retain this unsaved text.');
});
it('previews only owned inline images and the actual shared-file references', async () => {
  const definition=config(),result=preview();
  const image={id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78e',kind:'image' as const,name:'Fictional logo.png',mimeType:'image/png',size:20,contentHash:'a'.repeat(64),at:'2026-10-29T00:00:00Z',by:'Fictional HR'};
  const file={...image,id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78f',kind:'file' as const,name:'Fictional handbook.txt',mimeType:'text/plain'};
  result.assets=[file,image];result.body=`Message text <script>literal</script>\n{image:${image.id}}`;
  vi.mocked(readV9Email).mockResolvedValueOnce({ok:true,preview:result});render(<CaseEmails c={c} config={definition} busy={false} command={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:`Preview ${definition.emails[0].name}`}));
  expect(await screen.findByRole('img',{name:image.name})).toHaveAttribute('src',`/lifecycle/v9/email-assets/${image.id}`);
  expect(screen.getByText(/Message text <script>literal<\/script>/)).toBeInTheDocument();
  expect(screen.getByRole('link',{name:file.name})).toHaveAttribute('href',`/lifecycle/v9/email-assets/${file.id}`);
});
it('places the person-specific upload slots on their email screen, including an inactive definition', async () => {
  const definition=config();definition.emails[0].active=false;definition.emails[0].slots=[{id:'voucher',label:'Individual voucher',required:true}];
  vi.mocked(readV9Email).mockResolvedValueOnce({ok:true,preview:preview(['This email template is inactive.'])});
  render(<CaseEmails c={{...c,files:[],runs:[],mails:[]}} config={definition} busy={false} command={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:`Preview ${definition.emails[0].name}`}));await screen.findByText('Hello Fictional leaver');
  expect(screen.getByRole('heading',{name:'Files for this person'})).toBeInTheDocument();
  expect(screen.getByRole('option',{name:'Resignation acceptance letter · Individual voucher'})).toBeInTheDocument();
  expect(screen.getByLabelText('File (up to 10 MB)')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Send email'})).toBeDisabled();
});
