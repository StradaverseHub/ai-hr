import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ sql: vi.fn(), credential: vi.fn(), active: vi.fn(), principal: vi.fn(), pdf: vi.fn() }));
vi.mock('../db/client', () => ({ client: fixture.sql, withPoolWork:(_lane:string,work:()=>unknown)=>work(),withSystemWork:(work:()=>unknown)=>work() }));
vi.mock('../lib/internal-auth/config', () => ({ internalConfig: () => ({ origin: 'https://fictional.example' }), internalIssuer: (tenant: string) => 'https://fictional.example/auth/' + tenant }));
vi.mock('../lib/internal-auth/store', () => ({ admittedAuthSql: fixture.sql, readRecord: fixture.credential }));
vi.mock('../lib/internal-auth/active-relay', () => ({ readLifecycleRelayTx: fixture.active }));
vi.mock('../lib/internal-auth/service', () => ({ assertActiveCredential: fixture.principal, InternalAuthError: class extends Error {} }));
vi.mock('../lib/lifecycle-v9-pdf', () => ({ renderV9DocumentPdf: fixture.pdf }));
import { internalLifecycleV9Mail } from '../lib/internal-auth/lifecycle-v9-mail';
import { InternalAuthError } from '../lib/internal-auth/service';
import type { LifecycleV9MailTarget } from '../lib/lifecycle-v9-delivery-model';

let target: LifecycleV9MailTarget;
const request = { deliveryId: randomUUID(), leaseToken: randomUUID() }, userId = randomUUID(), tenantId = randomUUID(), subject = randomUUID();
const relay = { revision: 'applied-revision', senderName: 'Fictional Tenant Sender', relay: { config: { from: 'verified@fictional.invalid', fromName: 'Fictional connection name' }, password: 'private-fixture-relay-secret' } };
beforeEach(() => {
  vi.resetAllMocks();
  target = { id: request.deliveryId, tenantId, companyId: randomUUID(), caseId: randomUUID(), payload: { version: 1, number: 'OFB-FICTIONAL', subject: { personId: randomUUID(), employmentId: randomUUID() }, files: [], documents: [], mail: { id: randomUUID(), key: 'fixture', workflowId: null, templateId: null, to: [userId], cc: [], subject: 'Fictional saved subject', body: 'Fictional saved body', documentIds: [], fileIds: [], status: 'pending', test: false, at: '2026-10-29T00:00:00Z', deliveredAt: null, failure: null, delivery: { version: 1, queuedBy: { id: randomUUID(), name: 'Fictional HR' }, sender: 'hr', linkDocumentIds: [], pdfDocumentIds: [], toNames: ['Fictional employee'], ccNames: [] } } }, bindings: [{ userId, subject, issuer: 'https://fictional.example/auth/' + tenantId }] };
  fixture.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('email_target')) return [{ target }];
    if (sql.includes('email_files') || sql.includes('email_assets')) return [];
    if (sql.includes('email_start')) return [{ started: true }];
    if (sql.includes('email_finish')) return [{ finished: true }];
    throw Error('Unexpected private SQL');
  });
  fixture.active.mockResolvedValue(relay);
  fixture.credential.mockResolvedValue({ subject, tenantId, issuer: target.bindings[0].issuer, email: 'employee@fictional.invalid' });
  fixture.principal.mockResolvedValue({ app_user_id: userId, tenant_id: tenantId });
  fixture.pdf.mockResolvedValue({ bytes: Buffer.from('%PDF-saved-fixture'), pages: 1 });
});
const called = (fragment: string) => fixture.sql.mock.calls.some(call => call[0].join('?').includes(fragment));
it('accepts only delivery IDs, verifies the actual credential and sends after durable start', async () => {
  const transport = vi.fn(async () => { expect(called('email_start')).toBe(true); expect(called('email_finish')).toBe(false); });
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(fixture.active).toHaveBeenNthCalledWith(1, fixture.sql, tenantId);
  expect(fixture.credential).toHaveBeenCalledWith(fixture.sql, `credential:${subject}`);
  expect(transport).toHaveBeenCalledExactlyOnceWith(relay.relay, expect.objectContaining({ to: 'employee@fictional.invalid', cc: [], subject: 'Fictional saved subject', text: 'Fictional saved body', senderName: 'Fictional Tenant Sender', attachments: [], messageId: `<lifecycle-v9.${request.deliveryId}@fictional.example>` }));
  expect(called('email_finish')).toBe(true);
  await expect(internalLifecycleV9Mail({ ...request, to: 'injected@fictional.invalid' } as typeof request, transport)).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
});
it('refuses unavailable capabilities and inactive, changed or mismapped credentials before start', async () => {
  const transport = vi.fn();
  fixture.sql.mockResolvedValueOnce([{ target: null }]);
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'notEligible' });
  fixture.principal.mockRejectedValueOnce(new InternalAuthError('invalidLogin'));
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'recipientChanged' });
  fixture.principal.mockResolvedValueOnce({ app_user_id: randomUUID() });
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'recipientChanged' });
  fixture.credential.mockResolvedValueOnce({ subject: randomUUID(), tenantId, issuer: target.bindings[0].issuer, email: 'different@fictional.invalid' });
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'recipientChanged' });
  expect(called('email_start')).toBe(false); expect(transport).not.toHaveBeenCalled();
});
it('holds an unavailable relay without starting SMTP', async () => {
  fixture.active.mockResolvedValue(null); const transport = vi.fn();
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'relayUnavailable' });
  expect(called('email_start')).toBe(false); expect(transport).not.toHaveBeenCalled();
});
it('uses saved document bytes and canonical own-work links without fetching remote content', async () => {
  const document = { id: 'saved-document', name: 'Fictional saved letter', templateType: 'Letter' } as LifecycleV9MailTarget['payload']['documents'][number];
  target.payload.documents = [document]; target.payload.mail.documentIds = [document.id];
  target.payload.mail.delivery!.pdfDocumentIds = [document.id]; target.payload.mail.delivery!.linkDocumentIds = [document.id];
  const transport = vi.fn(async () => {}); await internalLifecycleV9Mail(request, transport);
  expect(fixture.pdf).toHaveBeenCalledExactlyOnceWith(document, 'OFB-FICTIONAL', false);
  expect(transport.mock.calls[0]).toEqual([relay.relay, expect.objectContaining({ text: `Fictional saved body\n\nFictional saved letter: https://fictional.example/me/lifecycle?case=${target.caseId}&document=saved-document`, attachments: [{ filename: 'Fictional saved letter.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-saved-fixture') }] })]);
});
it('rechecks a changed target at start and never sends after a refused start', async () => {
  fixture.sql.mockImplementation(async (strings: TemplateStringsArray) => strings.join('?').includes('email_target') ? [{ target }] : strings.join('?').includes('email_start') ? [{ started: false }] : []);
  const transport = vi.fn(); expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'notEligible' }); expect(transport).not.toHaveBeenCalled();
});
it('records unknown SMTP outcome as uncertain and never issues a second send', async () => {
  const transport = vi.fn(async () => { throw new Error('Controlled acknowledgement loss; do not log raw server data'); });
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'uncertain', error: 'uncertain' });
  expect(transport).toHaveBeenCalledOnce();
  const finish = fixture.sql.mock.calls.find(call => call[0].join('?').includes('email_finish'))!;
  expect(finish.slice(-2)).toEqual(['uncertain','uncertain']);
});
it('sends a freshly authorized onboarding contact without treating its address as an authentication identity', async () => {
  target.contact = { kind: 'onboardingContact', caseId: target.caseId, email: 'joiner-contact@fictional.invalid', sourceRevision: 'draft-1' };
  target.bindings = []; target.payload.mail.to = [target.contact.email]; target.payload.mail.delivery!.contact = target.contact;
  const transport = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(fixture.credential).not.toHaveBeenCalled(); expect(fixture.principal).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledExactlyOnceWith(relay.relay, expect.objectContaining({ to: 'joiner-contact@fictional.invalid', cc: [] }));
});
it('loads frozen shared files and inline image bytes before committing a single SMTP attempt', async () => {
  const file = { id: randomUUID(), kind: 'file' as const, name: 'Fictional handbook.txt', mimeType: 'text/plain', size: 8, contentHash: 'a'.repeat(64), at: '2026-10-29T00:00:00Z', by: 'Fictional HR' }, image = { ...file, id: randomUUID(), kind: 'image' as const, name: 'Fictional logo.png', mimeType: 'image/png' };
  target.payload.mail.delivery!.assets = [file,image]; target.payload.mail.body = `Saved <text>\n{image:${image.id}}`;
  fixture.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('email_target')) return [{ target }];
    if (sql.includes('email_assets')) return [file,image].map(asset => ({ id: asset.id, kind: asset.kind, filename: asset.name, mime_type: asset.mimeType, bytes: Buffer.from('fictional-bytes').toString('base64') }));
    if (sql.includes('email_files')) return [];
    if (sql.includes('email_start')) return [{ started: true }];
    if (sql.includes('email_finish')) return [{ finished: true }];
    throw Error('Unexpected private SQL');
  });
  const transport = vi.fn(async () => {}); expect(await internalLifecycleV9Mail(request,transport)).toEqual({ outcome: 'sent', error: null });
  expect(transport).toHaveBeenCalledExactlyOnceWith(relay.relay, expect.objectContaining({ text: 'Saved <text>\n[Image: Fictional logo.png]', html: expect.stringContaining(`src="cid:v9-image.${image.id}@aihr"`), attachments: [{ filename: file.name, contentType: 'text/plain', bytes: Buffer.from('fictional-bytes') }, { filename: image.name, contentType: 'image/png', bytes: Buffer.from('fictional-bytes'), cid: `v9-image.${image.id}@aihr` }] }));
});

it('keeps literal mailboxes separate from credentials while preserving mixed To and CC order', async () => {
  target.payload.mail.to = ['address:team@fictional.invalid']; target.payload.mail.cc = [userId, 'address:archive@fictional.invalid'];
  target.literals = [{ key: target.payload.mail.to[0], email: 'team@fictional.invalid', position: 1 }, { key: target.payload.mail.cc[1], email: 'archive@fictional.invalid', position: 3 }];
  const transport = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(fixture.credential).toHaveBeenCalledExactlyOnceWith(fixture.sql, `credential:${subject}`);
  expect(transport).toHaveBeenCalledExactlyOnceWith(relay.relay, expect.objectContaining({ to: 'team@fictional.invalid', cc: ['employee@fictional.invalid', 'archive@fictional.invalid'] }));
  const proof = JSON.parse(fixture.sql.mock.calls.find(call => call[0].join('?').includes('email_start'))!.at(-1));
  expect(proof).toMatchObject({ literals: target.literals, addresses: ['team@fictional.invalid', 'employee@fictional.invalid', 'archive@fictional.invalid'] });
});
it('sends one copy when an account and a typed address are the same mailbox, and holds a malformed literal', async () => {
  target.payload.mail.cc = ['address:employee@fictional.invalid'];
  target.literals = [{ key: target.payload.mail.cc[0], email: 'employee@fictional.invalid', position: 2 }];
  const sent = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, sent)).toEqual({ outcome: 'sent', error: null });
  expect(sent).toHaveBeenCalledWith(relay.relay, expect.objectContaining({ to: 'employee@fictional.invalid', cc: [] }));
  fixture.sql.mockClear();
  const transport = vi.fn();
  target.literals[0].email = 'changed@fictional.invalid';
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'recipientUnavailable' });
  expect(transport).not.toHaveBeenCalled();
});

it.each(['hr', 'onboarding', 'noreply'] as const)('sends a queued %s payload as the tenant sender name through the single binding and records it', async sender => {
  target.payload.mail.delivery!.sender = sender;
  const transport = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(fixture.active).toHaveBeenCalledWith(fixture.sql, tenantId);
  expect(transport).toHaveBeenCalledWith(relay.relay, expect.objectContaining({ senderName: 'Fictional Tenant Sender' }));
  const start = fixture.sql.mock.calls.find(call => call[0].join('?').includes('email_start'))!;
  expect(JSON.parse(start[4] as string)).toMatchObject({ senderProfile: 'noreply', senderName: 'Fictional Tenant Sender', senderAddress: 'verified@fictional.invalid', relayRevision: 'applied-revision' });
});
it('falls back to the connection name when the tenant has none, and refuses an unknown sender key', async () => {
  fixture.active.mockResolvedValue({ ...relay, senderName: null });
  const transport = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(transport.mock.calls[0]).not.toHaveProperty('1.senderName');
  const start = fixture.sql.mock.calls.find(call => call[0].join('?').includes('email_start'))!;
  expect(JSON.parse(start[4] as string)).toMatchObject({ senderName: 'Fictional connection name' });
  (target.payload.mail.delivery as { sender: string }).sender = 'a-person-to-impersonate';
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'notEligible' });
  expect(transport).toHaveBeenCalledOnce();
});
it('holds without sending when the sender name changes between resolution and start', async () => {
  fixture.active.mockResolvedValueOnce(relay).mockResolvedValueOnce({ ...relay, senderName: 'Renamed meanwhile' });
  const transport = vi.fn();
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'skipped', error: 'relayUnavailable' });
  expect(called('email_start')).toBe(false); expect(transport).not.toHaveBeenCalled();
});

it('sends one message to several To recipients together and keeps every address in the durable proof', async () => {
  target.payload.mail.to = [userId, 'address:work@fictional.invalid'];
  target.payload.mail.cc = ['address:copy@fictional.invalid'];
  target.literals = [{ key: 'address:work@fictional.invalid', email: 'work@fictional.invalid', position: 2 }, { key: 'address:copy@fictional.invalid', email: 'copy@fictional.invalid', position: 3 }];
  const transport = vi.fn(async () => {});
  expect(await internalLifecycleV9Mail(request, transport)).toEqual({ outcome: 'sent', error: null });
  expect(transport).toHaveBeenCalledExactlyOnceWith(relay.relay, expect.objectContaining({ to: ['employee@fictional.invalid', 'work@fictional.invalid'], cc: ['copy@fictional.invalid'] }));
  const proof = JSON.parse(fixture.sql.mock.calls.find(call => call[0].join('?').includes('email_start'))!.at(-1));
  expect(proof.addresses).toEqual(['employee@fictional.invalid', 'work@fictional.invalid', 'copy@fictional.invalid']);
  target.payload.mail.to = Array.from({ length: 9 }, (_, index) => `address:to${index}@fictional.invalid`);
  target.literals = target.payload.mail.to.map((key, index) => ({ key, email: key.slice(8), position: index + 2 }));
  target.payload.mail.cc = [];
  expect(await internalLifecycleV9Mail(request, transport)).toMatchObject({ outcome: 'skipped' });
  expect(transport).toHaveBeenCalledOnce();
});
