/** Native command/RLS boundary evidence for a future port; no Assistant support is asserted here. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { createCompany } from '../core/admin';
import { hireEmployee } from '../core/workforce-commands';
import { createConfig } from '../core/employee-id-config';
import { createEmployeeDraftWithReservedCode, discardEmployeeDraft } from '../core/employee-draft';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let group: SessionContext;
let companyB: string;
beforeAll(async () => {
  await migrateTestDb();
  const evidence = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (!evidence) return;
  // Catalog metadata only: no draft, USER, PERSON, secret or credential rows enter this artifact.
  const policies = Array.from(await owner.db.execute<{
    name: string; command: string; permissive: boolean; roles: string[];
    usingExpression: string | null; withCheckExpression: string | null;
  }>(sql`
    select p.polname as name,
      case p.polcmd when '*' then 'ALL' when 'r' then 'SELECT' when 'a' then 'INSERT'
        when 'w' then 'UPDATE' when 'd' then 'DELETE' else p.polcmd::text end as command,
      p.polpermissive as permissive,
      array(select case when role_oid=0 then 'PUBLIC' else pg_get_userbyid(role_oid)::text end
        from unnest(p.polroles) as role_oid order by role_oid) as roles,
      pg_get_expr(p.polqual,p.polrelid) as "usingExpression",
      pg_get_expr(p.polwithcheck,p.polrelid) as "withCheckExpression"
    from pg_policy p where p.polrelid='public.employee_draft'::regclass order by p.polname
  `));
  const tables = Array.from(await owner.db.execute<{
    owner: string; rowSecurity: boolean; forceRowSecurity: boolean;
    appSelect: boolean; appInsert: boolean; appUpdate: boolean; appDelete: boolean;
    appTruncate: boolean; appReferences: boolean; appTrigger: boolean;
  }>(sql`
    select pg_get_userbyid(c.relowner)::text as owner, c.relrowsecurity as "rowSecurity",
      c.relforcerowsecurity as "forceRowSecurity",
      has_table_privilege('ai_hr_app',c.oid,'SELECT') as "appSelect",
      has_table_privilege('ai_hr_app',c.oid,'INSERT') as "appInsert",
      has_table_privilege('ai_hr_app',c.oid,'UPDATE') as "appUpdate",
      has_table_privilege('ai_hr_app',c.oid,'DELETE') as "appDelete",
      has_table_privilege('ai_hr_app',c.oid,'TRUNCATE') as "appTruncate",
      has_table_privilege('ai_hr_app',c.oid,'REFERENCES') as "appReferences",
      has_table_privilege('ai_hr_app',c.oid,'TRIGGER') as "appTrigger"
    from pg_class c where c.oid='public.employee_draft'::regclass
  `));
  expect(policies.length).toBeGreaterThan(0);
  expect(tables).toHaveLength(1);
  writeFileSync(join(evidence, 'personnel-draft-discard-policy-metadata.json'), JSON.stringify({
    kind: 'PERSONNEL_DRAFT_DISCARD_NATIVE_POLICY_METADATA', candidate: process.env.AIHR_CI_HEAD,
    runId: process.env.GITHUB_RUN_ID, relation: 'public.employee_draft', appRole: 'ai_hr_app',
    table: tables[0], policies,
  }, null, 2) + '\n');
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  group = { ...await entitledCtx(b), personId: null, grants: [{ role: 'hr_admin', companyId: null }] };
  companyB = (await createCompany(group, { legalName: 'Draft authority company B', country: 'MY', currency: 'MYR' })).id;
  await createConfig(group, {
    companyId: b.companyId, prefix: 'AUTH', startNumber: 10, numberLength: 4, increment: 3, allowManualOverride: true,
  });
});

async function currentContext(userId: string): Promise<SessionContext> {
  const [user] = await owner.db.select().from(s.appUser).where(eq(s.appUser.id, userId));
  expect(user.tenantId).toBe(b.tenantId);
  const rows = await owner.db.select().from(s.roleAssignment).where(and(
    eq(s.roleAssignment.tenantId, b.tenantId), eq(s.roleAssignment.appUserId, userId),
  ));
  expect(rows).toHaveLength(1);
  return {
    ...await entitledCtx(b, rows.map(row => row.role)), userId, personId: user.personId,
    roles: rows.map(row => row.role), grants: rows.map(row => ({ role: row.role, companyId: row.companyId })),
  };
}
async function hirePerson(label: string) {
  return hireEmployee(group, {
    person: { fullName: label, primaryEmail: `authority.${randomUUID()}@fixture.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur(),
  });
}
async function login(personId: string | null, companyId: string) {
  const userId = await createAppUser(b.tenantId, personId, 'hr_admin');
  await owner.db.update(s.roleAssignment).set({ companyId }).where(eq(s.roleAssignment.appUserId, userId));
  return currentContext(userId);
}
const draftInput = () => ({
  companyId: b.companyId, fullName: 'Actual native draft author', primaryEmail: `draft.${randomUUID()}@fixture.test`,
});
async function authorDraft() {
  const person = await hirePerson('Draft author PERSON');
  const author = await login(person.personId, b.companyId);
  const draft = await createEmployeeDraftWithReservedCode(author, draftInput());
  const [row] = await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.id, draft.id));
  expect(row.createdByPersonId).toBe(person.personId);
  expect(row.reservedNumber).toBe(13); // the actual hire consumed 10; this native draft consumed 13.
  await owner.db.update(s.roleAssignment).set({ companyId: companyB }).where(eq(s.roleAssignment.appUserId, author.userId!));
  return { draft, author: await currentContext(author.userId!), person };
}
async function snapshot() {
  return {
    drafts: await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.tenantId, b.tenantId)).orderBy(s.employeeDraft.id),
    configs: await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.tenantId, b.tenantId)).orderBy(s.employeeIdConfig.id),
    counters: await owner.db.select().from(s.tenantCounter).where(eq(s.tenantCounter.tenantId, b.tenantId)).orderBy(s.tenantCounter.kind),
    events: await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(s.domainEvent.id),
    people: await owner.db.select().from(s.person).where(eq(s.person.tenantId, b.tenantId)).orderBy(s.person.id),
    employments: await owner.db.select().from(s.employment).where(eq(s.employment.tenantId, b.tenantId)).orderBy(s.employment.id),
  };
}
async function authority(ctx: SessionContext, draftId: string) {
  return withTenant(ctx, async tx => {
    const [flags] = await tx.execute<{ admin: boolean; company_admin: boolean; own: boolean; edit: boolean; readable: boolean }>(sql`
      select app.is_admin() as admin, app.is_admin_for(${b.companyId}::uuid) as company_admin,
        app.is_self_person(d.created_by_person_id) as own,
        app.access_workforce_draft(d.company_id,d.created_by_person_id,'edit') as edit,
        app.access_workforce_draft(d.company_id,d.created_by_person_id,'read') as readable
      from employee_draft d where d.id=${draftId}::uuid
    `);
    return flags;
  });
}
async function expect42501(work: Promise<unknown>) {
  try { await work; throw new Error('Expected a native RLS refusal.'); }
  catch (error) {
    const codes: unknown[] = [];
    const messages: string[] = [];
    let cause: unknown = error;
    while (cause instanceof Error) {
      codes.push((cause as Error & { code?: string }).code);
      messages.push(cause.message);
      cause = cause.cause;
    }
    expect(codes).toContain('42501');
    expect(messages.join('\n')).toContain('employee_id_config');
  }
}

describe('actual native draft discard authority boundaries', () => {
  it('rolls the entire configured TIP command back after an actual linked HR author grant moves away', async () => {
    const { draft, author } = await authorDraft();
    expect(await authority(author, draft.id)).toEqual({ admin: true, company_admin: false, own: true, edit: true, readable: true });
    const before = await snapshot();
    expect(before.configs[0].currentRunningNumber).toBe(13);
    await expect42501(discardEmployeeDraft(author, draft.id));
    expect(await snapshot()).toEqual(before);
    await expect42501(withTenant(author, tx => discardEmployeeDraft(author, draft.id, tx, { returnResult: true })));
    expect(await snapshot()).toEqual(before);
  });

  it('allows the same actual HR author to discard a non-TIP gap without a blanket company floor', async () => {
    const { draft, author } = await authorDraft();
    const later = await createEmployeeDraftWithReservedCode(group, draftInput());
    expect(await authority(author, draft.id)).toEqual({ admin: true, company_admin: false, own: true, edit: true, readable: true });
    const before = await snapshot();
    expect(before.configs[0].currentRunningNumber).toBe(16);
    const result = await withTenant(author, tx => discardEmployeeDraft(author, draft.id, tx, { returnResult: true }));
    expect(result).toEqual({ draftId: draft.id, reservedEmployeeCode: draft.employeeCode, released: false, eventId: expect.any(String) });
    const after = await snapshot();
    expect(after.drafts).toEqual(before.drafts.filter(row => row.id !== draft.id));
    expect(after.drafts.map(row => row.id)).toEqual([later.id]);
    expect(after.configs).toEqual(before.configs);
    expect(after.counters).toEqual(before.counters);
    expect(after.people).toEqual(before.people);
    expect(after.employments).toEqual(before.employments);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.find(row => row.id === result.eventId)).toMatchObject({
      aggregateId: draft.id, aggregateType: 'employee-draft', eventType: 'employee-draft.discarded',
      actorType: 'user', actorId: author.userId,
      payload: { reservedEmployeeCode: draft.employeeCode, released: false },
    });
  });

  it('distinguishes real non-HR own-author DELETE RLS from the native JavaScript admin floor', async () => {
    const { draft, author } = await authorDraft();
    await owner.db.update(s.roleAssignment).set({ role: 'employee', companyId: null })
      .where(eq(s.roleAssignment.appUserId, author.userId!));
    const employee = await currentContext(author.userId!);
    expect(await authority(employee, draft.id)).toEqual({ admin: false, company_admin: false, own: true, edit: true, readable: true });
    const before = await snapshot();
    await expect(withTenant(employee, async tx => {
      const deleted = await tx.delete(s.employeeDraft).where(eq(s.employeeDraft.id, draft.id)).returning({ id: s.employeeDraft.id });
      expect(deleted).toEqual([{ id: draft.id }]);
      throw new Error('rollback raw RLS probe');
    })).rejects.toThrow('rollback raw RLS probe');
    expect(await snapshot()).toEqual(before);
    await expect(discardEmployeeDraft(employee, draft.id)).rejects.toThrow('Only an admin');
    await expect(withTenant(employee, tx => discardEmployeeDraft(employee, draft.id, tx, { returnResult: true })))
      .rejects.toThrow('Only an admin');
    expect(await snapshot()).toEqual(before);
  });

  it('uses the actual current USER-to-PERSON link rather than retaining an old author carrier', async () => {
    const { draft, author } = await authorDraft();
    const replacement = await hirePerson('Replacement author link');
    await owner.db.update(s.appUser).set({ personId: replacement.personId }).where(eq(s.appUser.id, author.userId!));
    const current = await currentContext(author.userId!);
    expect(current.personId).toBe(replacement.personId);
    expect(await authority(current, draft.id)).toBeUndefined();
    const before = await snapshot();
    await expect(discardEmployeeDraft(current, draft.id)).rejects.toThrow('Draft not found (or not visible).');
    expect(await snapshot()).toEqual(before);
  });

  it('preserves unlinked HR company scope without manufacturing an author PERSON', async () => {
    const unlinkedA = await login(null, b.companyId);
    const draft = await createEmployeeDraftWithReservedCode(unlinkedA, draftInput());
    expect(await authority(unlinkedA, draft.id)).toEqual({ admin: true, company_admin: true, own: false, edit: true, readable: true });
    const unlinkedB = await login(null, companyB);
    expect(await authority(unlinkedB, draft.id)).toBeUndefined();
    const before = await snapshot();
    await expect(discardEmployeeDraft(unlinkedB, draft.id)).rejects.toThrow('Draft not found (or not visible).');
    expect(await snapshot()).toEqual(before);
    const result = await withTenant(unlinkedA, tx => discardEmployeeDraft(unlinkedA, draft.id, tx, { returnResult: true }));
    expect(result.released).toBe(true);
    expect((await snapshot()).drafts).toEqual([]);
    const users = await owner.db.select().from(s.appUser).where(eq(s.appUser.id, unlinkedA.userId!));
    expect(users[0].personId).toBeNull();
  });
});
