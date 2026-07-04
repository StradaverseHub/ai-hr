/**
 * EPF per-section edit — merge-preservation regression (feedback: statutory-config per-section edit).
 *
 * The Statutory Configuration page now exposes a per-section inline Edit control for EPF that publishes a
 * scalar override through setStatutoryComponentAction. EPF is NOT scalar-only: StatutoryRuleset.epf also
 * carries partA / partE band tables and scheduleMax / seniorEmployerRate / nonCitizen* fields. The action's
 * EPF branch stays safe only because it spread-merges the four visible scalar rates onto the currently
 * active EPF slice (`...current.epf`), preserving those band/non-citizen fields. This test locks that
 * behaviour: a scalar-only EPF edit must change the four rates AND keep partA/partE/nonCitizen* intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../db/client';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { getActiveStatutoryResolvedMY } from '../localization/my/statutory-config';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// The action pulls the session and the Next.js cache/navigation helpers. Mock only that infra; the real
// MY pack + real DB run so the action's actual EPF merge code is exercised.
let currentBase: Base;
vi.mock('../lib/session', () => ({
  getSession: async () => adminCtx(currentBase),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  // redirect() throws in Next so control flow stops; mirror that so the action returns after the write.
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));

// Imported after the mocks are registered.
const { setStatutoryComponentAction } = await import('../app/payroll/configuration/actions');

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('EPF per-section edit preserves band / non-citizen fields through the scalar merge', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    currentBase = base;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('overrides the four scalar rates but keeps partA/partE/scheduleMax/seniorEmployerRate/nonCitizen*', async () => {
    // Sanity: the baseline EPF slice carries the band + non-citizen data we must not lose.
    expect(DEFAULT_MY_STATUTORY.epf.partA).toBeDefined();
    expect(DEFAULT_MY_STATUTORY.epf.partE).toBeDefined();
    expect(DEFAULT_MY_STATUTORY.epf.nonCitizenEmployeeRate).toBeDefined();

    // Drive the real action with a scalar-only EPF edit (what the inline per-section form submits).
    await expect(
      setStatutoryComponentAction(
        fd({
          body: 'epf',
          version: 'epf-2027.01',
          effectiveFrom: '2027-01-01',
          notes: 'Budget 2027 rate tweak',
          employeeRate: '0.09',
          employerRateLow: '0.13',
          employerRateHigh: '0.12',
          employerThreshold: '5500',
        }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT'); // the success redirect

    // Resolve the ruleset on/after the effective date and inspect the overridden EPF slice.
    const after = await withTenant(adminCtx(base), (tx) =>
      getActiveStatutoryResolvedMY(tx, { asOf: '2027-01-31' }),
    );
    expect(after.components.epf.source).toBe('component');
    expect(after.components.epf.version).toBe('epf-2027.01');

    const epf = after.ruleset.epf;
    // The four visible scalars took the edited values.
    expect(epf.employeeRate).toBe(0.09);
    expect(epf.employerRateLow).toBe(0.13);
    expect(epf.employerRateHigh).toBe(0.12);
    expect(epf.employerThreshold).toBe(5500);
    // The band + non-citizen fields survived the merge untouched (the regression this guards).
    expect(epf.partA).toEqual(DEFAULT_MY_STATUTORY.epf.partA);
    expect(epf.partE).toEqual(DEFAULT_MY_STATUTORY.epf.partE);
    expect(epf.scheduleMax).toBe(DEFAULT_MY_STATUTORY.epf.scheduleMax);
    expect(epf.seniorEmployerRate).toBe(DEFAULT_MY_STATUTORY.epf.seniorEmployerRate);
    expect(epf.nonCitizenEmployeeRate).toBe(DEFAULT_MY_STATUTORY.epf.nonCitizenEmployeeRate);
    expect(epf.nonCitizenEmployerRate).toBe(DEFAULT_MY_STATUTORY.epf.nonCitizenEmployerRate);
  });
});
