/**
 * Personnel (Admin) — Organisation card consolidated into Organisation Assignment (feedback c5ac75fa,
 * Option B of the approved plan).
 *
 * The Employment tab used to show two stacked groups with two Save buttons: an effective-dated
 * "Organisation Assignment" (Business Unit / Department / Position / Employment Type on `assignment`, plus
 * Job Grade on `employment`) and a flat "Organisation" fieldset (Division / Branch / Region / Line /
 * Section / Team / Base / Category — plain columns on `employment`, no history). They were left apart
 * because HTML forms cannot nest, so the two groups could not share one <form> without changing where the
 * eight flat fields persist.
 *
 * Option B resolves that at the ACTION layer instead: one form, one Save, and setOrganisationAssignmentAction
 * fans the submission back out to the same three core writers inside ONE transaction. Storage is unchanged —
 * nothing became effective-dated and no column moved (that was Option C, explicitly out of scope).
 *
 * What this suite pins down:
 *  (A) One submit persists BOTH legs — a new dated assignment row AND the eight flat columns.
 *  (B) Atomicity. A failure in the flat-org leg rolls the assignment change back, and a failure in the
 *      assignment leg rolls the grade change back. Without a shared transaction a half-save would leave the
 *      dated assignment history and the flat columns describing two different org placements.
 *  (C) setEmploymentInfo honours a caller-supplied transaction (the `outerTx` leg added for this item) and
 *      still behaves identically when called standalone.
 *  (D) The page + action are actually wired that way: the eight inputs live inside the consolidated form,
 *      that form has exactly one Save, and the action passes one `tx` to all three writers.
 *  (E) The mitigation the plan required — helper text under the effective date naming the fields it governs
 *      — exists in all six locales, and the Organisation/Organization spelling is normalised to the "s" form.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  hireEmployee,
  setEmploymentAssignment,
  setEmploymentGrade,
  setEmploymentInfo,
} from '../core/org';
import { createJobGrade } from '../core/admin';
import { createProfileOption } from '../core/profile-options';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `orgcons_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Consolidation Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

async function assignmentRows(employmentId: string) {
  return owner.db
    .select()
    .from(schema.assignment)
    .where(eq(schema.assignment.employmentId, employmentId))
    .orderBy(schema.assignment.validFrom);
}

async function openRow(employmentId: string) {
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

async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

/**
 * The exact composition setOrganisationAssignmentAction performs: three writers, one transaction, in the
 * action's order (grade → effective-dated assignment → flat org columns). The action itself cannot be called
 * from vitest (it needs a Next request context for requireAdmin and ends in a redirect() throw), so the
 * transactional contract is exercised here and test (D) below pins the action to this same shape.
 */
async function consolidatedSave(p: {
  employmentId: string;
  gradeId?: string | null;
  effectiveDate: string;
  departmentId?: string;
  positionId?: string | null;
  org?: Partial<Record<
    'orgDivision' | 'orgBranch' | 'orgRegion' | 'orgLine' | 'orgSection' | 'orgTeam' | 'orgBase' | 'employmentCategory',
    string | null
  >>;
}) {
  return withTenant(adminCtx(b), async (tx) => {
    if (p.gradeId !== undefined) {
      await setEmploymentGrade(adminCtx(b), { employmentId: p.employmentId, gradeId: p.gradeId }, tx);
    }
    await setEmploymentAssignment(
      adminCtx(b),
      {
        employmentId: p.employmentId,
        effectiveDate: p.effectiveDate,
        departmentId: p.departmentId,
        positionId: p.positionId,
      },
      tx,
    );
    await setEmploymentInfo(adminCtx(b), { employmentId: p.employmentId, ...(p.org ?? {}) }, tx);
  });
}

describe('consolidated Organisation Assignment save — both legs in one submit', () => {
  it('persists the dated assignment row AND the eight flat org columns from one save', async () => {
    const hire = await hireOne();
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 5)}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
    });

    await consolidatedSave({
      employmentId: hire.employmentId,
      gradeId: grade.id,
      effectiveDate: '2026-04-01',
      departmentId: b.deptB,
      org: {
        orgDivision: 'Div One',
        orgBranch: 'Br One',
        orgRegion: 'Reg One',
        orgLine: 'Line One',
        orgSection: 'Sec One',
        orgTeam: 'Team One',
        orgBase: 'Base One',
        employmentCategory: 'Cat One',
      },
    });

    // Effective-dated leg: history preserved (old row closed, new row opened), not overwritten.
    const rows = await assignmentRows(hire.employmentId);
    expect(rows).toHaveLength(2);
    expect(rows[0].validTo).toBe('2026-04-01');
    const open = await openRow(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.validFrom).toBe('2026-04-01');

    // Flat leg: the eight relocated columns, still plain columns on `employment` with no dated history.
    const emp = await employmentRow(hire.employmentId);
    expect(emp.gradeId).toBe(grade.id);
    expect(emp.orgDivision).toBe('Div One');
    expect(emp.orgBranch).toBe('Br One');
    expect(emp.orgRegion).toBe('Reg One');
    expect(emp.orgLine).toBe('Line One');
    expect(emp.orgSection).toBe('Sec One');
    expect(emp.orgTeam).toBe('Team One');
    expect(emp.orgBase).toBe('Base One');
    expect(emp.employmentCategory).toBe('Cat One');
  });

  it('rolls the assignment change back when the flat org leg fails', async () => {
    const hire = await hireOne();
    // Seed the division catalog so an unknown value is rejected by setEmploymentInfo (the last writer to run).
    await createProfileOption(adminCtx(b), { category: 'division', value: `Live ${randomUUID().slice(0, 5)}` });

    const before = await openRow(hire.employmentId);
    const gradeBefore = (await employmentRow(hire.employmentId)).gradeId;
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 5)}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
    });

    await expect(
      consolidatedSave({
        employmentId: hire.employmentId,
        gradeId: grade.id,
        effectiveDate: '2026-05-01',
        departmentId: b.deptB,
        org: { orgDivision: 'Not In Catalog' },
      }),
    ).rejects.toThrow(/not an active division option/i);

    // Nothing from ANY leg survived: no new dated row, department unmoved, grade unmoved.
    const rows = await assignmentRows(hire.employmentId);
    expect(rows).toHaveLength(1);
    const open = await openRow(hire.employmentId);
    expect(open.id).toBe(before.id);
    expect(open.departmentId).toBe(b.deptA);
    expect(open.validTo).toBeNull();
    expect((await employmentRow(hire.employmentId)).gradeId).toBe(gradeBefore);
  });

  it('rolls the grade change back when the effective-dated leg fails', async () => {
    const hire = await hireOne();
    const gradeBefore = (await employmentRow(hire.employmentId)).gradeId;
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 5)}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
    });

    // An effective date before the current assignment's validFrom is rejected by setEmploymentAssignment,
    // which runs AFTER setEmploymentGrade has already written employment.gradeId inside the same tx.
    await expect(
      consolidatedSave({
        employmentId: hire.employmentId,
        gradeId: grade.id,
        effectiveDate: '2025-01-01',
        departmentId: b.deptB,
        org: { orgDivision: 'Anything' },
      }),
    ).rejects.toThrow(/effective date cannot be before/i);

    expect((await employmentRow(hire.employmentId)).gradeId).toBe(gradeBefore);
    expect(await assignmentRows(hire.employmentId)).toHaveLength(1);
  });

  it('leaves the Employment Dates fields untouched — the consolidated save passes none of them', async () => {
    const hire = await hireOne();
    // Seed dates through the standalone (non-transactional) path first.
    await setEmploymentInfo(adminCtx(b), {
      employmentId: hire.employmentId,
      confirmationDate: '2026-07-01',
      probationValue: '3',
      probationUnit: 'month',
    });

    // orgTeam, not orgDivision: an earlier case in this file seeds the `division` catalog, and resetDb only
    // runs once per file, so a free-text division would be rejected here for an unrelated reason.
    await consolidatedSave({
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      org: { orgTeam: 'Team Two' },
    });

    const emp = await employmentRow(hire.employmentId);
    expect(emp.orgTeam).toBe('Team Two');
    // Absent keys are `undefined` = untouched, never cleared — the guarantee that lets Employment Dates
    // keep its own separate form without the two saves wiping each other.
    expect(emp.confirmationDate).toBe('2026-07-01');
    expect(emp.probationValue).toBe(3);
    expect(emp.probationUnit).toBe('month');
  });

  it('setEmploymentInfo still commits on its own when no transaction is supplied', async () => {
    const hire = await hireOne();
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgTeam: 'Solo Team' });
    expect((await employmentRow(hire.employmentId)).orgTeam).toBe('Solo Team');
  });
});

const REPO = path.resolve(__dirname, '..');
const pageSrc = fs.readFileSync(
  path.join(REPO, 'app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const actionsSrc = fs.readFileSync(
  path.join(REPO, 'app/admin/personnel/[employmentId]/actions.ts'),
  'utf8',
);

const ORG_FIELDS = [
  'orgDivision',
  'orgBranch',
  'orgRegion',
  'orgLine',
  'orgSection',
  'orgTeam',
  'orgBase',
  'employmentCategory',
] as const;

/* 8ebabbf2 — the "page + action wiring" block that used to live here pinned the CONSOLIDATED EDITING FORM:
 * one <form action={setOrganisationAssignmentAction}>, one Save, one shared tx, the effective-date helper
 * text. That form no longer exists — the Organisation Assignment section is view-only and every field it
 * carried is now changed through Movement. The guards below replace it, asserting the same wiring question
 * from the other side: that the editing path is really gone and nothing kept a back door to it.
 *
 * The SERVICE-level suites above are untouched and still load-bearing: setEmploymentInfo's `outerTx` leg is
 * what lets Movement's comparison writer commit the assignment, grade and flat-column legs atomically, which
 * is exactly the atomicity those tests pin. */
describe('8ebabbf2 — the Employment tab has no organisation-assignment writer left', () => {
  it('deletes setOrganisationAssignmentAction rather than leaving it exported', () => {
    // Every exported `use server` function is a live RPC endpoint. An orphaned one that still writes
    // effective-dated assignments — with no movement tag — is callable by anything that knows its id, and
    // would emit history-visible events that project their own untagged Employment History row.
    expect(actionsSrc).not.toContain('export async function setOrganisationAssignmentAction');
    expect(pageSrc).not.toContain('setOrganisationAssignmentAction');
  });

  it('renders no editable control for any organisation-assignment field', () => {
    // The eight flat columns, the four effective-dated fields and the grade: none may be submitted from
    // this page any more. Checked by input NAME, because a `name` is exactly what makes a control a writer.
    for (const f of ORG_FIELDS) {
      expect(pageSrc, `${f} must not be submittable from the Employment tab`).not.toContain(`name="${f}"`);
    }
    for (const f of ['departmentId', 'positionId', 'gradeId', 'employmentType']) {
      // The pre-transaction Company correction block (9464bd56) keeps its own department/position/BU
      // pickers, so these names may still appear — but never inside a setEmploymentInfoAction form.
      const infoForm = pageSrc.slice(
        pageSrc.indexOf('<form action={setEmploymentInfoAction}'),
        pageSrc.indexOf('</form>', pageSrc.indexOf('<form action={setEmploymentInfoAction}')),
      );
      expect(infoForm, `${f} must not ride along on the Employment Dates save`).not.toContain(`name="${f}"`);
    }
  });

  it('removes the Assignment Effective Date field and its helper text (expected behaviour #1)', () => {
    expect(pageSrc).not.toContain("t('employmentInfo.assignmentEffectiveDate')");
    expect(pageSrc).not.toContain("t('employmentInfo.assignmentEffectiveDateHelp')");
    expect(pageSrc).not.toContain("t('employmentInfo.saveAssignment')");
    // The section heading stays — it is still a section, just a read-only one.
    expect(pageSrc).toContain("t('employmentInfo.assignmentGroup')");
  });

  it('points the administrator at Movement where the editing used to be', () => {
    expect(pageSrc).toContain("t('employmentInfo.assignmentViewOnlyNote')");
    expect(pageSrc).toContain("t('employmentInfo.assignmentViewOnlyLink')");
    // The link must open the New Event form itself, not merely the Movement tab.
    expect(pageSrc).toContain('?tab=careerMovement&newEvent=1');
  });

  it('still adds no migration — this item changes presentation and permissions only', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO, 'db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => /c5ac75fa|8ebabbf2|organisation.assignment/i.test(e.tag))).toBe(false);
  });
});

describe('i18n', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.join(REPO, 'messages', `${loc}.json`), 'utf8'));

  // 8ebabbf2 — the effective-date helper text was the mitigation for a Save that dated only some of the
  // fields beside it. With no Save and no date field, the text is orphaned: it must be GONE from every
  // locale (an unused key is the thing that later gets rendered by mistake), and the view-only pointer that
  // replaced it must be present in every locale. `tsc` cannot see either problem — t('nope') type-checks.
  it('drops the orphaned assignment-form keys from all six locales', () => {
    for (const loc of LOCALES) {
      const ei = load(loc).people.detail.employmentInfo;
      for (const k of [
        'assignmentEffectiveDate',
        'assignmentEffectiveDateHelp',
        'assignmentNote',
        'saveAssignment',
      ]) {
        expect(ei[k], `${loc}: ${k} must be gone with the editing form`).toBeUndefined();
      }
    }
  });

  it('carries the view-only pointer text in all six locales', () => {
    for (const loc of LOCALES) {
      const ei = load(loc).people.detail.employmentInfo;
      for (const k of ['assignmentViewOnlyNote', 'assignmentViewOnlyLink', 'joinDatesViewOnlyNote']) {
        expect(typeof ei[k], `${loc} must define ${k}`).toBe('string');
        expect(ei[k].trim().length, `${loc}: ${k} must not be blank`).toBeGreaterThan(0);
      }
      // Each locale must be a real translation, not the English string copied through.
      if (loc !== 'en') {
        expect(ei.assignmentViewOnlyNote, `${loc} must not fall back to English`).not.toBe(
          load('en').people.detail.employmentInfo.assignmentViewOnlyNote,
        );
      }
    }
  });

  it('normalises the English spelling to "Organisation"', () => {
    const ei = load('en').people.detail.employmentInfo;
    expect(ei.orgGroup).toBe('Organisation');
    expect(ei.assignmentGroup).toBe('Organisation Assignment');
    // No z-spelling left anywhere on this card's labels.
    expect(JSON.stringify(ei)).not.toMatch(/Organization/);
  });
});
