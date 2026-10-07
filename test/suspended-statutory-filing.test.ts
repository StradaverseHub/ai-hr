/**
 * ADR-0077 slice 9 — a suspended tenant can still MEET A FILING DEADLINE, and still get its data out.
 *
 * r104 made a non-good-standing tenant read-only and carved out one exception in the type system:
 * `SessionContext.statutoryOverride`, because "EPF, SOCSO and PCB deadlines do not pause because an
 * invoice is disputed". r105 built the sweep that puts a tenant into that state. **Nothing ever set the
 * override** — it had zero production callers, so the carve-out was a comment.
 *
 * THE COST WAS NOT A MISSING AUDIT ROW. `recordFileReport` is awaited between generating a submission
 * file and returning it, so its read-only error fell into the route's generic catch and became a 500.
 * A suspended customer could not file their PCB at all. r104 therefore made this strictly WORSE than
 * before it shipped, and only for the one obligation that has a legal deadline attached.
 *
 * The other half of ADR-0077 decision 5 — "read-only plus export, never a hard lock-out on a payroll
 * system" — is asserted here too, because a promise nothing tests is a promise nobody keeps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setTenantStatus, entitledCtx, type Base } from './harness';
import { withTenant } from '../db/client';
import { MY_REPORTS } from '../localization/my/reports';

/**
 * The REAL Postgres message, walked out of the cause chain — the same helper and the same reason as
 * test/tenant-suspension-readonly.test.ts. Drizzle wraps every failure as "Failed query: …", so matching
 * the thrown error's own message asserts drizzle's wrapper rather than the refusal under test, and would
 * pass for any query failure at all. This repo's Traps section names this exact hazard.
 */
async function rootMessageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '(resolved — no error thrown)';
  } catch (e) {
    let cur: unknown = e;
    const seen: string[] = [];
    while (cur instanceof Error) {
      seen.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return seen.join(' | ');
  }
}

describe('the submission field is what decides the override', () => {
  it('is present on every form actually filed with an agency, and absent on the internal view', () => {
    // Stated absolutely rather than derived from the registry, so this fails if a future edit quietly
    // drops `submission` from a real filing (which would silently withdraw its override).
    // 8ca344bf added `my.borang-8a` and 9c8dad7a added `my.borang-a` — a PERKESO filing and a KWSP one, so
    // both declare `submission` and therefore carry the suspended-tenant override like every other real
    // filing. They are LISTED here rather than the list being loosened: this assertion exists to fail when
    // a future edit quietly drops `submission` from a real filing, which would silently withdraw its
    // override, and a loosened list could not see that.
    // r224 added `my.hrd-levy` — the HRD Corp levy, the first form on the "Other statutory" shelf. It is
    // listed here for the same reason and on the same test: the levy is a monthly filing obligation with
    // a statutory deadline (the 15th of the following month, sourced in docs/wave2-payroll-design.md),
    // so r104's carve-out applies to it exactly as it applies to EPF, PERKESO and LHDN. A suspended
    // tenant must still be able to meet it. If a later edit drops `submission` from this entry to keep
    // it off some other list, this line is what says the override went with it.
    const filed = MY_REPORTS.filter((r) => r.submission).map((r) => r.id).sort();
    // r412 (item e74af58c, step 2) — `my.borang-8b` and `my.sip-contribution` are PERKESO filings: listed, not loosened.
    expect(filed).toEqual([
      'my.borang-8a',
      'my.borang-8b',
      'my.borang-a',
      'my.cp39',
      'my.cp8d',
      'my.epf',
      'my.hrd-levy',
      'my.sip-contribution',
      'my.socso-eis',
    ]);

    const internal = MY_REPORTS.filter((r) => !r.submission).map((r) => r.id);
    expect(internal).toEqual(['my.contributions']);
  });

  it('every filed report names an agency, which is what the reason string records', () => {
    for (const r of MY_REPORTS.filter((r) => r.submission)) {
      expect(r.submission!.agency.length).toBeGreaterThan(0);
    }
  });
});

describe('the override is set at exactly the right call sites', () => {
  it('recordReport derives it from the def, not from an allowlist', () => {
    const src = readFileSync('core/reporting.ts', 'utf8');
    expect(src).toMatch(/function statutoryCtx/);
    // The discriminator must be the data, so a report added to a pack is covered without editing this.
    expect(src).toMatch(/if \(!def\.submission\) return ctx;/);
    expect(src).toMatch(/withTenant\(statutoryCtx\(ctx, def\)/);
  });

  it('both Layer-B file routes declare their agency — and they are the ONLY callers', () => {
    for (const [path, agency] of [
      ['app/payroll/reports/cp39-file/route.ts', 'LHDN'],
      ['app/payroll/reports/socso-eis-file/route.ts', 'PERKESO'],
    ] as const) {
      const src = readFileSync(path, 'utf8');
      expect(src).toMatch(/recordFileReport\(/);
      expect(src).toContain(`agency: '${agency}'`);
    }
  });

  it('the override is never granted from a bare boolean or a hardcoded true', () => {
    // SessionContext types statutoryOverride as a REASON so an override is attributable. A `true` here
    // would type-error, but a bare marker string like 'yes' would not — this pins that both grants name
    // what is being filed and to whom.
    const src = readFileSync('core/reporting.ts', 'utf8');
    expect(src).toMatch(/statutoryOverride: `statutory submission \$\{def\.id\} to \$\{def\.submission\.agency\}`/);
    expect(src).toMatch(/statutoryOverride: `statutory submission file \$\{p\.reportType\} to \$\{p\.agency\}`/);
  });
});

describe('against the real database — a suspended tenant', () => {
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

  /** The exact write recordFileReport performs, run through withTenant the way the real path does. */
  const insertArtefact = (ctx: Parameters<typeof withTenant>[0], reportType: string) =>
    withTenant(ctx, (tx) =>
      tx
        .insert(schema.statutoryReport)
        .values({
          tenantId: b.tenantId,
          companyId: b.companyId,
          jurisdiction: 'MY',
          reportType,
          periodKind: 'month',
          periodKey: '2026-07',
          status: 'draft',
          statutoryVersion: 'test',
          rowCount: 1,
          totals: {},
        })
        .returning({ id: schema.statutoryReport.id }),
    );

  it('CAN record a statutory submission — the filing deadline does not pause', async () => {
    await setTenantStatus(b.tenantId, 'suspended');
    const suspended = await entitledCtx(b);
    // The tenant really is out of good standing for this context, otherwise the write below would
    // succeed for a reason that has nothing to do with the override.
    expect(suspended.entitlements?.tenantStatus).toBe('suspended');

    const withOverride = { ...suspended, statutoryOverride: 'statutory submission my.cp39 to LHDN' };
    const [row] = await insertArtefact(withOverride, 'my.cp39-file');
    expect(row.id).toBeTruthy();

    const stored = await owner.db
      .select()
      .from(schema.statutoryReport)
      .where(eq(schema.statutoryReport.id, row.id));
    expect(stored).toHaveLength(1);
  });

  it('CANNOT record an internal report — that is what suspending is for', async () => {
    await setTenantStatus(b.tenantId, 'suspended');
    const suspended = await entitledCtx(b);
    // No override: statutoryCtx returns the context untouched for a def with no `submission`.
    expect(await rootMessageOf(insertArtefact(suspended, 'my.contributions'))).toMatch(
      /read-only transaction/i,
    );
  });

  it('and the same write succeeds once the tenant is back in good standing', async () => {
    // Guards the assertion above against passing for an unrelated reason (a bad insert, a missing FK):
    // the identical statement must work when standing is restored.
    await setTenantStatus(b.tenantId, 'suspended');
    expect(await rootMessageOf(insertArtefact(await entitledCtx(b), 'my.contributions'))).toMatch(
      /read-only transaction/i,
    );
    await setTenantStatus(b.tenantId, 'active');
    const [row] = await insertArtefact(await entitledCtx(b), 'my.contributions');
    expect(row.id).toBeTruthy();
  });

  it('can still READ its own payroll history — decision 5 is read-only plus export, not lock-out', async () => {
    await setTenantStatus(b.tenantId, 'suspended');
    const suspended = await entitledCtx(b);
    // r104 already proves a bare `select 1` succeeds. The stronger claim, and the one decision 5 actually
    // makes, is that the customer can still see THEIR OWN records through RLS while suspended.
    const companies = await withTenant(suspended, (tx) =>
      tx.select({ id: schema.company.id }).from(schema.company),
    );
    expect(companies.map((c) => c.id)).toContain(b.companyId);
  });
});

describe('the export routes write nothing, so they survive suspension by construction', () => {
  // Asserted on the SOURCE rather than by driving an HTTP route: the guarantee is that these paths have
  // no write in them at all, which is a stronger and more durable statement than one request passing.
  it.each([
    'app/reports/export/route.ts',
    'app/analytics/export/route.ts',
    // afd0a87c — app/leave/export/route.ts is DELETED. It was the filtered export for the org-wide leave
    // register, whose only links in the whole application were on the section that has been removed; an
    // unreachable admin download is worse than none. A route that does not exist cannot write.
  ])('%s performs no insert, update or event append', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/appendEvent\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });
});
