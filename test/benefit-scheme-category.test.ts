/**
 * Add Scheme Category to Benefit Scheme Configuration (feedback 0890a555, migration 0335).
 *
 * A GROUPING LABEL, AND NOTHING MORE. The reporter is explicit: "The Scheme Category is purely a
 * configuration attribute and does not affect employee eligibility, entitlement calculation, Employment
 * Type, Personnel Profile, Hiring Information or any HR master data." §3 is the section that holds us to
 * that — it is far easier to add a column that quietly leaks into resolution than to notice later that it
 * has.
 *
 *   §1  The column round-trips through the real writer, is nullable with no default, and is editable and
 *       clearable at any time (the request: "The value must always remain editable").
 *   §2  The "smart default": a suggestion derived from the scheme name and employment type, offered — never
 *       imposed. Driven off the reporter's own worked table.
 *   §3  Entitlement resolution is untouched, asserted by resolving an employee's scheme with the category
 *       set, changed and cleared and getting the same answer every time.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  createBenefitScheme,
  updateBenefitScheme,
  listBenefitSchemes,
  cleanSchemeCategory,
  upsertSchemeEntitlement,
} from '../core/benefit-scheme';
import { resolveEffectiveSchemeId, schemeBandDays } from '../core/leave-compute';
import { suggestSchemeCategory } from '../lib/benefit-scheme-label';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

const uniqName = (s: string) => `${s} ${randomUUID().slice(0, 8)}`;

async function schemeRow(id: string) {
  const [row] = await owner.db
    .select({
      schemeCategory: schema.benefitScheme.schemeCategory,
      employmentType: schema.benefitScheme.employmentType,
      gradeGroupId: schema.benefitScheme.gradeGroupId,
      status: schema.benefitScheme.status,
      name: schema.benefitScheme.name,
    })
    .from(schema.benefitScheme)
    .where(eq(schema.benefitScheme.id, id))
    .limit(1);
  return row!;
}

describe('§1 the column round-trips, and stays editable', () => {
  it('a scheme created WITHOUT a category stores NULL — no default, no guess', async () => {
    const ctx = adminCtx(b);
    const s = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name: uniqName('Grade 12-15'),
      status: 'active',
    });
    expect((await schemeRow(s.id)).schemeCategory).toBeNull();
    // …and the list surface reports it as ungrouped rather than inventing one.
    const listed = (await listBenefitSchemes(ctx)).find((x) => x.id === s.id);
    expect(listed!.schemeCategory).toBeNull();
  });

  it('a category set on create is stored, and can be changed and then cleared', async () => {
    const ctx = adminCtx(b);
    const name = uniqName('Contract - Special');
    const s = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name,
      status: 'active',
      schemeCategory: 'Contract (Special)',
    });
    expect((await schemeRow(s.id)).schemeCategory).toBe('Contract (Special)');

    await updateBenefitScheme(ctx, {
      id: s.id,
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name,
      status: 'active',
      schemeCategory: 'Contract (Retiree)',
    });
    expect((await schemeRow(s.id)).schemeCategory).toBe('Contract (Retiree)');

    // Cleared — back to ungrouped. A category the tenant cannot remove would be worse than none.
    await updateBenefitScheme(ctx, {
      id: s.id,
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name,
      status: 'active',
      schemeCategory: '   ',
    });
    expect((await schemeRow(s.id)).schemeCategory).toBeNull();
  });

  it('MULTIPLE schemes may share one category — that is what grouping means', async () => {
    const ctx = adminCtx(b);
    const ids: string[] = [];
    for (const label of ['Grade 12-18', 'Grade >=19', 'Grade H']) {
      const s = await createBenefitScheme(ctx, {
        companyId: b.companyId,
        employmentType: 'contract',
        gradeGroupId: null,
        name: uniqName(label),
        status: 'active',
        schemeCategory: 'Contract (Special)',
      });
      ids.push(s.id);
    }
    const listed = await listBenefitSchemes(ctx);
    const shared = listed.filter((x) => ids.includes(x.id));
    expect(shared).toHaveLength(3);
    expect(new Set(shared.map((x) => x.schemeCategory))).toEqual(new Set(['Contract (Special)']));
  });

  it('normalisation: whitespace collapses, blanks become null, and the tenant’s casing is preserved', () => {
    expect(cleanSchemeCategory('  Contract   (Special)  ')).toBe('Contract (Special)');
    expect(cleanSchemeCategory('')).toBeNull();
    expect(cleanSchemeCategory('   ')).toBeNull();
    expect(cleanSchemeCategory(null)).toBeNull();
    expect(cleanSchemeCategory(undefined)).toBeNull();
    // NOT re-cased — "HQ" must not become "Hq", the same rule the scheme-name module already follows.
    expect(cleanSchemeCategory('HQ CONTRACT')).toBe('HQ CONTRACT');
  });
});

describe('§2 the smart default is a SUGGESTION, derived from the name and the employment type', () => {
  // The reporter's own worked table, read as (scheme name, employment type label) → suggested category.
  const CASES: Array<[string, string, string]> = [
    ['Grade 12-15 (Permanent)', 'Permanent', 'Permanent'],
    ['Grade 16-19 (Permanent)', 'Permanent', 'Permanent'],
    ['Grade 12-18 (Contract)', 'Contract', 'Contract'],
    ['Contract - Special (40 AL)', 'Contract', 'Contract'],
    ['Contract - Grade >=19 (Special)', 'Contract', 'Contract (Special)'],
    ['Contract - Grade H (Retiree)', 'Contract', 'Contract (Retiree)'],
    ['Part Time', 'Part Time', 'Part Time'],
  ];

  for (const [name, empLabel, expected] of CASES) {
    it(`"${name}" + ${empLabel} suggests "${expected}"`, () => {
      expect(suggestSchemeCategory({ name }, empLabel)).toBe(expected);
    });
  }

  it('a parenthetical that merely restates the employment type adds nothing', () => {
    // "(Permanent)" beside a Permanent scheme is not a sub-division, so the category is just the type.
    expect(suggestSchemeCategory({ name: 'GRADE 12-15 (PERMANENT)' }, 'Permanent')).toBe('Permanent');
  });

  it('a numeric qualifier is NOT used — it describes the entitlement, not the population', () => {
    // "(40 AL)" would give every scheme its own category and reproduce the flat list this replaces.
    expect(suggestSchemeCategory({ name: 'Contract - Special (40 AL)' }, 'Contract')).toBe('Contract');
    expect(suggestSchemeCategory({ name: 'Executive (14 days)' }, 'Permanent')).toBe('Permanent');
  });

  it('falls back to something usable rather than to nothing', () => {
    expect(suggestSchemeCategory({ name: '' }, 'Contract')).toBe('Contract');
    expect(suggestSchemeCategory({ name: 'Anything' }, '')).toBe('');
  });

  it('nothing WRITES the suggestion — a created scheme with no category still stores NULL', async () => {
    const ctx = adminCtx(b);
    // A name the suggester would happily produce "Contract (Retiree)" from.
    const s = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name: uniqName('Contract - Grade H (Retiree)'),
      status: 'active',
    });
    expect((await schemeRow(s.id)).schemeCategory).toBeNull();
  });
});

describe('§3 it changes NOTHING about who gets what', () => {
  it('scheme resolution for an employee is identical with the category set, changed and cleared', async () => {
    const ctx = adminCtx(b);
    const name = uniqName('Resolver scheme');
    const s = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name,
      status: 'active',
    });
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Cat', primaryEmail: `cat_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });

    const resolve = async () => {
      const rows = await owner.db
        .select({
          id: schema.benefitScheme.id,
          companyId: schema.benefitScheme.companyId,
          employmentType: schema.benefitScheme.employmentType,
          gradeGroupId: schema.benefitScheme.gradeGroupId,
          status: schema.benefitScheme.status,
        })
        .from(schema.benefitScheme);
      return resolveEffectiveSchemeId(rows, {
        companyId: b.companyId,
        employmentType: 'full_time',
        gradeGroupId: null,
        overrideSchemeId: null,
      });
    };

    const before = await resolve();
    expect(before).toBe(s.id);

    for (const category of ['Permanent', 'Contract (Special)', null]) {
      await updateBenefitScheme(ctx, {
        id: s.id,
        companyId: b.companyId,
        employmentType: 'full_time',
        gradeGroupId: null,
        name,
        status: 'active',
        schemeCategory: category,
      });
      expect(await resolve()).toBe(before);
    }
    // The employment row itself never learned about any of it.
    const [e] = await owner.db
      .select({ benefitSchemeId: schema.employment.benefitSchemeId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp.employmentId))
      .limit(1);
    expect(e!.benefitSchemeId).toBeNull();
  });

  it('the DAYS a scheme entitles are unchanged by its category', async () => {
    const ctx = adminCtx(b);
    const name = uniqName('Days scheme');
    const s = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name,
      status: 'active',
      schemeCategory: 'Permanent',
    });
    const bands = [
      { fromYears: 0, toYears: 2, days: 12 },
      { fromYears: 2, toYears: 5, days: 16 },
      { fromYears: 5, toYears: null, days: 20 },
    ];
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: s.id,
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: bands,
    });
    const daysAt = (years: number) => schemeBandDays(bands, years);
    const expected = [daysAt(0), daysAt(3), daysAt(9)];
    expect(expected).toEqual([12, 16, 20]);

    await updateBenefitScheme(ctx, {
      id: s.id,
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name,
      status: 'active',
      schemeCategory: 'Something Else Entirely',
    });
    const [ent] = await owner.db
      .select({ serviceBands: schema.schemeLeaveEntitlement.serviceBands })
      .from(schema.schemeLeaveEntitlement)
      .where(eq(schema.schemeLeaveEntitlement.benefitSchemeId, s.id))
      .limit(1);
    expect(ent!.serviceBands).toEqual(bands);
  });
});
