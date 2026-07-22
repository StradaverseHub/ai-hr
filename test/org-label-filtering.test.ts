/**
 * Personnel (Admin) — auto-filter organisation label dropdowns by company (feedback 570e3311).
 *
 * Server-side halves of the change:
 *   - transferEmployee now guards department / position / cost-centre CHANGED-ONLY: a newly-supplied
 *     value must be usable by the employment's company under the Shared System Labels resolver
 *     (origin ∪ shared-in ∪ global, flag-gated — labelUsableByCompany) AND not archived; re-supplying
 *     the stored current value (even legacy cross-company data) keeps working.
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
  setCompanySharedLabels,
} from '../core/admin';
import { assignLabelToCompanies, labelIdsForCompany, setLabelGlobal } from '../core/system-labels';
import { HIRE_ORG_FILTER_SCRIPT } from '../lib/hire-form-filter';

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
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
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
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    await archiveDepartment(a, { id: shared.id, archived: true });
    await expect(
      transferEmployee(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', departmentId: shared.id }),
    ).rejects.toBeInstanceOf(CrossCompanyError);
  });

  it('accepts re-supplying the CURRENT value even when it is legacy cross-company (changed-only semantics)', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const foreign = await createDepartment(a, { companyId: coB, name: 'Legacy Foreign Dept' });
    // Simulate legacy/imported data: the stored current assignment points at a wrong-company label.
    await owner.db
      .update(schema.assignment)
      .set({ departmentId: foreign.id })
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), isNull(schema.assignment.validTo)));
    // Re-supplying that same department (as a UI that pins the current value would) passes the guard,
    // while the transfer still applies the genuinely-changed field.
    const res = await transferEmployee(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: foreign.id,
      positionId: b.positionId,
    });
    expect(res.assignmentId).toBeTruthy();
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(foreign.id); // carried, not blocked, not cleared
    expect(open.positionId).toBe(b.positionId);
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

  it('rejects a changed shared-in position once the company explicitly OPTS OUT of sharing, but accepts it while opted in', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    // d61f0ff2: assigning AUTO-ENABLES sharing for the target company; the flag is now an explicit
    // OPT-OUT. Opted out, the shared-in position is NOT a valid option (origin-only strictness kept).
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: false });
    await expect(
      setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-06-01', positionId: shared.id }),
    ).rejects.toThrow(/not a valid option/i);
    // Opted back in → accepted.
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    const res = await setEmploymentAssignment(a, {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      positionId: shared.id,
    });
    expect(res.changed).toBe(true);
    expect((await openAssignment(hire.employmentId)).positionId).toBe(shared.id);
  });

  it('lifecycle: a held shared-in position survives the flag being flipped OFF — an unrelated save carries it, no silent clear', async () => {
    const a = adminCtx(b);
    const hire = await hireOne();
    const coB = await secondCompany();
    const shared = await createPosition(a, { companyId: coB, title: 'Held Shared Position' });
    await assignLabelToCompanies(a, { kind: 'position', labelId: shared.id, companyIds: [b.companyId] });
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: true });
    await setEmploymentAssignment(a, { employmentId: hire.employmentId, effectiveDate: '2026-03-01', positionId: shared.id });
    // Sharing later switched off — the stored value is now outside the company's normal option set.
    await setCompanySharedLabels(a, { companyId: b.companyId, enabled: false });
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
    path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
    'utf8',
  );

  it('scopes the departments load to the employee company (resolver-aware read)', () => {
    expect(PAGE).toMatch(/listDepartments\(s,\s*\{\s*companyIds:\s*\[emp\.companyId\]\s*\}\)/);
  });

  it('renders a pinned-current option when the stored BU / Department / Position left the scoped list', () => {
    expect(PAGE).toContain('!businessUnits.some((bu) => bu.id === current.businessUnitId)');
    expect(PAGE).toContain('!departments.some((d) => d.id === current.departmentId)');
    expect(PAGE).toContain('!positions.some((pos) => pos.id === current.positionId)');
  });
});

/**
 * d61f0ff2 — the empty-dropdown regression: Criteria (label_company_assignment) rows were written
 * unconditionally, but the resolver ignored them (and global labels) while the target company's
 * shared_system_labels flag stayed at its OFF default — so a company whose labels were all
 * distributed through Criteria saw EMPTY hire-form dropdowns. Fix under test: every Criteria write
 * now auto-enables the flag for its target companies (same transaction); the flag stays an explicit
 * per-company opt-out.
 */
describe('d61f0ff2 — Criteria assignment auto-enables company sharing (never silently ignored)', () => {
  it('assignLabelToCompanies flips shared_system_labels ON for the target company and the label resolves immediately', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Criteria Dept' });
    // The reported scenario: the flag is at its OFF default for the target company — no manual enable.
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co.sharedSystemLabels).toBe(true);
    expect(await labelIdsForCompany(a, 'department', b.companyId)).toContain(shared.id);
    // Substrate: the auto-enable appends the SAME company event the manual Sharing toggle does.
    expect(await eventTypesFor(b.tenantId, b.companyId)).toContain('company.shared-labels.enabled');
  });

  it('setLabelGlobal(true) enables sharing for every company of the tenant so the global label surfaces everywhere', async () => {
    const a = adminCtx(b); // group admin — passes the is_global trigger gate
    const coB = await secondCompany();
    const glob = await createPosition(a, { companyId: b.companyId, title: 'Global Criteria Pos' });
    await setLabelGlobal(a, { kind: 'position', labelId: glob.id, isGlobal: true });
    const rows = await owner.db
      .select()
      .from(schema.company)
      .where(eq(schema.company.tenantId, b.tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((c) => c.sharedSystemLabels)).toBe(true);
    expect(await labelIdsForCompany(a, 'position', coB)).toContain(glob.id);
  });
});

describe('d61f0ff2 — 0298 backfill turns pre-existing Criteria rows into visible labels', () => {
  /** Re-execute the 0298 backfill UPDATEs from the ACTUAL migration file (equivalence-tested, not
   *  copied — the 0290 convention in test/employee-pay-structure.test.ts). */
  async function runBackfill() {
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../db/migrations/0298_shared_labels_criteria_backfill.sql'),
      'utf8',
    );
    const stmts = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.includes('UPDATE "company"'));
    if (stmts.length !== 2) throw new Error('0298 backfill statements not found');
    for (const s of stmts) await owner.db.execute(sql.raw(s));
  }

  it('enables sharing for a company with Criteria rows pointing at it; a junction-free company in a global-free tenant stays opted out', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const shared = await createDepartment(a, { companyId: coB, name: 'Backfill Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: shared.id, companyIds: [b.companyId] });
    // Recreate the PRE-FIX world: Criteria rows exist but every flag is OFF (assign used to leave it off).
    await owner.db
      .update(schema.company)
      .set({ sharedSystemLabels: false })
      .where(eq(schema.company.tenantId, b.tenantId));
    expect(await labelIdsForCompany(a, 'department', b.companyId)).not.toContain(shared.id); // the reported bug

    await runBackfill();

    const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co.sharedSystemLabels).toBe(true);
    expect(await labelIdsForCompany(a, 'department', b.companyId)).toContain(shared.id);
    // coB has no junction rows pointing INTO it (the create path writes none) and the tenant has no
    // global labels — the backfill must NOT blanket-enable it (opt-outs stay respected).
    const [coBRow] = await owner.db.select().from(schema.company).where(eq(schema.company.id, coB));
    expect(coBRow.sharedSystemLabels).toBe(false);
  });

  it('enables sharing tenant-wide when the tenant has a global label (the is_global branch of the backfill)', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    await setLabelGlobal(a, { kind: 'cost_center', labelId: b.costCenterId, isGlobal: true });
    // Pre-fix world again: flags all OFF despite the configured "All Companies" label.
    await owner.db
      .update(schema.company)
      .set({ sharedSystemLabels: false })
      .where(eq(schema.company.tenantId, b.tenantId));
    expect(await labelIdsForCompany(a, 'cost_center', coB)).not.toContain(b.costCenterId);

    await runBackfill();

    expect(await labelIdsForCompany(a, 'cost_center', coB)).toContain(b.costCenterId);
    const rows = await owner.db
      .select()
      .from(schema.company)
      .where(eq(schema.company.tenantId, b.tenantId));
    expect(rows.every((c) => c.sharedSystemLabels)).toBe(true);
  });
});

/**
 * d61f0ff2 — hire form zero-visible-options empty state: when the selected company may use NONE of a
 * select's options, the page surfaces "No organization labels are configured for the selected
 * company" below the select instead of an unexplained empty dropdown. Drift guards pin the inline
 * script's toggle wiring + the page's server-rendered (hydration-parity) message elements.
 */
describe('d61f0ff2 — hire form zero-visible-options empty state', () => {
  const HIRE_PAGE = fs.readFileSync(path.resolve(__dirname, '../app/admin/personnel/page.tsx'), 'utf8');

  it('the inline script toggles a per-select `-empty` message from the visible-option count', () => {
    expect(HIRE_ORG_FILTER_SCRIPT).toContain(`document.getElementById(sel.id+'-empty')`);
    expect(HIRE_ORG_FILTER_SCRIPT).toContain('if(show)visCount++;');
    expect(HIRE_ORG_FILTER_SCRIPT).toContain('if(empty)empty.hidden=visCount>0;');
  });

  it('each filtered select renders the i18n message with server-computed initial visibility (hydration parity)', () => {
    for (const id of [
      'hire-business-unit-empty',
      'hire-department-empty',
      'hire-position-empty',
      'hire-cost-center-empty',
    ]) {
      expect(HIRE_PAGE).toContain(`id="${id}"`);
    }
    expect(HIRE_PAGE.match(/\{t\('orgLabelsEmptyForCompany'\)\}/g)).toHaveLength(4);
    // Initial hidden state derives from the SAME pure rule the script embeds (parity with the
    // hidden/disabled option stamps — see the hydration-parity suite in test/hire-form-filter.test.ts).
    expect(HIRE_PAGE.match(/hidden=\{!hireInitiallyEmpty\(\w+\)\}/g)).toHaveLength(4);
    expect(HIRE_PAGE).toContain('const hireInitiallyEmpty = (csvs: string[]) => csvs.every((csv) => hireInitiallyHidden(csv));');
  });

  it('the empty-state message exists in all six locales', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      ) as { people: { list: Record<string, string> } };
      expect(messages.people.list.orgLabelsEmptyForCompany, `missing in ${loc}`).toBeTruthy();
    }
  });
});
