/**
 * Overtime configuration relocation (#e776d17d).
 *
 * Overtime rates (the `ot` statutory ruleset slice: wageCeiling + the two excess multipliers) are no
 * longer edited under Payroll > Statutory Configuration (Malaysia); the editing surface moved to the
 * Attendance Policy screen (/admin/attendance). CRUCIALLY, the DATA and the WRITE PATH did not move:
 * the relocated form still submits to the SAME setStatutoryComponentAction (body 'ot') ->
 * setComponentOverrideMY, so payroll resolves a byte-identical ruleset.ot. Only the redirect/revalidate
 * TARGET differs, via a new same-origin-only `returnTo` field.
 *
 * Guards:
 *  - Relocation: saving OT with returnTo=/admin/attendance redirects AND revalidates the attendance
 *    path, NOT the payroll page (the whole point of the move).
 *  - Backward compat: without returnTo, the action still redirects/revalidates /payroll/configuration.
 *  - Open-redirect guard: a hostile returnTo (absolute URL, protocol-relative, path traversal, query
 *    injection) is rejected and falls back to the payroll base — it can never send the admin off-site.
 *  - Integrity (the reporter's "payroll keeps consuming the same value"): the ruleset.ot resolved after
 *    saving via the attendance form's action equals exactly what was submitted — same wageCeiling and
 *    both excess multipliers — with the statutory.component.updated provenance event intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The action calls getSession() + revalidatePath() + redirect(). redirect() in real Next.js THROWS to
// abort the request; the mock must throw too, or execution falls through into the success redirect and
// fires twice. We throw a sentinel carrying the target path so tests can assert the redirect TARGET.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
const revalidateSpy = vi.fn((_path: string) => undefined);
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateSpy(p), revalidateTag: vi.fn(() => undefined) }));

/** Run a server action that ends in redirect() (now throws RedirectError) and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { getActiveStatutoryMY } from '../localization/my/statutory-config';
import { setStatutoryComponentAction } from '../app/payroll/configuration/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** Count DomainEvents of a given type for a tenant (used to pin the override provenance is intact). */
async function eventCountByType(tenantId: string, eventType: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.domainEvent.id })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), eq(schema.domainEvent.eventType, eventType)));
  return rows.length;
}

const PAYROLL_BASE = '/payroll/configuration';
const ATTENDANCE = '/admin/attendance';

/** Build the FormData the relocated OT-rates form posts (StatutoryComponentForm lockedBody="ot"). */
function otFormData(opts: {
  wageCeiling: number;
  restMult?: number;
  holidayMult?: number;
  version: string;
  effectiveFrom: string;
  returnTo?: string;
}): FormData {
  const fd = new FormData();
  fd.set('body', 'ot');
  fd.set('version', opts.version);
  fd.set('effectiveFrom', opts.effectiveFrom);
  fd.set('wageCeiling', String(opts.wageCeiling));
  if (opts.restMult != null) fd.set('restDayExcessMultiplier', String(opts.restMult));
  if (opts.holidayMult != null) fd.set('holidayExcessMultiplier', String(opts.holidayMult));
  if (opts.returnTo != null) fd.set('returnTo', opts.returnTo);
  return fd;
}

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
  actionCtx = null;
  redirectSpy.mockClear();
  revalidateSpy.mockClear();
});

describe('Overtime config relocation — the OT editor moved to Attendance, keeping one write path', () => {
  it('saving OT with returnTo=/admin/attendance redirects AND revalidates Attendance, not Payroll', async () => {
    actionCtx = adminCtx(b);
    const target = await captureRedirect(() =>
      setStatutoryComponentAction(
        otFormData({ wageCeiling: 4000, version: 'ot-attend', effectiveFrom: '2026-06-01', returnTo: ATTENDANCE }),
      ),
    );
    expect(target.startsWith(`${ATTENDANCE}?`)).toBe(true);
    expect(target).not.toContain(PAYROLL_BASE);
    expect(revalidateSpy).toHaveBeenCalledWith(ATTENDANCE);
    expect(revalidateSpy).not.toHaveBeenCalledWith(PAYROLL_BASE);
  });

  it('without returnTo, the action still targets /payroll/configuration (backward compatible)', async () => {
    actionCtx = adminCtx(b);
    const target = await captureRedirect(() =>
      setStatutoryComponentAction(otFormData({ wageCeiling: 4000, version: 'ot-legacy', effectiveFrom: '2026-06-01' })),
    );
    expect(target.startsWith(`${PAYROLL_BASE}?`)).toBe(true);
    expect(revalidateSpy).toHaveBeenCalledWith(PAYROLL_BASE);
  });

  it('a hostile returnTo can never redirect off-site — it falls back to the payroll base', async () => {
    const hostile = [
      'https://evil.example.com',
      '//evil.example.com',
      '/admin/attendance?x=1', // query injection: the regex forbids '?', so this is rejected too
      'javascript:alert(1)',
      '/../../etc/passwd\n',
    ];
    for (const returnTo of hostile) {
      actionCtx = adminCtx(b);
      revalidateSpy.mockClear();
      const target = await captureRedirect(() =>
        setStatutoryComponentAction(
          otFormData({ wageCeiling: 4000, version: `ot-${Math.random().toString(36).slice(2, 8)}`, effectiveFrom: '2026-06-01', returnTo }),
        ),
      );
      expect(target.startsWith(`${PAYROLL_BASE}?`)).toBe(true);
      expect(target).not.toContain('evil.example.com');
      expect(target).not.toContain('javascript:');
      expect(revalidateSpy).toHaveBeenCalledWith(PAYROLL_BASE);
    }
  });

  it('payroll consumes the SAME value: ruleset.ot after the attendance-form save equals what was submitted', async () => {
    actionCtx = adminCtx(b);
    await captureRedirect(() =>
      setStatutoryComponentAction(
        otFormData({
          wageCeiling: 4500,
          restMult: 2.5,
          holidayMult: 3.5,
          version: 'ot-relocated',
          effectiveFrom: '2026-06-01',
          returnTo: ATTENDANCE,
        }),
      ),
    );

    // Resolve exactly the way the payroll engine + statutory page read it.
    const resolved = await withTenant(adminCtx(b), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-30' }));
    expect(resolved.ot.wageCeiling).toBe(4500);
    expect(resolved.ot.restDayExcessMultiplier).toBe(2.5);
    expect(resolved.ot.holidayExcessMultiplier).toBe(3.5);

    // Provenance/event unchanged — the substrate still records the per-body override the same way it did
    // when the editor lived on the payroll page (setComponentOverrideMY logs statutory.component.updated).
    expect(await eventCountByType(b.tenantId, 'statutory.component.updated')).toBe(1);
  });
});
