/**
 * Personnel (Admin) — auto-filter organisation label dropdowns by company (feedback 570e3311).
 *
 * Server-side halves of the change:
 *   - transferEmployee now guards department / position / cost-centre CHANGED-ONLY: a newly-supplied
 *     value must be usable by the employment's company under the Shared System Labels resolver
 *     (Global or explicit companies — labelUsableByCompany) AND not archived; re-supplying
 *     an eligible stored current value (including archived labels) keeps working.
 *   - setEmploymentAssignment applies the same resolver + archived check to a CHANGED department /
 *     position (the BU check is covered by test/personnel-org-assignment-standardization.test.ts),
 *     and carries an unchanged shared-in value forward even after the sharing flag is flipped OFF —
 *     no silent clear on an unrelated save.
 *   - Page-source pins: the employee detail page scopes its departments load to the employee's own
 *     company and renders pinned-current options for legacy/unshared stored values, so a one-line
 *     revert to the unscoped read cannot pass this suite (precedent: the hydration-parity suite in
 *     test/hire-form-filter.test.ts reads page source the same way).
 *
 * Conventions mirror test/shared-system-labels.test.ts (per-test seed via beforeEach).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { CrossCompanyError, hireEmployee, setEmploymentAssignment, transferEmployee } from '../core/org';
import {
  archiveDepartment,
  createDepartment,
  createPosition,
} from '../core/admin';
import { assignLabelToCompanies, labelIdsForCompany, setLabelGlobal } from '../core/system-labels';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

const email = () => `olf_${randomUUID().slice(0, 8)}@t.local`;

/** A second company in the same tenant, to share labels out of. */
async function secondCompany(): Promise<string> {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'OLF Co B Sdn Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  return co.id;
}

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Org Filter Emp', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

describe('570e3311 — transferEmployee changed-only org-label guards', () => {
  it('rejects a changed cross-company department (flag OFF)', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Foreign Dept' });
    await expect(
      transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: foreign.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('accepts a shared-in department when the flag is ON', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    await owner.db.update(schema.company).set({sharedSystemLabels:true}).where(eq(schema.company.id,b.companyId));
    const res = await transferEmployee(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: shared.id,
    });
    expect(res.assignmentId).toBeTruthy();
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(shared.id);
  });

  it('rejects an archived-but-shared department', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Archived Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    await owner.db.update(schema.company).set({sharedSystemLabels:true}).where(eq(schema.company.id,b.companyId));
    await archiveDepartment(a, { id: shared.id, archived: true });
    await expect(
      transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: shared.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('refuses a newly injected wrong-company assignment even through the owner connection', async () => {
    const a = adminCtx(b), hire = await hireOne(), coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Unavailable Foreign Dept' });
    await expect(owner.db.update(schema.assignment).set({ departmentId: foreign.id })
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), isNull(schema.assignment.validTo))))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514',
        message: 'Assignment label Criteria do not include its recorded company' }) });
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptA);
  });

  it('retains an archived CURRENT department with valid Criteria on an unrelated assignment change', async () => {
    const a = adminCtx(b), hire = await hireOne(), coB = await secondCompany();
    const held = await createDepartment(a, { companyId: coB, name: 'Held Foreign-Origin Dept' });
    // Creation-company provenance is distinct from availability. Install a permitted shared-in label
    // through the real writer, then archive it: it is off the new-choice list but is still held.
    await assignLabelToCompanies(a, { kind: 'department', labelId: held.id, companyIds: [b.companyId] });
    await transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-03-01', departmentId: held.id });
    await archiveDepartment(a, { id: held.id, archived: true });
    const res = await transferEmployee(a, {
      employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: held.id, positionId: b.positionId,
    });
    expect(res.assignmentId).toBeTruthy();
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(held.id); // carried, not blocked, not cleared
    expect(open.positionId).toBe(b.positionId);
    // Archiving still refuses NEW selection by another employment; held-value retention grants no access.
    const other = await hireOne();
    await expect(transferEmployee(a, { employmentId: other.employmentId, effectiveDate: '2026-06-01', departmentId: held.id }))
      .rejects.toBeInstanceOf(CrossCompanyError);
  });
});

describe('570e3311 — setEmploymentAssignment changed-only department / position guards', () => {
  it('rejects a changed cross-company department with the standard message', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Foreign Assign Dept' });
    await expect(
      setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: foreign.id }),
    ).rejects.toThrow(/not a valid option/i);
  });

  it('accepts explicitly assigned position with either retired flag state', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    // Retired flag data has no effect on explicit Criteria availability.
    await owner.db.update(schema.company).set({sharedSystemLabels:false}).where(eq(schema.company.id,b.companyId));
    const first=await setEmploymentAssignment(a,{employmentId:hire.employmentId,effectiveDate:'2026-06-01',positionId:shared.id});expect(first.changed).toBe(true);
    // The other legacy flag state must not change the saved Criteria or force another assignment version.
    await owner.db.update(schema.company).set({sharedSystemLabels:true}).where(eq(schema.company.id,b.companyId));
    const res = await setEmploymentAssignment(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      positionId: shared.id,
    });
    expect(res.changed).toBe(false);
    expect((await openAssignment(hire.employmentId)).positionId).toBe(shared.id);
  });

  it('lifecycle: a held shared-in position survives the flag being flipped OFF — an unrelated save carries it, no silent clear', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Held Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    await owner.db.update(schema.company).set({sharedSystemLabels:true}).where(eq(schema.company.id,b.companyId));
    await setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-03-01', positionId: shared.id });
    // Changing retired flag data does not change the saved option set or retained value.
    await owner.db.update(schema.company).set({sharedSystemLabels:false}).where(eq(schema.company.id,b.companyId));
    // An Organisation Assignment save that does NOT touch position (the pinned UI re-posts the current
    // value) still applies the department change and carries the position forward.
    const res = await setEmploymentAssignment(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: shared.id,
    });
    expect(res.changed).toBe(true);
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.positionId).toBe(shared.id); // carried forward, not cleared, not blocked
  });
});

/**
 * Page-source pins (precedent: the hydration-parity suite in test/hire-form-filter.test.ts): the
 * employee detail page must scope its departments read to the employee's own company and render
 * pinned-current options for stored values outside the scoped lists — a one-line revert to the
 * unscoped read (or dropping a pin) fails here.
 */
describe('570e3311 — employee detail page wiring pins', () => {
  const PAGE = fs.readFileSync(
    path.resolve(__dirname, '../app/(app)/admin/personnel/[employmentId]/page.tsx'),
    'utf8',
  );

  it('scopes the departments load to the employee company (resolver-aware read)', () => {
    expect(PAGE).toMatch(/listDepartments\(s,\s*\{\s*companyIds:\s*\[emp\.companyId\]\s*\}\)/);
  });

  // 8ebabbf2 SUPERSEDES the pinned-current-option guard that stood here. 570e3311's problem was specific to
  // <select>: when the stored BU / Department / Position was no longer in its company-scoped option list, the
  // select silently fell to its first option, and the next Save committed that wrong value. The fix was to
  // render one extra pinned option for the stored value.
  //
  // The Employment tab's Organisation Assignment section is now VIEW-ONLY — there are no selects and no Save,
  // so the failure mode is gone at the root rather than patched. What must hold instead is that the read-only
  // display still SHOWS an off-list stored value, which it does by reading the label off the `current`
  // assignment projection rather than by looking it up in a scoped option list.
  it('displays the stored BU / Department / Position from the assignment projection, not a scoped list', () => {
    for (const expr of [
      '{readOnlyValue("employment.organisation_assignment.businessunitname", current?.businessUnit)}',
      '{readOnlyValue("employment.organisation_assignment.departmentname", current?.department)}',
      '{readOnlyValue("employment.organisation_assignment.positionname", current?.position)}',
    ]) {
      expect(PAGE, `${expr} must render the stored label directly`).toContain(expr);
    }
    // And the selects that needed pinning are really gone.
    expect(PAGE).not.toContain('name="businessUnitId"\n');
    expect(PAGE).not.toContain('!businessUnits.some((bu) => bu.id === current.businessUnitId)');
  });
});

/** The original empty-dropdown regression stays fixed by explicit Criteria alone. Company flag data
 * remains unchanged and cannot hide an assigned or Global code. */
describe('Criteria availability never depends on changing retired company flags', () => {
  it('assignLabelToCompanies resolves immediately without changing company flag data', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Criteria Dept' });
    // The reported scenario: the flag is at its OFF default for the target company — no manual enable.
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co.sharedSystemLabels).toBe(false);
    expect(await labelIdsForCompany(a, 'department', b.companyId)).toContain(shared.id);
    // Criteria owns its own event; it does not fabricate a company-configuration change.
    expect(await eventTypesFor(b.tenantId,b.companyId)).not.toContain('company.shared-labels.enabled');
  });

  it('setLabelGlobal(true) resolves in every company without changing company flag data', async () => {
    const a = adminCtx(b); // group admin — passes the is_global trigger gate
    const coB = await secondCompany();
    const glob = await createPosition(a, { companyId: b.companyId, title: 'Global Criteria Pos' });
    await setLabelGlobal(a, { kind: 'position', labelId: glob.id, isGlobal: true });
    const rows = await owner.db
      .select()
      .from(schema.company)
      .where(eq(schema.company.tenantId, b.tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((c) => !c.sharedSystemLabels)).toBe(true);
    expect(await labelIdsForCompany(a, 'position', coB)).toContain(glob.id);
  });
});

describe('0550 preserves legacy origin availability as explicit Criteria without rewriting flags',()=>{
  it('backfills existing implicit origin while retaining other assigned companies and flag data',async()=>{
    const a=adminCtx(b),coB=await secondCompany(),label=await createDepartment(a,{companyId:b.companyId,name:'Legacy implicit origin'});
    await assignLabelToCompanies(a,{kind:'department',labelId:label.id,companyIds:[coB]});
    await owner.db.transaction(async tx=>{
      await tx.delete(schema.labelCompanyAssignment).where(and(eq(schema.labelCompanyAssignment.labelId,label.id),eq(schema.labelCompanyAssignment.companyId,b.companyId)));
      const source=fs.readFileSync(path.resolve(__dirname,'../db/migrations/0550_system_label_company_criteria.sql'),'utf8');
      const statements=source.split('--> statement-breakpoint').filter(statement=>statement.includes('INSERT INTO label_company_assignment'));
      expect(statements).toHaveLength(4);for(const statement of statements)await tx.execute(sql.raw(statement));
    });
    expect(await labelIdsForCompany(a,'department',b.companyId)).toContain(label.id);expect(await labelIdsForCompany(a,'department',coB)).toContain(label.id);
    const rows=await owner.db.select().from(schema.company).where(eq(schema.company.tenantId,b.tenantId));expect(rows.every(row=>!row.sharedSystemLabels)).toBe(true);
  });
});

/**
 * d61f0ff2 — hire form zero-visible-options empty state: when the selected company may use NONE of a
 * select's options, the page surfaces "No organization labels are configured for the selected
 * company" below the select instead of an unexplained empty dropdown. Drift guards pin the inline
 * script's toggle wiring + the page's server-rendered (hydration-parity) message elements.
 */
describe('d61f0ff2 — zero-visible-options empty state (now on the Create New Employee wizard)', () => {
  // 6d671f44 moved employee creation off the Personnel list page onto a dedicated client wizard, so
  // this behaviour moved with it. The rule is unchanged — a company that may use NONE of a select's
  // options gets an explanation instead of a bare placeholder — but it is now computed in React from
  // `hireOptionVisible` rather than stamped by an inline script, so there is no hydration parity to
  // pin any more (the markup is produced once, by the same code, on both sides).
  const WIZARD = fs.readFileSync(path.resolve(__dirname, '../app/(app)/admin/personnel/new/wizard.tsx'), 'utf8');

  it('each narrowed select renders the i18n message from the shared rule', () => {
    expect(WIZARD).toContain('const orgEmpty = (opts: Option[])');
    expect(WIZARD).toContain('opts.every((o) => !visible(o, false))');
    expect(WIZARD.match(/\{t\('orgLabelsEmptyForCompany'\)\}/g)).toHaveLength(4);
    for (const list of ['businessUnits', 'departments', 'positions', 'costCenters']) {
      expect(WIZARD.includes(`orgEmpty(${list})`), list).toBe(true);
    }
  });

  it('the message exists in all six locales, under BOTH namespaces it is read from', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      ) as { people: { list: Record<string, string>; wizard: Record<string, string> } };
      expect(messages.people.list.orgLabelsEmptyForCompany, `people.list missing in ${loc}`).toBeTruthy();
      expect(messages.people.wizard.orgLabelsEmptyForCompany, `people.wizard missing in ${loc}`).toBeTruthy();
    }
  });
});
