/**
 * Per-body statutory versioning (ADR-0037, #6) — the overlay.
 *
 * The headline safety property mirrors ADR-0019: with NO component overrides the resolver returns the
 * bundled baseline UNTOUCHED (by reference), so payroll stays byte-identical. On top of that, a single
 * body (e.g. SOCSO) can be overridden on its own effective date without disturbing the others, and HRDF
 * — previously hardcoded — now versions through the same overlay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { hrdfLevy } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import {
  archiveComponentOverrideMY,
  getActiveStatutoryMY,
  getActiveStatutoryResolvedMY,
  listComponentOverridesMY,
  setComponentOverrideMY,
  StatutoryRulesetInvalidError,
} from '../localization/my/statutory-config';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const resolved = (base: Base, asOf: string) =>
  withTenant(adminCtx(base), (tx) => getActiveStatutoryResolvedMY(tx, { asOf }));

describe('ADR-0037 — per-body statutory overlay', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('no components ⇒ the baseline is returned by reference (byte-identical) with all-default provenance', async () => {
    const r = await resolved(base, '2026-06-30');
    // The ruleset is the shared default singleton — unchanged, so payroll stays byte-identical.
    const loaded = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-30' }));
    expect(loaded).toBe(DEFAULT_MY_STATUTORY);
    expect(r.components.epf.source).toBe('default');
    expect(r.components.socso.source).toBe('default');
    expect(r.components.hrdf.version).toBe(DEFAULT_MY_STATUTORY.version);
  });

  it('a SOCSO-only override applies to SOCSO alone; EPF/PCB/EIS stay the baseline (by reference)', async () => {
    const socso = clone(DEFAULT_MY_STATUTORY.socso);
    socso.verifiedUpTo = 7777; // a sentinel to prove the slice was swapped in
    await setComponentOverrideMY(adminCtx(base), {
      body: 'socso',
      version: 'socso-2026.06',
      effectiveFrom: '2026-06-01',
      data: socso,
    });

    // Before the effective date: baseline SOCSO.
    const before = await resolved(base, '2026-05-31');
    expect(before.ruleset.socso.verifiedUpTo).toBe(DEFAULT_MY_STATUTORY.socso.verifiedUpTo);
    expect(before.components.socso.source).toBe('default');

    // On/after it: the overridden SOCSO, but EPF/PCB/EIS are still the baseline slices unchanged.
    const after = await resolved(base, '2026-06-30');
    expect(after.ruleset.socso.verifiedUpTo).toBe(7777);
    expect(after.components.socso.source).toBe('component');
    expect(after.components.socso.version).toBe('socso-2026.06');
    expect(after.ruleset.epf).toEqual(DEFAULT_MY_STATUTORY.epf);
    expect(after.ruleset.pcb).toEqual(DEFAULT_MY_STATUTORY.pcb);
    expect(after.components.epf.source).toBe('default');
  });

  it('bodies version on independent effective dates', async () => {
    const epf = clone(DEFAULT_MY_STATUTORY.epf);
    epf.employerThreshold = 5500;
    const socso = clone(DEFAULT_MY_STATUTORY.socso);
    socso.verifiedUpTo = 9000;
    await setComponentOverrideMY(adminCtx(base), { body: 'epf', version: 'epf-2026.03', effectiveFrom: '2026-03-01', data: epf });
    await setComponentOverrideMY(adminCtx(base), { body: 'socso', version: 'socso-2026.06', effectiveFrom: '2026-06-01', data: socso });

    // April: EPF override is live, SOCSO is not yet.
    const apr = await resolved(base, '2026-04-15');
    expect(apr.ruleset.epf.employerThreshold).toBe(5500);
    expect(apr.components.epf.source).toBe('component');
    expect(apr.ruleset.socso.verifiedUpTo).toBe(DEFAULT_MY_STATUTORY.socso.verifiedUpTo);
    expect(apr.components.socso.source).toBe('default');

    // July: both live.
    const jul = await resolved(base, '2026-07-15');
    expect(jul.ruleset.epf.employerThreshold).toBe(5500);
    expect(jul.ruleset.socso.verifiedUpTo).toBe(9000);
  });

  it('newest-effective component per body wins, and archived rows are ignored', async () => {
    const mk = (v: number) => {
      const o = clone(DEFAULT_MY_STATUTORY.ot);
      o.wageCeiling = v;
      return o;
    };
    await setComponentOverrideMY(adminCtx(base), { body: 'ot', version: 'ot-a', effectiveFrom: '2026-01-01', data: mk(4100) });
    const second = await setComponentOverrideMY(adminCtx(base), { body: 'ot', version: 'ot-b', effectiveFrom: '2026-05-01', data: mk(4200) });

    expect((await resolved(base, '2026-06-01')).ruleset.ot.wageCeiling).toBe(4200); // newest effective wins
    await archiveComponentOverrideMY(adminCtx(base), second.id);
    expect((await resolved(base, '2026-06-01')).ruleset.ot.wageCeiling).toBe(4100); // falls back to the earlier one
  });

  it('HRDF becomes a versioned body — the levy reads the overridden rates', async () => {
    // Built-in: mandatory 1% ⇒ RM10 on RM1000.
    expect(hrdfLevy(1000, 'mandatory')).toBe(10);
    await setComponentOverrideMY(adminCtx(base), {
      body: 'hrdf',
      version: 'hrdf-2026.06',
      effectiveFrom: '2026-06-01',
      data: { mandatoryRate: 0.02, optionalRate: 0.01 },
    });
    const r = await resolved(base, '2026-06-30');
    expect(r.ruleset.hrdf).toEqual({ mandatoryRate: 0.02, optionalRate: 0.01 });
    expect(r.components.hrdf.source).toBe('component');
    // The calculator honours the overridden rate: 2% of RM1000 = RM20.
    expect(hrdfLevy(1000, 'mandatory', r.ruleset.hrdf)).toBe(20);
  });

  it('validates the slice, logs an event, lists history, and blocks non-admins (RLS)', async () => {
    // Bad EPF rate is rejected before storage.
    await expect(
      setComponentOverrideMY(adminCtx(base), {
        body: 'epf',
        version: 'bad',
        effectiveFrom: '2026-01-01',
        data: { ...DEFAULT_MY_STATUTORY.epf, employeeRate: 2 },
      }),
    ).rejects.toBeInstanceOf(StatutoryRulesetInvalidError);

    const { id } = await setComponentOverrideMY(adminCtx(base), {
      body: 'hrdf',
      version: 'hrdf-x',
      effectiveFrom: '2026-06-01',
      data: { mandatoryRate: 0.015, optionalRate: 0.005 },
    });
    expect(await eventTypesFor(base.tenantId, id)).toContain('statutory.component.updated');
    expect((await listComponentOverridesMY(adminCtx(base))).map((r) => r.version)).toContain('hrdf-x');

    const employeeCtx = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] };
    await expect(
      setComponentOverrideMY(employeeCtx, {
        body: 'hrdf',
        version: 'sneaky',
        effectiveFrom: '2026-06-01',
        data: { mandatoryRate: 0.01, optionalRate: 0.005 },
      }),
    ).rejects.toThrow();
  });
});
