/** Private SMTP boundary only: no network, database or actual outgoing message. */
import { beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
const smtp = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.create } }));
import { sendSmtp, type Mail, type Relay } from '../lib/internal-auth/smtp';
import { MANAGED_EMAIL_ATTACHMENT_MAX_BYTES } from '../lib/managed-email-attachment';
const relay: Relay = { config: { host: 'smtp.fixture.invalid', port: 465, security: 'tls', from: 'verified@fixture.invalid', fromName: 'Fictional verified sender', replyTo: '', auth: false, user: '' } };
const to = 'employee@fixture.invalid', cc = 'supervisor@fixture.invalid';
function mail(): Extract<Mail, { attachments: unknown }> { return { to, cc: [cc], subject: 'Fictional saved document', text: 'Fictional case message.', messageId: '<v9-fixture-0001@fixture.invalid>', senderProfile: 'onboarding', attachments: [{ filename: 'Fictional form.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-fixture') }] }; }
beforeEach(() => { vi.resetAllMocks(); smtp.create.mockReturnValue({ sendMail: smtp.send, close: smtp.close }); smtp.send.mockResolvedValue({ accepted: [to, cc] }); });
it('hands local PDF bytes to Nodemailer with the verified relay address and exact To/CC envelope', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.setTitle('Fictional saved document'); const bytes = await pdf.save();
  const input = { ...mail(), attachments: [{ filename: 'Fictional saved form.pdf', contentType: 'application/pdf' as const, bytes: Buffer.from(bytes) }] };
  await sendSmtp(relay, input);
  const sent = smtp.send.mock.calls[0][0];
  expect(sent).toMatchObject({ from: { name: 'HR Onboarding', address: relay.config.from }, to, cc: [cc], envelope: { from: relay.config.from, to: [to, cc] }, messageId: input.messageId, disableFileAccess: true, disableUrlAccess: true });
  expect(Buffer.isBuffer(sent.attachments[0].content)).toBe(true); expect(sent.attachments[0].content).toEqual(Buffer.from(bytes));
  expect((await PDFDocument.load(sent.attachments[0].content)).getTitle()).toBe('Fictional saved document');
  expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({ tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, disableFileAccess: true, disableUrlAccess: true }));
  expect(smtp.send).toHaveBeenCalledOnce(); expect(smtp.close).toHaveBeenCalledOnce();
});
it.each([
  ['filesystem path', { attachments: [{ filename: 'document.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-'), path: '/etc/passwd' }] }],
  ['remote URL', { attachments: [{ filename: 'https://untrusted.invalid/document.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-') }] }],
  ['header injection', { attachments: [{ filename: 'document.pdf\r\nX-Test: injected', contentType: 'application/pdf', bytes: Buffer.from('%PDF-') }] }],
  ['duplicate recipient', { cc: [to.toUpperCase()] }],
  ['noncanonical recipient', { to: 'Employee <employee@fixture.invalid>' }],
  ['caller-supplied From address', { from: 'unverified@untrusted.invalid' }],
  ['unknown sender profile', { senderProfile: 'a-person-to-impersonate' }],
  ['missing delivery identity', { messageId: undefined }],
  ['too many files', { attachments: Array.from({ length: 21 }, () => ({ filename: 'document.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-') })) }],
])('rejects %s before opening SMTP', async (_name, override) => {
  await expect(sendSmtp(relay, { ...mail(), ...override } as unknown as Mail)).rejects.toMatchObject({ code: 'invalid' });
  expect(smtp.create).not.toHaveBeenCalled(); expect(smtp.send).not.toHaveBeenCalled();
});
it('limits the complete attachment set rather than each file alone', async () => {
  const bytes = Buffer.alloc(MANAGED_EMAIL_ATTACHMENT_MAX_BYTES / 2 + 1);
  await expect(sendSmtp(relay, { ...mail(), attachments: [{ filename: 'one.pdf', contentType: 'application/pdf', bytes }, { filename: 'two.pdf', contentType: 'application/pdf', bytes }] })).rejects.toMatchObject({ code: 'invalid' });
  expect(smtp.create).not.toHaveBeenCalled();
});
it('reports partial SMTP acceptance as uncertain and never retries a recipient', async () => {
  smtp.send.mockResolvedValue({ accepted: [to] });
  await expect(sendSmtp(relay, mail())).rejects.toMatchObject({ code: 'uncertain' });
  expect(smtp.send).toHaveBeenCalledOnce(); expect(smtp.close).toHaveBeenCalledOnce();
});
it('keeps plain CC outside the leased managed-delivery contract', async () => {
  const { attachments: _attachments, ...input } = mail() as Extract<Mail, { attachments: unknown }>;
  await expect(sendSmtp(relay, input as unknown as Mail)).rejects.toMatchObject({ code: 'invalid' });
  expect(smtp.create).not.toHaveBeenCalled();
});
it('sends owned image bytes with a bounded CID and inline disposition while keeping file access disabled', async () => {
  const id = '9ea43e78-c325-4f88-8313-1b6fc3a1a78e';
  await sendSmtp(relay,{ ...mail(), html: `<div><img src="cid:v9-image.${id}@aihr"/></div>`, attachments: [{ filename: 'Fictional logo.png', contentType: 'image/png', bytes: Buffer.from('fictional-image-bytes'), cid: `v9-image.${id}@aihr` }] });
  expect(smtp.send).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ filename: 'Fictional logo.png', contentType: 'image/png', content: Buffer.from('fictional-image-bytes'), cid: `v9-image.${id}@aihr`, contentDisposition: 'inline' }], disableFileAccess: true, disableUrlAccess: true }));
  smtp.create.mockClear();
  await expect(sendSmtp(relay,{ ...mail(), attachments: [{ filename: 'Fictional.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-'), cid: `v9-image.${id}@aihr` }] })).rejects.toMatchObject({ code: 'invalid' });
  expect(smtp.create).not.toHaveBeenCalled();
});
