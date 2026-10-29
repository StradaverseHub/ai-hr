/**
 * M13 (D14) — the v2 own-profile workspace, change requests and the one command, through the REAL route handlers,
 * core owners and RLS. Only bearer session resolution is injected (as test/mobile-v2-leave.test.ts does).
 *
 * Pinned: the simple set's exact membership (defined once in core/mobile-profile.ts); a hidden field never leaves the
 * server (value, baseline, choices, request lines); a field outside the simple set is refused before anything runs;
 * a stale baseline is refused and nothing is written or recorded; a double submit replays one answer and one request;
 * a different command under the same requestId is request_conflict; another person's employment is not_found; the
 * pending request is shown, then its decision; immediate contact fields save at once, the rest wait; and the optional
 * existingTx seam on submitOwnProfileEdit runs inside the caller's transaction.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, updatePersonProfilePartial } from '../core/org';
import { saveProfileEditPolicy, saveProfileVisibilityPolicy } from '../core/profile-edit-policy';
import { readOwnProfileWorkspace, submitOwnProfileEdit } from '../core/profile-edit';
import { decideProfileChange } from '../core/profile';
import { MOBILE_SIMPLE_PROFILE_FIELDS, MOBILE_SIMPLE_PROFILE_FIELD_IDS } from '../core/mobile-profile';
import { essVisibleFields } from '../lib/personnel-ess-contract';
import { AuthRequiredError } from '../lib/auth-errors';
import { ProfileChangeResult, ProfileRequestsResult, ProfileWorkspaceResult } from '../lib/mobile-api/v2/profile';
import enCatalogue from '../messages/en.json';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const workspaceRoute = await import('../app/api/mobile/v2/profile/route');
const requestsRoute = await import('../app/api/mobile/v2/profile/requests/route');
const changesRoute = await import('../app/api/mobile/v2/profile/changes/route');

const PHONE = 'profile.contact_and_permanent_address.phone';
const PREFERRED = 'profile.personal_details.preferredname';
const FIRST = 'profile.personal_details.firstname';
const GENDER = 'profile.personal_details.gender';
const ADDRESS = 'profile.contact_and_permanent_address.permanentaddressline1';
const BASE_URL = 'https://hr.example.com/api/mobile/v2/profile';

let b: Base;
const admin = (): SessionContext => ({ ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] });
async function worker(name: string) {
  const hired = await hireEmployee(admin(), { person: { fullName: name, primaryEmail: `${randomUUID()}@m13-profile.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(b.tenantId, hired.personId, 'employee');
  return { ...hired, ctx: { ...adminCtx(b), userId, personId: hired.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] } satisfies SessionContext };
}
const q = (employmentId?: string) => (employmentId ? `?employmentId=${employmentId}` : '');
async function workspace(employmentId?: string) {
  const r = await workspaceRoute.GET(new Request(BASE_URL + q(employmentId)));
  return { status: r.status, body: await r.json() };
}
async function requests(employmentId?: string) {
  const r = await requestsRoute.GET(new Request(BASE_URL + '/requests' + q(employmentId)));
  return { status: r.status, body: await r.json() };
}
async function submit(employmentId: string | undefined, body: unknown) {
  const r = await changesRoute.POST(new Request(BASE_URL + '/changes' + q(employmentId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
const fieldOf = (body: { workspace: { fields: { fieldId: string }[] } }, id: string) => body.workspace.fields.find((f) => f.fieldId === id) as Record<string, unknown> | undefined;
const changeRows = () => owner.db.select().from(schema.profileChangeRequest);
const receipts = () => owner.db.select({ id: schema.domainEvent.id, payload: schema.domainEvent.payload }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));
const master = async (personId: string) => (await owner.db.select().from(schema.person).where(eq(schema.person.id, personId)))[0];

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); blocked = false; });

describe('the simple set', () => {
  it('is exactly the unmasked person/compliance text, date and choice fields that are not address parts', () => {
    expect([...MOBILE_SIMPLE_PROFILE_FIELD_IDS].sort()).toEqual([
      'profile.contact_and_permanent_address.homephone',
      'profile.contact_and_permanent_address.personalemail',
      'profile.contact_and_permanent_address.phone',
      'profile.contact_and_permanent_address.primaryemail',
      'profile.correspondence_address.correspondencehomephone',
      'profile.correspondence_address.correspondencemobilephone',
      'profile.personal_details.dateofbirth',
      'profile.personal_details.firstname',
      'profile.personal_details.fullname',
      'profile.personal_details.gender',
      'profile.personal_details.lastname',
      'profile.personal_details.maritalstatus',
      'profile.personal_details.nationality',
      'profile.personal_details.preferredname',
      'profile.personal_details.race',
      'profile.personal_details.religion',
      'profile.personal_details.salutation',
    ]);
    // Derived from the shared descriptors, never a parallel list: every member is an ESS-editable, visible descriptor.
    for (const field of MOBILE_SIMPLE_PROFILE_FIELDS) {
      expect(field.ess.visibility).toBe('visible');
      expect(['immediate', 'approval']).toContain(field.ess.edit);
      expect(['person', 'compliance']).toContain(field.ess.binding?.owner);
      expect(field.ess.masked).toBeFalsy();
    }
    expect(MOBILE_SIMPLE_PROFILE_FIELD_IDS.has(ADDRESS)).toBe(false);
  });
});

describe('workspace', () => {
  it('returns the simple visible fields with value, editability, reason, timing, choices and translated labels', async () => {
    const s = await worker('Workspace Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, PREFERRED], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const r = await workspace(s.employmentId);
    expect(r.status).toBe(200);
    expect(ProfileWorkspaceResult.safeParse(r.body).success).toBe(true);
    expect(r.body.outcome).toBe('found');
    const ids = r.body.workspace.fields.map((f: { fieldId: string }) => f.fieldId);
    expect(ids.every((id: string) => MOBILE_SIMPLE_PROFILE_FIELD_IDS.has(id))).toBe(true);
    expect(ids).not.toContain(ADDRESS);
    expect(fieldOf(r.body, PHONE)).toMatchObject({ editable: true, readOnlyReason: null, applies: 'immediately', kind: 'phone', section: 'contact' });
    expect(fieldOf(r.body, PREFERRED)).toMatchObject({ editable: true, applies: 'after_approval', label: enCatalogue.people.detail.preferredName, pending: false });
    expect(fieldOf(r.body, FIRST)).toMatchObject({ editable: false, readOnlyReason: 'field_closed' });
    expect(fieldOf(r.body, 'profile.personal_details.fullname')).toMatchObject({ value: 'Workspace Fixture', required: true });
    const gender = fieldOf(r.body, GENDER) as { kind: string; options: { value: string; label: string }[] };
    expect(gender.kind).toBe('choice');
    expect(gender.options).toContainEqual({ value: 'male', label: enCatalogue.people.detail.genderMale });
    // Addresses, family and bank/statutory open on the web, on the company's own relative paths.
    expect(r.body.workspace.web.addresses).toBe(`/me?tab=profile&employmentId=${s.employmentId}`);
    expect(r.body.workspace.web.requests).toBe(`/me?tab=others&employmentId=${s.employmentId}`);
    // No employmentId: the caller's first active employment, the app's default.
    expect((await workspace()).body.workspace.employmentId).toBe(s.employmentId);
  });

  it('keeps the two phone pairs apart: each field carries the web section it sits in, titled as the web titles it', async () => {
    const s = await worker('Section Fixture');
    caller = s.ctx;
    const r = await workspace(s.employmentId);
    expect(ProfileWorkspaceResult.safeParse(r.body).success).toBe(true);
    const fields = r.body.workspace.fields as { fieldId: string; label: string; section: string; group?: { key: string; title: string } }[];
    const at = (id: string) => fields.find((f) => f.fieldId === id);
    const pairs = [
      ['profile.contact_and_permanent_address.phone', 'profile.correspondence_address.correspondencemobilephone'],
      ['profile.contact_and_permanent_address.homephone', 'profile.correspondence_address.correspondencehomephone'],
    ];
    for (const [contact, correspondence] of pairs) {
      // The premise of the defect: same label, same coarse section — only the group distinguishes them.
      expect(at(contact)?.label).toBe(at(correspondence)?.label);
      expect(at(contact)).toMatchObject({ section: 'contact', group: { key: 'Contact and permanent address', title: enCatalogue.people.detail.contactAddressTitle } });
      expect(at(correspondence)).toMatchObject({ section: 'contact', group: { key: 'Correspondence address', title: enCatalogue.people.detail.correspondenceAddressTitle } });
    }
    expect(at(PREFERRED)).toMatchObject({ section: 'personal', group: { key: 'Personal details', title: enCatalogue.people.detail.personalDetails } });
    // Every shown field is grouped, and no two fields in one group share a label.
    for (const f of fields) expect(f.group?.title).toBeTruthy();
    const seen = new Set(fields.map((f) => `${f.group!.key}|${f.label}`));
    expect(seen.size).toBe(fields.length);
  });

  it('a hidden field never leaves the server: not its value, baseline, choices or request lines', async () => {
    const s = await worker('Hidden Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, PREFERRED], withdrawnReason: 'Fixture policy' });
    await updatePersonProfilePartial(admin(), { personId: s.personId, preferredName: 'PRIVATE MASTER M13' });
    caller = s.ctx;
    const before = await workspace(s.employmentId);
    // Non-vacuity: while visible, the value is there.
    expect(fieldOf(before.body, PREFERRED)).toMatchObject({ value: 'PRIVATE MASTER M13' });
    const pending = await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PREFERRED, before: fieldOf(before.body, PREFERRED)!.baseline, value: 'PRIVATE PROPOSED M13' }] });
    expect(pending.body).toMatchObject({ outcome: 'submitted', waiting: [PREFERRED] });
    expect(JSON.stringify((await requests(s.employmentId)).body)).toContain('PRIVATE PROPOSED M13');

    const fields = Object.fromEntries(essVisibleFields().map((field) => [field.id, 'viewOnly']));
    fields[PHONE] = 'editable'; fields[PREFERRED] = 'hide';
    await saveProfileVisibilityPolicy(admin(), { policy: { version: 3, fields, primaryOnly: [] }, withdrawnReason: 'Fixture hidden field' });
    const after = await workspace(s.employmentId), history = await requests(s.employmentId);
    expect(after.status).toBe(200);
    expect(fieldOf(after.body, PREFERRED)).toBeUndefined();
    expect(fieldOf(after.body, PHONE)).toMatchObject({ editable: true });
    const wire = JSON.stringify([after.body, history.body]);
    for (const secret of ['PRIVATE MASTER M13', 'PRIVATE PROPOSED M13', PREFERRED]) expect(wire, secret).not.toContain(secret);
    expect(ProfileRequestsResult.safeParse(history.body).success).toBe(true);
    // And it cannot be written through the app either.
    const refused = await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PREFERRED, before: 'sha256:' + '0'.repeat(64), value: 'Anything' }] });
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'field_closed' });
  });

  it('another person’s employment, a guessed id and a malformed id: not_found / 400, never a read', async () => {
    const s = await worker('Own Fixture'), other = await worker('Other Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    for (const id of [other.employmentId, randomUUID()]) {
      expect(await workspace(id)).toEqual({ status: 200, body: { outcome: 'refused', code: 'not_found' } });
      expect(await requests(id)).toEqual({ status: 200, body: { outcome: 'refused', code: 'not_found' } });
      const theirs = (await readOwnProfileWorkspace(other.ctx, { employmentId: other.employmentId })).baselines[PHONE];
      expect((await submit(id, { requestId: randomUUID(), changes: [{ fieldId: PHONE, before: theirs, value: '0119999999' }] })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    }
    expect((await master(other.personId)).phone).toBeNull();
    expect(await receipts()).toEqual([]);
    expect((await workspace('not-a-uuid')).status).toBe(400);
    blocked = true;
    expect((await workspace(s.employmentId)).status).toBe(401);
  });
});

describe('the change command', () => {
  it('saves immediate contact at once, sends the rest for approval, and replays a double submit as one request', async () => {
    const s = await worker('Command Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, PREFERRED], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const view = (await workspace(s.employmentId)).body;
    const body = { requestId: randomUUID(), changes: [
      { fieldId: PREFERRED, before: fieldOf(view, PREFERRED)!.baseline, value: 'Pending Name' },
      { fieldId: PHONE, before: fieldOf(view, PHONE)!.baseline, value: '0110000000' },
    ] };
    const first = await submit(s.employmentId, body);
    expect(ProfileChangeResult.safeParse(first.body).success).toBe(true);
    expect(first.body).toMatchObject({ outcome: 'submitted', saved: [PHONE], waiting: [PREFERRED] });
    expect(first.body.requestId).toBeTruthy();
    const second = await submit(s.employmentId, body);
    expect(second).toEqual(first);
    expect(await changeRows()).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    const person = await master(s.personId);
    expect(person.phone).toBe('0110000000');
    expect(person.preferredName).toBeNull();
    // The same reference for a different command is refused, and changes nothing.
    const conflict = await submit(s.employmentId, { ...body, changes: [{ ...body.changes[0], value: 'Another Name' }] });
    expect(conflict.body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect(await changeRows()).toHaveLength(1);
    // The workspace now marks the waiting field.
    expect(fieldOf((await workspace(s.employmentId)).body, PREFERRED)).toMatchObject({ pending: true });
  });

  it('refuses a field outside the simple set before anything runs', async () => {
    const s = await worker('Address Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, ADDRESS], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const owned = await readOwnProfileWorkspace(s.ctx, { employmentId: s.employmentId });
    // Non-vacuity: the web owner WOULD accept this address change (the employer opened it).
    expect(owned.editable).toContain(ADDRESS);
    const r = await submit(s.employmentId, { requestId: randomUUID(), changes: [
      { fieldId: PHONE, before: owned.baselines[PHONE], value: '0112222222' },
      { fieldId: ADDRESS, before: owned.baselines[ADDRESS], value: '1 Fixture Road' },
    ] });
    expect(r.body).toEqual({ outcome: 'refused', code: 'not_simple', fieldIds: [ADDRESS] });
    for (const unknown of ['profile.no_such_field', 'bank_statutory.bank_information.bankaccountno']) {
      expect((await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: unknown, before: 'x', value: 'y' }] })).body).toMatchObject({ outcome: 'refused', code: 'not_simple' });
    }
    expect(await changeRows()).toEqual([]);
    expect(await receipts()).toEqual([]);
    expect((await master(s.personId)).phone).toBeNull();
    // Malformed commands are 400s.
    for (const bad of [{ requestId: randomUUID(), changes: [] }, { requestId: 'nope', changes: [{ fieldId: PHONE, before: 'x', value: '1' }] }, { requestId: randomUUID(), changes: [{ fieldId: PHONE, before: 'x', value: 1 }] }]) {
      expect((await submit(s.employmentId, bad)).status).toBe(400);
    }
  });

  it('a value changed since the form loaded is refused stale: nothing written, nothing recorded', async () => {
    const s = await worker('Stale Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, PREFERRED], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const loaded = (await workspace(s.employmentId)).body;
    await updatePersonProfilePartial(admin(), { personId: s.personId, preferredName: 'Changed By HR' });
    const r = await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PREFERRED, before: fieldOf(loaded, PREFERRED)!.baseline, value: 'Employee Overwrite' }] });
    expect(r.body).toEqual({ outcome: 'refused', code: 'stale', fieldIds: [PREFERRED] });
    expect(await changeRows()).toEqual([]);
    expect(await receipts()).toEqual([]);
    expect((await master(s.personId)).preferredName).toBe('Changed By HR');
    // Non-vacuity: the same change against the CURRENT baseline is accepted.
    const fresh = (await workspace(s.employmentId)).body;
    expect((await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PREFERRED, before: fieldOf(fresh, PREFERRED)!.baseline, value: 'Employee Overwrite' }] })).body).toMatchObject({ outcome: 'submitted', waiting: [PREFERRED] });
  });

  it('every value equal to the current one is no_change; a value the owner refuses is invalid', async () => {
    const s = await worker('Unchanged Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, 'profile.contact_and_permanent_address.personalemail'], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const view = (await workspace(s.employmentId)).body;
    expect((await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PHONE, before: fieldOf(view, PHONE)!.baseline, value: null }] })).body).toEqual({ outcome: 'refused', code: 'no_change' });
    const email = 'profile.contact_and_permanent_address.personalemail';
    expect((await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: email, before: fieldOf(view, email)!.baseline, value: 'not-an-email' }] })).body).toMatchObject({ outcome: 'refused', code: 'invalid' });
    expect(await changeRows()).toEqual([]);
  });
});

describe('requests', () => {
  it('shows the pending request with what was asked and today’s value, then the reviewer’s decision', async () => {
    const s = await worker('Requests Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PREFERRED, FIRST], withdrawnReason: 'Fixture policy' });
    caller = s.ctx;
    const view = (await workspace(s.employmentId)).body;
    const asked = await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: PREFERRED, before: fieldOf(view, PREFERRED)!.baseline, value: 'Pending Name' }] });
    const list = await requests(s.employmentId);
    expect(ProfileRequestsResult.safeParse(list.body).success).toBe(true);
    const item = list.body.requests.items.find((i: { id: string }) => i.id === asked.body.requestId);
    expect(item).toMatchObject({ status: 'pending', decidedAt: null, decisionReason: null });
    expect(item.lines).toEqual([expect.objectContaining({ fieldId: PREFERRED, label: enCatalogue.people.detail.preferredName, proposed: 'Pending Name', current: enCatalogue.essProfile.notRecorded, recordKind: null })]);
    expect(list.body.requests.truncated).toBe(false);

    await decideProfileChange(admin(), { requestId: asked.body.requestId, decision: 'approved' });
    const later = await workspace(s.employmentId);
    const asked2 = await submit(s.employmentId, { requestId: randomUUID(), changes: [{ fieldId: FIRST, before: fieldOf(later.body, FIRST)!.baseline, value: 'Rejected Name' }] });
    await decideProfileChange(admin(), { requestId: asked2.body.requestId, decision: 'rejected', reason: 'Fixture rejection reason' });
    const decided = (await requests(s.employmentId)).body.requests.items;
    const byId = new Map(decided.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(asked.body.requestId)).toMatchObject({ status: 'approved', decidedAt: expect.any(String) });
    expect((byId.get(asked.body.requestId) as { lines: { current: string }[] }).lines[0].current).toBe('Pending Name');
    expect(byId.get(asked2.body.requestId)).toMatchObject({ status: 'rejected', decisionReason: 'Fixture rejection reason' });
    expect(fieldOf((await workspace(s.employmentId)).body, PREFERRED)).toMatchObject({ value: 'Pending Name', pending: false });
  });
});

describe('kernel seam: submitOwnProfileEdit(existingTx)', () => {
  it('runs inside the caller’s transaction, so the caller’s rollback undoes the immediate save and the request', async () => {
    const s = await worker('Seam Fixture');
    await saveProfileEditPolicy(admin(), { keys: [PHONE, PREFERRED], withdrawnReason: 'Fixture policy' });
    const view = await readOwnProfileWorkspace(s.ctx, { employmentId: s.employmentId });
    const proposal = { v: 2 as const, fields: [{ fieldId: PHONE, before: view.baselines[PHONE], value: '0113333333' }, { fieldId: PREFERRED, before: view.baselines[PREFERRED], value: 'Seam Name' }], registers: [] };
    await expect(withTenant(s.ctx, async (tx) => {
      const out = await submitOwnProfileEdit(s.ctx, { employmentId: s.employmentId, proposal }, tx);
      expect(out.saved).toEqual([PHONE]);
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    expect(await changeRows()).toEqual([]);
    expect((await master(s.personId)).phone).toBeNull();
    // Without a transaction the owner keeps its own, exactly as the web calls it.
    const web = await submitOwnProfileEdit(s.ctx, { employmentId: s.employmentId, proposal });
    expect(web).toMatchObject({ saved: [PHONE], waiting: [PREFERRED] });
    expect(await changeRows()).toHaveLength(1);
  });
});
