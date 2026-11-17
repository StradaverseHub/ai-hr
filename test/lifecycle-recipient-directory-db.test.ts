import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { saveEmployeeDraft } from '../core/employee-draft';
import { todayInKualaLumpur } from '../lib/hr-date';
import { internalIssuer } from '../lib/internal-auth/config';
import { encryptRecord } from '../lib/internal-auth/crypto';
import type { Credential } from '../lib/internal-auth/credential';
import { searchOnboardingRecipientUsers, lifecycleRecipientAddressesTx } from '../packs/lifecycle/v9/recipient-directory';
import { v9Setup, v9CreateOffboarding, onboardingContext, onboardingSaveConfig, onboardingList } from '../packs/lifecycle/service';
import { closeAll, migrateTestDb, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
let base: Base, admin: SessionContext, caseId: string;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.fixture.test'); vi.stubEnv('AUTH_SESSION_KEY', '9'.repeat(64));
  await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  await v9Setup(admin);
  const config = await onboardingContext(admin); config.config.access.onboarding = [admin.userId!]; config.config.access.offboarding = [admin.userId!];
  await onboardingSaveConfig(admin, config.revision, config.config);
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional directory joiner', primaryEmail: 'directory-joiner@fixture.test' },
    employment: { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } } });
  caseId = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!.case.id;
});
afterEach(() => vi.unstubAllEnvs()); afterAll(closeAll);
async function account(name = 'Fictional Recipient', tenantId = base.tenantId) {
  const [person] = await owner.db.insert(schema.person).values({ tenantId, fullName: name, primaryEmail: `${randomUUID()}@personnel.fixture.test` }).returning();
  const id = await createAppUser(tenantId, person.id, 'employee');
  const subject = randomUUID(), issuer = internalIssuer(tenantId);
  const credential: Credential = { subject, tenantId, issuer, organization: 'fixture', username: subject,
    email: `${id}@account.fixture.test`, emailVerified: true, enabled: true, password: 'fixture-hash', mustChange: false,
    version: randomUUID(), totpSecret: 'fixture-mfa', lastStep: -1, recoveryHashes: [] };
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${id}::uuid)`;
  await store(credential);
  return { id, personId: person.id, credential };
}
async function store(c: Credential) {
  const sealed = encryptRecord(c, `credential:${c.subject}`, null);
  await owner.client`insert into app_internal_auth_record(record_key,owner_id,sealed) values(${`credential:${c.subject}`},${c.subject}::uuid,${sealed}) on conflict(record_key) do update set sealed=excluded.sealed`;
}
const addresses = (ids: string[], who = admin, target = caseId) => withTenant(who, tx => lifecycleRecipientAddressesTx(tx, who, target, ids));
it('returns bounded canonical account addresses, never PM email or sealed credentials, for authorized native and offboarding cases', async () => {
  const user = await account();
  expect(await searchOnboardingRecipientUsers(admin, caseId, 'Fictional Recipient')).toEqual([{ id: user.id, name: 'Fictional Recipient', email: user.credential.email, department: '' }]);
  expect(await addresses([user.id, user.id])).toEqual({ [user.id]: user.credential.email });
  const hired = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional offboarding subject', primaryEmail: 'directory-offboarding@fixture.test' } });
  const off = await v9CreateOffboarding(admin, { employmentId: hired.employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: '2027-01-01' });
  expect(await addresses([user.id], admin, off)).toEqual({ [user.id]: user.credential.email });
  await expect(searchOnboardingRecipientUsers(admin, off, 'Fictional')).rejects.toThrow();
  expect(await searchOnboardingRecipientUsers(admin, caseId, 'F')).toEqual([]);
  await expect(searchOnboardingRecipientUsers(admin, caseId, 'x'.repeat(101))).rejects.toThrow();
  await expect(addresses([user.id, 'invalid-identifier'])).rejects.toThrow();
  expect(await addresses([])).toEqual({});
});
it('rechecks archived, blocked, revoked, ambiguous and missing bindings, plus credential account readiness', async () => {
  const users = await Promise.all(['Archived', 'Revoked', 'Missing', 'Disabled', 'Ambiguous'].map(name => account(`Fictional ${name}`)));
  await owner.client`update app_user set archived_at=now() where id=${users[0].id}::uuid`;
  await owner.client`update app_external_identity set revoked_at=now() where subject=${users[1].credential.subject}`;
  await owner.client`delete from app_internal_auth_record where record_key=${`credential:${users[2].credential.subject}`}`;
  await store({ ...users[3].credential, enabled: false });
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${internalIssuer(base.tenantId)},${randomUUID()},${users[4].id}::uuid)`;
  expect(await addresses(users.map(user => user.id))).toEqual({});
  expect(await searchOnboardingRecipientUsers(admin, caseId, 'Fictional')).toEqual([]);
  const blocked = await account('Fictional blocked');
  await owner.db.insert(schema.employment).values({ tenantId: base.tenantId, personId: blocked.personId, companyId: base.companyId,
    hiredOn: '2026-01-01', blacklistedAt: todayInKualaLumpur() });
  expect(await addresses([blocked.id])).toEqual({});
  const canonical = await owner.client`select app.login_blocked(${blocked.id}::uuid) as blocked`;
  expect(canonical[0].blocked).toBe(true);
});
it('refuses cross-tenant, unrelated-company and view-only case access without leaking directory data', async () => {
  const user = await account();
  const otherBase = await seedBase(); await setModule(otherBase.tenantId, 'lifecycle', 'active'); const foreign = await entitledCtx(otherBase);
  await expect(addresses([user.id], foreign)).rejects.toThrow();
  const foreignAccount = await account('Fictional Recipient', otherBase.tenantId);
  expect((await searchOnboardingRecipientUsers(admin, caseId, 'Fictional Recipient')).map(row => row.id)).toEqual([user.id]);
  expect(await addresses([foreignAccount.id])).toEqual({});
  const [otherCompany] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional unrelated company', country: 'MY' }).returning();
  const wrongCompanyId = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.client`update role_assignment set company_id=${otherCompany.id}::uuid where app_user_id=${wrongCompanyId}::uuid`;
  const permittedModule = await onboardingContext(admin); permittedModule.config.access.onboarding.push(wrongCompanyId);
  await onboardingSaveConfig(admin, permittedModule.revision, permittedModule.config);
  const wrongCompany: SessionContext = { ...admin, userId: wrongCompanyId, personId: null, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: otherCompany.id }] };
  await expect(searchOnboardingRecipientUsers(wrongCompany, caseId, 'Fictional')).rejects.toThrow();
  await expect(addresses([user.id], wrongCompany)).rejects.toThrow();
  const outsider = await account('Fictional outsider');
  const other: SessionContext = { ...admin, userId: outsider.id, personId: outsider.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  await expect(searchOnboardingRecipientUsers(other, caseId, 'Fictional')).rejects.toThrow();
  const config = await onboardingContext(admin);
  config.config.access.onboarding = []; config.config.groups.push({ id: 'recipient-view-only', name: 'Fictional case viewers', members: [admin.userId!], limit: 0 });
  config.config.access.joinerViewGroups = ['recipient-view-only']; config.config.access.joinerSections = { 'recipient-view-only': { preset: 'coord' } };
  await onboardingSaveConfig(admin, config.revision, config.config);
  await expect(searchOnboardingRecipientUsers(admin, caseId, 'Fictional')).rejects.toThrow();
  await expect(addresses([user.id])).rejects.toThrow();
});
it('a 70-company / 1,030-employment group stays bounded, ordered and equivalent under All companies and one company', async () => {
  const companies = Array.from({ length: 70 }, (_, i) => ({ id: randomUUID(), tenantId: base.tenantId, legalName: `Directory scale ${String(i).padStart(2, '0')}`, country: 'MY' }));
  await owner.db.insert(schema.company).values(companies);
  const people = Array.from({ length: 1030 }, (_, i) => ({ id: randomUUID(), tenantId: base.tenantId, fullName: `Scale Recipient ${String(i).padStart(4, '0')}`, primaryEmail: `scale-person${i}@fixture.test` }));
  await owner.db.insert(schema.person).values(people);
  const employments = people.map((person, i) => ({ id: randomUUID(), tenantId: base.tenantId, personId: person.id, companyId: companies[i % 70].id, hiredOn: '2026-01-01' }));
  await owner.db.insert(schema.employment).values(employments);
  await owner.db.insert(schema.assignment).values(employments.map(e => ({ tenantId: base.tenantId, employmentId: e.id, companyId: e.companyId, departmentId: base.deptA, employmentType: 'full_time' as const, validFrom: '2026-01-01' })));
  const users = people.map(person => ({ id: randomUUID(), tenantId: base.tenantId, personId: person.id, workosUserId: `fixture-${randomUUID()}` }));
  await owner.db.insert(schema.appUser).values(users);
  const issuer = internalIssuer(base.tenantId), subjects = users.map(() => randomUUID());
  await owner.client`insert into app_external_identity ${owner.client(users.map((u, i) => ({ issuer, subject: subjects[i], app_user_id: u.id })))}`;
  const credentials = users.map((u, i) => { const c: Credential = { subject: subjects[i], tenantId: base.tenantId, issuer, organization: 'fixture', username: `scale${i}`,
    email: `scale${i}@account.fixture.test`, emailVerified: true, enabled: true, password: 'fixture-hash', mustChange: false, version: randomUUID(), totpSecret: 'fixture-mfa', lastStep: -1, recoveryHashes: [] };
    return { record_key: `credential:${c.subject}`, owner_id: c.subject, sealed: encryptRecord(c, `credential:${c.subject}`, null) }; });
  await owner.client`insert into app_internal_auth_record ${owner.client(credentials)}`;
  const all = await searchOnboardingRecipientUsers(admin, caseId, 'Scale Recipient');
  expect(all.map(row => row.name)).toEqual(people.slice(0, 20).map(row => row.fullName));
  expect(all.every(row => row.department.length > 0)).toBe(true);
  const singleId = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId}::uuid where app_user_id=${singleId}::uuid`;
  const config = await onboardingContext(admin); config.config.access.onboarding.push(singleId); await onboardingSaveConfig(admin, config.revision, config.config);
  const single: SessionContext = { ...admin, userId: singleId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: base.companyId }] };
  expect(await searchOnboardingRecipientUsers(single, caseId, 'Scale Recipient')).toEqual(all);
  const complete = await addresses(users.map(user => user.id));
  const expected = Object.fromEntries(users.map((user, i) => [user.id, `scale${i}@account.fixture.test`]));
  expect(Object.keys(complete)).toHaveLength(1030);
  expect(Object.keys(complete)).toEqual(users.map(user => user.id));
  expect(complete).toEqual(expected);
  expect(await addresses(users.map(user => user.id), single)).toEqual(expected);
}, 120_000); // Bulk 70-company/1,030-person admission plus bounded reads on the standard hosted runner.
