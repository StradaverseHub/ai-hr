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

/** The consolidated <form action={setOrganisationAssignmentAction}> … </form> block, by brace depth. */
function consolidatedFormBlock(): string {
  const start = pageSrc.indexOf('<form action={setOrganisationAssignmentAction}');
  expect(start).toBeGreaterThan(-1);
  const end = pageSrc.indexOf('</form>', start);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

describe('page + action wiring', () => {
  it('renders the eight relocated org fields INSIDE the consolidated assignment form', () => {
    const block = consolidatedFormBlock();
    for (const f of ORG_FIELDS) {
      expect(block, `${f} must be submitted by the consolidated form`).toContain(`name="${f}"`);
    }
    // …and the effective-dated fields are in that same form, i.e. it really is one section.
    expect(block).toContain('name="departmentId"');
    expect(block).toContain('name="effectiveDate"');
    expect(block).toContain('name="gradeId"');
  });

  it('gives that section exactly ONE Save button', () => {
    const block = consolidatedFormBlock();
    expect(block.match(/<button/g) ?? []).toHaveLength(1);
    expect(block).toContain("t('employmentInfo.saveAssignment')");
  });

  it('no longer renders a second Organisation heading or a superseded assignment action', () => {
    // The old fieldset legend is gone — one heading, not two.
    expect(pageSrc).not.toContain("t('employmentInfo.orgGroup')");
    expect(pageSrc).not.toContain('setEmploymentAssignmentAction');
    expect(actionsSrc).not.toContain('export async function setEmploymentAssignmentAction');
  });

  it('shows the effective-date helper text that scopes the date to the fields it governs', () => {
    expect(consolidatedFormBlock()).toContain("t('employmentInfo.assignmentEffectiveDateHelp')");
  });

  it('drives all three writers from ONE transaction in the action', () => {
    const start = actionsSrc.indexOf('export async function setOrganisationAssignmentAction');
    expect(start).toBeGreaterThan(-1);
    const body = actionsSrc.slice(start, actionsSrc.indexOf('\n}\n', start));
    expect(body).toContain('await withTenant(s, async (tx) => {');

    // Each writer's own argument list must end with that shared tx — otherwise it opens its own
    // transaction and a failure downstream can no longer roll it back. Paren-matched rather than
    // regex-matched so the assertion does not trip over `(tx)` in the withTenant callback signature.
    const argsOf = (fn: string): string => {
      const open = body.indexOf(`${fn}(`);
      expect(open, `${fn} must be called in the consolidated action`).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = open + fn.length; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')' && --depth === 0) return body.slice(open + fn.length + 1, i);
      }
      throw new Error(`unbalanced parens in ${fn} call`);
    };
    for (const fn of ['setEmploymentGrade', 'setEmploymentAssignment', 'setEmploymentInfo']) {
      expect(argsOf(fn).trimEnd().replace(/,$/, '').trimEnd(), `${fn} must receive the shared tx`).toMatch(
        /\btx$/,
      );
    }
    for (const f of ORG_FIELDS) expect(body).toContain(`${f}:`);
  });

  it('does not add a migration — Option B changes presentation and submission only', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO, 'db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => /c5ac75fa|organisation.assignment.consolidat/i.test(e.tag))).toBe(false);
  });
});

describe('i18n', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.join(REPO, 'messages', `${loc}.json`), 'utf8'));

  it('carries the effective-date helper text in all six locales', () => {
    for (const loc of LOCALES) {
      const v = load(loc).people.detail.employmentInfo.assignmentEffectiveDateHelp;
      expect(typeof v, `${loc} must define assignmentEffectiveDateHelp`).toBe('string');
      expect(v.trim().length, `${loc} helper text must not be blank`).toBeGreaterThan(0);
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
