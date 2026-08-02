/**
 * ADR-0080 D-14 — company existence is decoupled from statutory packs, under exactly two tiers.
 *
 * WHAT THIS REPLACES. `createCompany` called `requirePackFor(country)` and refused any country with no
 * registered pack. That guard was right as an interim measure: `isoCode` is a SHAPE check, so 'TH' and
 * 'ZZ' both pass, and a packless company failed SILENT on leave — the engines `continue` past a packless
 * employee and the holiday resolver yields an empty calendar, so nobody accrues and nobody is told.
 * r103 turned that silence into a reported `packBlocked` blocker, landing it (in its own words)
 * "deliberately BEFORE slice 6's non-statutory tier makes it reachable". This is that tier.
 *
 * WHY REFUSAL WAS THE WRONG PERMANENT ANSWER: a customer with a Thai plant either cannot onboard it, or
 * MISFILES Thai staff under the Malaysian company to get past the refusal — silently applying MY
 * statutory rules to foreign employees. The workaround is worse than the problem it works around.
 *
 * THE RULE, in one line: a pack is not optional where it exists, and not required where it does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, adminCtx, type Base } from './harness';
import {
  assertStatutory,
  COMPANY_TIERS,
  CompanyTierError,
  isCompanyTier,
  NON_STATUTORY,
  resolveCompanyTier,
  STATUTORY,
} from '../core/company-tier';
import { packFor } from '../localization/registry';
import { createCompany, updateCompany } from '../core/admin';

describe('resolveCompanyTier — the pack decides, the declaration only unlocks', () => {
  it('a packed country is STATUTORY', () => {
    expect(packFor('MY')).toBeTruthy();
    expect(resolveCompanyTier('MY')).toBe(STATUTORY);
  });

  it('a packed country REFUSES a non-statutory declaration — obligations are not a preference', () => {
    // The mistake in the other direction, and the more dangerous one: it would silently exempt a
    // Malaysian company from EPF, SOCSO, EIS and PCB because somebody ticked a box.
    expect(() => resolveCompanyTier('MY', true)).toThrow(CompanyTierError);
    expect(() => resolveCompanyTier('MY', true)).toThrow(/cannot be declared/i);
  });

  it('a packless country is still REFUSED when undeclared — identical outcome to the old guard', () => {
    expect(packFor('TH')).toBeUndefined();
    expect(() => resolveCompanyTier('TH')).toThrow(CompanyTierError);
    // ...but the message now states the way through, rather than being a dead end.
    expect(() => resolveCompanyTier('TH')).toThrow(/NON-STATUTORY/);
  });

  it('a packless country DECLARED non-statutory is allowed', () => {
    expect(resolveCompanyTier('TH', true)).toBe(NON_STATUTORY);
  });

  it('never infers a tier from a typo — ZZ behaves exactly like TH', () => {
    // This is why the declaration is required rather than inferred: isoCode is a shape check, so a
    // mis-keyed country is indistinguishable from a deliberate one WITHOUT the declaration.
    expect(() => resolveCompanyTier('ZZ')).toThrow(CompanyTierError);
    expect(resolveCompanyTier('ZZ', true)).toBe(NON_STATUTORY);
  });

  it('has no fallback branch — every input either resolves or throws', () => {
    for (const c of [null, undefined, '', '  ']) {
      expect(() => resolveCompanyTier(c)).toThrow(CompanyTierError);
      expect(resolveCompanyTier(c, true)).toBe(NON_STATUTORY);
    }
  });

  it('the tier vocabulary is exactly two values, matching the CHECK constraint', () => {
    expect([...COMPANY_TIERS]).toEqual(['statutory', 'non_statutory']);
    expect(isCompanyTier('statutory')).toBe(true);
    expect(isCompanyTier('non_statutory')).toBe(true);
    expect(isCompanyTier('none')).toBe(false);
    // The migration's CHECK must admit precisely these, or the column and the code disagree.
    const sql = readFileSync('db/migrations/0346_company_statutory_tier.sql', 'utf8');
    for (const t of COMPANY_TIERS) expect(sql).toContain(`'${t}'`);
  });
});

describe('assertStatutory', () => {
  it('passes a statutory company through', () => {
    expect(() => assertStatutory(STATUTORY, 'Payroll', 'Acme')).not.toThrow();
  });

  it('refuses a non-statutory company and names both the operation and the company', () => {
    expect(() => assertStatutory(NON_STATUTORY, 'Payroll', 'Bangkok Plant')).toThrow(/Payroll/);
    expect(() => assertStatutory(NON_STATUTORY, 'Payroll', 'Bangkok Plant')).toThrow(/Bangkok Plant/);
  });

  it('refuses an unknown or missing tier rather than treating it as statutory', () => {
    // Fail closed: a row that somehow escaped the CHECK constraint must not compute statutory payroll.
    for (const t of [null, undefined, '', 'whatever']) {
      expect(() => assertStatutory(t, 'Payroll')).toThrow(CompanyTierError);
    }
  });
});

describe('the old blanket guard is gone', () => {
  it('createCompany no longer calls requirePackFor', () => {
    const src = readFileSync('core/admin.ts', 'utf8');
    expect(src).not.toMatch(/^\s*requirePackFor\(country\);/m);
    expect(src).toMatch(/resolveCompanyTier\(country, p\.nonStatutory === true\)/);
  });

  it('payroll refuses by TIER, and does so before the pack lookup', () => {
    const src = readFileSync('core/payroll.ts', 'utf8');
    const assertAt = src.indexOf('assertStatutory(batch.statutoryTier');
    const packAt = src.indexOf('const pack = packFor(batch.country)');
    expect(assertAt).toBeGreaterThan(-1);
    // Order matters for the MESSAGE: "no localization pack for TH" reads as a bug to fix; "this is a
    // non-statutory company" reads as the deliberate arrangement it is.
    expect(assertAt).toBeLessThan(packAt);
  });
});

describe('against the real database', () => {
  let b: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const tierOf = async (id: string) => {
    const [row] = await owner.db
      .select({ tier: schema.company.statutoryTier })
      .from(schema.company)
      .where(eq(schema.company.id, id));
    return row?.tier;
  };

  it('every seeded company defaults to statutory — the backfill is byte-identical to today', async () => {
    expect(await tierOf(b.companyId)).toBe(STATUTORY);
  });

  it('creates a MY company as statutory', async () => {
    const { id } = await createCompany(adminCtx(b), { legalName: 'Acme MY', country: 'MY' });
    expect(await tierOf(id)).toBe(STATUTORY);
  });

  it('refuses an undeclared packless company, exactly as before D-14', async () => {
    await expect(createCompany(adminCtx(b), { legalName: 'Bangkok', country: 'TH' })).rejects.toThrow(
      /No country pack registered/,
    );
  });

  it('creates a DECLARED non-statutory company — the Thai plant onboards', async () => {
    const { id } = await createCompany(adminCtx(b), {
      legalName: 'Bangkok Plant',
      country: 'TH',
      nonStatutory: true,
    });
    expect(await tierOf(id)).toBe(NON_STATUTORY);
  });

  it('refuses to declare a MY company non-statutory, even through the real create path', async () => {
    await expect(
      createCompany(adminCtx(b), { legalName: 'Sneaky', country: 'MY', nonStatutory: true }),
    ).rejects.toThrow(/cannot be declared/i);
  });

  it('the DB CHECK constraint refuses a tier the code would never write', async () => {
    // Belt and braces: the code is one writer, and a direct UPDATE is the other. Asserted against the
    // owner connection so RLS is not what is being tested.
    await expect(
      owner.db.update(schema.company).set({ statutoryTier: 'sort-of' }).where(eq(schema.company.id, b.companyId)),
    ).rejects.toThrow();
  });

  describe('moving a company between countries re-derives the tier', () => {
    it('promotes a non-statutory company to statutory when moved somewhere we model', async () => {
      const { id } = await createCompany(adminCtx(b), {
        legalName: 'Bangkok Plant',
        country: 'TH',
        nonStatutory: true,
      });
      expect(await tierOf(id)).toBe(NON_STATUTORY);

      await updateCompany(adminCtx(b), { id, legalName: 'Bangkok Plant', country: 'MY' });
      // The tier follows the jurisdiction, never the other way round — a company in Malaysia is
      // statutory whatever it used to be.
      expect(await tierOf(id)).toBe(STATUTORY);
    });

    it('carries the declaration forward between packless countries without re-declaring', async () => {
      const { id } = await createCompany(adminCtx(b), { legalName: 'Plant', country: 'TH', nonStatutory: true });
      await updateCompany(adminCtx(b), { id, legalName: 'Plant', country: 'VN' });
      expect(await tierOf(id)).toBe(NON_STATUTORY);
    });

    it('still refuses moving a STATUTORY company into a packless country undeclared', async () => {
      const { id } = await createCompany(adminCtx(b), { legalName: 'Acme MY', country: 'MY' });
      await expect(updateCompany(adminCtx(b), { id, legalName: 'Acme MY', country: 'TH' })).rejects.toThrow(
        /No country pack registered/,
      );
      expect(await tierOf(id)).toBe(STATUTORY);
    });

    it('leaves the tier alone on a save that does not change the country', async () => {
      const { id } = await createCompany(adminCtx(b), { legalName: 'Plant', country: 'TH', nonStatutory: true });
      // An unrelated edit must not re-litigate the tier — that would refuse a phone-number change.
      await updateCompany(adminCtx(b), { id, legalName: 'Plant Renamed', country: 'TH', phone: '012-3456789' });
      expect(await tierOf(id)).toBe(NON_STATUTORY);
    });
  });
});
