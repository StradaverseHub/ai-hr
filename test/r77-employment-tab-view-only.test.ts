/**
 * 8ebabbf2 — the Personnel (Admin) Employment tab becomes VIEW-ONLY for organisation assignment.
 *
 * The tab used to carry a full editing form (setOrganisationAssignmentAction) that wrote the same facts the
 * Movement module records as dated events. Two writers for one truth is how a record and its own employment
 * history come to disagree, so the editing form is gone and every organisation dimension now changes through
 * Movement → New Event.
 *
 * Removing a writer is the risky half. r73 Decision 3 is the cautionary case: transferEmployee carried six
 * fields forward but silently dropped business_unit_id, so changing a location quietly unassigned people from
 * their business unit — no error, no event, no changed label. So this suite does NOT merely assert that the
 * form is gone; it asserts that the destination actually WRITES every field the form used to write:
 *
 *   (A) Field parity — one movement moves all thirteen dimensions the item lists, and every one lands.
 *   (B) Nothing is silently dropped — Business Unit in particular survives a movement that also moves other
 *       fields (the r73 failure mode, now pinned on the replacement path).
 *   (C) ONE history row — the legs share a groupId with the first primary and the rest `secondary`. r76
 *       reported the converse: writers outside the comparison form emit untagged events that each project
 *       their own Employment History row. Routing assignment through Movement is only correct if the whole
 *       change still reads as one movement.
 *   (D) The Employment tab has no path left to those fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { hireEmployee } from '../core/org';
import { createJobGrade } from '../core/admin';
import { createProfileOption } from '../core/profile-options';
import { createMovementEvent, movementCurrentState, movementHistory } from '../core/movement';
import { employeeDetail } from '../core/read';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'ViewOnly', primaryEmail: `vo_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** A business unit + position + grade to move the employee onto. */
async function targets() {
  const buId = randomUUID();
  await owner.db.insert(schema.businessUnit).values({
    id: buId,
    tenantId: b.tenantId,
    companyId: b.companyId,
    name: 'Target BU',
    code: `BU${randomUUID().slice(0, 4)}`,
  });
  const posId = randomUUID();
  await owner.db.insert(schema.position).values({
    id: posId,
    tenantId: b.tenantId,
    companyId: b.companyId,
    title: 'Target Position',
  });
  const suffix = randomUUID().slice(0, 4);
  const grade = await createJobGrade(adminCtx(b), { code: `G${suffix}`, name: `Grade ${suffix}`, rank: 5 });
  return { buId, posId, gradeId: grade.id };
}

/** The eight flat columns are catalog-backed — a value must be an ACTIVE profile_option for its category. */
async function catalog(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const pairs: [string, string][] = [
    ['division', 'orgDivision'],
    ['branch', 'orgBranch'],
    ['region', 'orgRegion'],
    ['line', 'orgLine'],
    ['section', 'orgSection'],
    ['team', 'orgTeam'],
    ['base', 'orgBase'],
    ['category', 'employmentCategory'],
  ];
  for (const [category, field] of pairs) {
    const value = `${category}-target`;
    await createProfileOption(adminCtx(b), { category: category as 'division', value });
    out[field] = value;
  }
  return out;
}

describe('(A/B) field parity — Movement writes everything the Employment tab used to', () => {
  it('one movement moves every organisation dimension the item lists', async () => {
    const emp = await hire();
    const { buId, posId, gradeId } = await targets();
    const flat = await catalog();

    // Everything the removed form could change, in ONE submit — the way the comparison form posts it.
    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-03-01',
      remarks: 'Reorganisation',
      departmentId: b.deptB ?? b.deptA,
      positionId: posId,
      businessUnitId: buId,
      gradeId,
      employmentType: 'contract',
      ...flat,
    });

    const state = await movementCurrentState(adminCtx(b), emp.employmentId);
    expect(state.businessUnitId).toBe(buId);
    expect(state.positionId).toBe(posId);
    expect(state.gradeId).toBe(gradeId);
    expect(state.employmentType).toBe('contract');
    for (const [field, value] of Object.entries(flat)) {
      expect(state[field as 'orgDivision'], `${field} must be written by the movement`).toBe(value);
    }

    // …and the employee record the Employment tab now DISPLAYS agrees with it.
    const d = await employeeDetail(adminCtx(b), emp.employmentId);
    expect(d!.gradeId).toBe(gradeId);
    expect(d!.orgDivision).toBe(flat.orgDivision);
    expect(d!.employmentCategory).toBe(flat.employmentCategory);
  });

  it('does NOT silently drop Business Unit when the movement also moves other fields (r73 Decision 3)', async () => {
    const emp = await hire();
    const { buId, gradeId } = await targets();

    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-03-01',
      businessUnitId: buId,
    });
    expect((await movementCurrentState(adminCtx(b), emp.employmentId)).businessUnitId).toBe(buId);

    // A SECOND, unrelated movement (grade only) must carry the business unit forward on the new assignment
    // version. This is the exact shape of the r73 bug: the field is lost by a write that was never about it.
    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      gradeId,
    });
    const after = await movementCurrentState(adminCtx(b), emp.employmentId);
    expect(after.gradeId).toBe(gradeId);
    expect(after.businessUnitId, 'business unit must survive an unrelated movement').toBe(buId);

    // Belt and braces at the row level: the OPEN assignment row itself still carries it.
    const openRow = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ businessUnitId: schema.assignment.businessUnitId, validTo: schema.assignment.validTo })
        .from(schema.assignment)
        .where(eq(schema.assignment.employmentId, emp.employmentId)),
    );
    const open = openRow.find((r) => r.validTo == null);
    expect(open?.businessUnitId).toBe(buId);
  });
});

describe('(C) one movement, one Employment History row', () => {
  it('a multi-leg organisation change projects exactly ONE row', async () => {
    const emp = await hire();
    const { buId, posId, gradeId } = await targets();
    const flat = await catalog();

    const before = await movementHistory(adminCtx(b), emp.employmentId);

    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-03-01',
      remarks: 'Reorganisation',
      positionId: posId,
      businessUnitId: buId,
      gradeId, // a second leg (setEmploymentGrade)
      ...flat, // a third leg (setEmploymentInfo flat columns)
    });

    const after = await movementHistory(adminCtx(b), emp.employmentId);
    // Three writers ran. If any leg were tagged primary — or untagged — the history would show 2-3 rows for
    // one change, which is the open duplicate-history-row report from r76.
    expect(after.length - before.length).toBe(1);
    const row = after.find((r) => r.kind === 'orgAssignmentChange');
    expect(row).toBeDefined();
    expect(row!.effectiveDate).toBe('2026-03-01');
    expect(row!.remarks).toBe('Reorganisation');

    // No stray Grade Change row from the grade leg (its untagged label), which is what a missing
    // `secondary` flag would produce.
    expect(after.filter((r) => r.kind === 'gradeChange')).toHaveLength(0);
  });
});

// ── (D) Source guards on the tab itself ──
const REPO = path.resolve(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(REPO, 'app/admin/personnel/[employmentId]/page.tsx'), 'utf8');
const actionsSrc = fs.readFileSync(
  path.join(REPO, 'app/admin/personnel/[employmentId]/actions.ts'),
  'utf8',
);


/**
 * r277 (a72610af) — THE EMPLOYMENT DATES INPUTS ARE NO LONGER ALL LITERAL IN page.tsx.
 *
 * a72610af extracted the period and confirmation controls into components/employment-period-fields.tsx so
 * that the Create New Employee DRAFT could render the SAME controls the record renders, in `controlled`
 * mode, instead of a second copy that could drift from them. In `form` mode the control still emits a real
 * `name`, and `setEmploymentInfoAction` still reads the identical FormData keys — nothing about what this
 * screen posts changed.
 *
 * So this guard pins the CONTRACT ACROSS BOTH FILES rather than grepping one of them. A single-file
 * `toContain('name="X"')` went red on a refactor that changed no behaviour, which is a guard reporting on
 * where a string lives rather than on what the screen does. Either the page still carries the input
 * itself, or it hands the name to the shared control AND that control turns it into a real `name` — and if
 * anyone deletes the emission in the component, every arm below fails, so this is not a way to pass by
 * indirection.
 */
const PERIOD_FIELDS_SRC = fs.readFileSync(
  path.join(process.cwd(), 'components/employment-period-fields.tsx'),
  'utf8',
);

function postsFieldNamed(src: string, name: string): boolean {
  // (a) Still a plain named input on the page.
  if (src.includes(`name="${name}"`)) return true;
  // (b) Handed to the extracted period control, which emits both halves as real names in form mode.
  if (
    (src.includes(`valueName="${name}"`) || src.includes(`unitName="${name}"`)) &&
    PERIOD_FIELDS_SRC.includes('name: props.valueName') &&
    PERIOD_FIELDS_SRC.includes('name: props.unitName')
  ) {
    return true;
  }
  // (c) The confirmation-date control, whose form mode defaults to this very name.
  if (
    name === 'confirmationDate' &&
    src.includes('<ConfirmationDateField mode="form"') &&
    PERIOD_FIELDS_SRC.includes("name: props.name ?? 'confirmationDate'")
  ) {
    return true;
  }
  return false;
}

describe('(D) the Employment tab has no writer for the fields it displays', () => {
  it('the only forms left on the Employment Information card are the dates save and the company correction', () => {
    // Slice the card, then enumerate its <form action={...}> handlers. A new writer appearing here is the
    // regression this item exists to prevent, and it would not show up as a failing behaviour test.
    const start = pageSrc.indexOf('const employmentInfoCard = admin ? (');
    expect(start).toBeGreaterThan(-1);
    const end = pageSrc.indexOf('const directSuperiorCard', start);
    expect(end).toBeGreaterThan(start);
    const card = pageSrc.slice(start, end);

    const handlers = [...card.matchAll(/<form action=\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(handlers).toEqual(['changeEmploymentCompanyAction', 'setEmploymentInfoAction']);
  });

  it('keeps the pre-transaction Company correction, which Movement does not replace', () => {
    // Deliberately NOT removed: changeEmploymentCompany is gated to employments with no recorded activity
    // (an initial data-entry fix), and there is no company-change movement kind. Removing it would leave no
    // way to correct a mis-keyed company at all. Once the employee has activity the field is already locked
    // and the card points at Movement.
    expect(actionsSrc).toContain('export async function changeEmploymentCompanyAction');
    expect(pageSrc).toContain("t('employmentInfo.companyLockedNote')");
  });

  it('leaves the non-assignment Employment Dates fields editable', () => {
    // The item scopes view-only to ORGANISATION ASSIGNMENT (plus the two join dates, item 89ea527b).
    // Probation / notice / resignation are lifecycle facts with no movement kind that owns them; silently
    // freezing them too would remove capability the item never asked to remove.
    for (const name of ['confirmationDate', 'probationValue', 'tenderResignationDate', 'lastWorkingDate']) {
      expect(postsFieldNamed(pageSrc, name), `${name} must remain editable`).toBe(true);
    }
  });
});
