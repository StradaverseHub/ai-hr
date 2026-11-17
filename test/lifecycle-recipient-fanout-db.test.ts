/** Approved 4a60b3ec: real case→SQL capture→lease→Auth credential checks→one injected SMTP call.
 * Credentials/relay are programmatic encrypted fixtures, not a human enrollment or real SMTP claim.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays } from '../lib/lifecycle-v9-model';
import { internalIssuer } from '../lib/internal-auth/config';
import { DUMMY_PASSWORD_HASH } from '../lib/internal-auth/crypto';
import { writeRecord } from '../lib/internal-auth/record-store';
import { internalLifecycleV9Mail } from '../lib/internal-auth/lifecycle-v9-mail';
import type { Credential } from '../lib/internal-auth/credential';
import type { MailTransport } from '../lib/internal-auth/smtp';
import { defaultEmailConfig } from '../lib/identity/email-model';
import { v9Setup, v9Workspace, v9SaveConfig, v9CreateOffboarding, v9Command, v9CaseDetail, v9DeliverEmails, onboardingContext, onboardingSaveConfig } from '../packs/lifecycle/service';
import { closeAll, migrateTestDb, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser } from './harness';
import type { SessionContext } from '../db/client';
import type { Base } from './harness';
let base: Base, admin: SessionContext, system: SessionContext;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base); system = { ...admin, userId: undefined, personId: null };
  vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://fanout.fixture.test'); vi.stubEnv('AUTH_SESSION_KEY', '8'.repeat(64));
  await v9Setup(admin);
  const native = await onboardingContext(admin); native.config.access.offboarding = [admin.userId!]; await onboardingSaveConfig(admin, native.revision, native.config);
  await writeRecord(owner.client, 'email-state', { revision: 'initial', active: { config: { ...defaultEmailConfig,
    host: 'smtp.fixture.test', from: 'sender@fixture.test', auth: false, user: '' } } }, null);
});
afterEach(() => vi.unstubAllEnvs()); afterAll(closeAll);
async function recipient(index: number) {
  const id = await createAppUser(base.tenantId, null, 'employee');
  const subject = randomUUID(), issuer = internalIssuer(base.tenantId), email = `member${index}@fixture.test`;
  const credential: Credential = { subject, tenantId: base.tenantId, issuer, organization: 'fixture', username: `member${index}`, email,
    enabled: true, emailVerified: true, password: DUMMY_PASSWORD_HASH, mustChange: false,
    version: randomUUID(), totpSecret: 'JBSWY3DPEHPK3PXP', lastStep: -1, recoveryHashes: [] };
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${id}::uuid)`;
  await writeRecord(owner.client, `credential:${subject}`, credential, subject);
  return { id, email, credential };
}
async function prepared() {
  const recipients = [];
  for (let i = 0; i < 12; i++) recipients.push(await recipient(i));
  const config = (await v9Workspace(admin)).config!;
  config.groups.push({ id: 'large-recipient-group', name: 'Fictional twelve-person group', members: recipients.map(user => user.id), limit: 0 });
  config.checklists = config.checklists.filter(checklist => checklist.module === 'onb');
  config.workflows = [{ id: 'shared-group-notice', name: 'Fictional shared group notice', module: 'off', status: 'published',
    trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], description: '',
    steps: [{ id: 'group-mail', type: 'notify', subject: 'Fictional shared notice', body: 'The same message for every group member.',
      to: ['group:large-recipient-group', 'address:MEMBER0@fixture.test'], cc: ['address:member1@fixture.test', 'address:archive@fixture.test'] }] }];
  await v9SaveConfig(admin, config.revision, config);
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional fanout subject' } });
  const id = await v9CreateOffboarding(admin, { employmentId: subject.employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(), 30) });
  await v9Command(admin, id, 1, { type: 'submit' });
  return { id, recipients };
}
it('captures thirteen resolved To keys from two choices and sends one copy to all twelve mailboxes, with To winning over CC', async () => {
  const { id, recipients } = await prepared();
  const pending = (await v9CaseDetail(admin, id)).case.mails.filter(mail => mail.workflowId === 'shared-group-notice');
  expect(pending).toHaveLength(1); expect(pending[0].to).toHaveLength(13);
  const jobs = await owner.client`select id,payload,status from lc_v9_email_delivery where case_id=${id}::uuid`;
  expect(jobs).toHaveLength(1); expect(jobs[0].payload.mail.to).toHaveLength(13); expect(jobs[0].status).toBe('queued');
  const transport = vi.fn<MailTransport>(async () => {});
  const result = await v9DeliverEmails(system, owner, request => internalLifecycleV9Mail(request, transport));
  expect(result).toEqual({ attempted: 1, sent: 1, held: 0, failed: 0 });
  expect(transport).toHaveBeenCalledOnce();
  const mail = transport.mock.calls[0][1];
  expect(Array.isArray(mail.to)).toBe(true);
  expect([...(mail.to as string[])].sort()).toEqual(recipients.map(user => user.email).sort());
  expect(mail.cc).toEqual(['archive@fixture.test']);
  expect(mail.subject).toBe('Fictional shared notice'); expect(mail.text).toBe('The same message for every group member.');
  const [receipt] = await owner.client`select status,started_at,completed_at,recipient_proof,payload from lc_v9_email_delivery where id=${jobs[0].id}::uuid`;
  expect(receipt.status).toBe('sent'); expect(receipt.started_at).toBeTruthy(); expect(receipt.completed_at).toBeTruthy();
  expect(receipt.payload).toEqual(jobs[0].payload);
  expect(receipt.recipient_proof.bindings).toHaveLength(12);
  expect(receipt.recipient_proof.addresses).toHaveLength(15);
  expect((await v9CaseDetail(admin, id)).case.mails.filter(mail => mail.workflowId === 'shared-group-notice')).toMatchObject([{ status: 'sent' }]);
  expect(await v9DeliverEmails(system, owner, request => internalLifecycleV9Mail(request, transport))).toEqual({ attempted: 0, sent: 0, held: 0, failed: 0 });
  expect(transport).toHaveBeenCalledOnce();
}, 90_000); // Twelve canonical Auth checks plus real case/capture/claim/receipt state transitions.
it('still holds the whole large group when one bound account is unavailable, and never starts SMTP', async () => {
  const { id, recipients } = await prepared();
  const disabled = { ...recipients[7].credential, enabled: false };
  await writeRecord(owner.client, `credential:${disabled.subject}`, disabled, disabled.subject);
  const transport = vi.fn<MailTransport>(async () => {});
  const result = await v9DeliverEmails(system, owner, request => internalLifecycleV9Mail(request, transport));
  expect(result.attempted).toBe(1); expect(result.sent).toBe(0); expect(transport).not.toHaveBeenCalled();
  const [receipt] = await owner.client`select started_at,recipient_proof from lc_v9_email_delivery where case_id=${id}::uuid`;
  expect(receipt.started_at).toBeNull(); expect(receipt.recipient_proof).toBeNull();
}, 90_000);
