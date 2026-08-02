/**
 * ADR-0077 slice 9 — a suspended tenant is READ-ONLY, mechanically.
 *
 * THE GAP THIS CLOSES was documented in the code against itself: "Until slice 9 lands, a closed tenant
 * retains write access to core." `isModuleEnabled` already returned false for a tenant out of good
 * standing, so BILLABLE modules refused — but CORE modules (leave, ESS, employees, org) answer true from
 * the pack catalog without consulting the snapshot. A suspended customer could still file leave and edit
 * employees.
 *
 * IT IS A MECHANISM, NOT A DISCIPLINE. `withTenant` issues SET TRANSACTION READ ONLY and Postgres
 * refuses every write. Doing it per action would mean auditing several hundred call sites and
 * re-auditing every new one forever; one line binds all of them, including code not yet written. These
 * assertions therefore go through the REAL transaction wrapper rather than a mocked one — the whole
 * claim is that the database enforces it.
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { closeAll, migrateTestDb, resetDb, seedBase, adminCtx, type Base } from './harness';

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

/** The admin context, with a tenant status stamped onto its snapshot. */
function ctxWithStatus(status: string | undefined, override?: string): SessionContext {
  const base = adminCtx(b) as SessionContext;
  if (status === undefined) return { ...base, entitlements: undefined, statutoryOverride: override };
  return {
    ...base,
    entitlements: { ...(base.entitlements ?? ({} as never)), tenantStatus: status } as never,
    statutoryOverride: override,
  };
}

// A UNIQUE name per call: a temp table lives for the CONNECTION, not the transaction, and the pool
// reuses connections — a fixed name makes the second test in a worker fail with "already exists"
// instead of testing anything.
const write = (ctx: SessionContext) => {
  const name = `probe_${randomUUID().replace(/-/g, '')}`;
  return withTenant(ctx, (tx) => tx.execute(sql.raw(`create temp table ${name} (a int)`)));
};
const read = (ctx: SessionContext) => withTenant(ctx, (tx) => tx.execute(sql`select 1 as ok`));

/**
 * The REAL Postgres message, walked out of the cause chain. Drizzle wraps every failure as
 * "Failed query: …", so matching on the thrown error's own message asserts drizzle's wrapper rather
 * than the refusal under test — a test that would pass for any query failure at all. This repo's Traps
 * section names this exact hazard.
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

describe('a tenant in good standing is unaffected', () => {
  it.each(['active', 'trial'])('status %s can still write', async (status) => {
    await expect(write(ctxWithStatus(status))).resolves.toBeTruthy();
  });
});

describe('a tenant OUT of good standing is read-only', () => {
  it.each(['suspended', 'closed', 'past_due'])('status %s cannot write', async (status) => {
    // Asserted against the ROOT cause, so this cannot pass on some unrelated query failure.
    expect(await rootMessageOf(write(ctxWithStatus(status)))).toMatch(/read-only transaction/i);
  });

  /**
   * ADR-0077 open decision 5: read-only + export, NEVER a hard lock-out on a payroll system. A customer
   * in a billing dispute must still be able to see and export their own payroll history.
   */
  it.each(['suspended', 'closed'])('status %s can still READ', async (status) => {
    await expect(read(ctxWithStatus(status))).resolves.toBeTruthy();
  });
});

describe('the statutory override is the one way through, and it is narrow', () => {
  // EPF/SOCSO/PCB deadlines do not pause because an invoice is disputed, and a half-finished statutory
  // month is worse for the EMPLOYEE than for the customer who stopped paying.
  it('lets a declared statutory obligation write while suspended', async () => {
    await expect(write(ctxWithStatus('suspended', 'finalise the started EPF month'))).resolves.toBeTruthy();
  });

  // A string, not a boolean: an override should be attributable in review, not anonymous.
  it('is typed as a REASON, so an override cannot be silent', () => {
    const ctx = ctxWithStatus('suspended', 'why');
    expect(typeof ctx.statutoryOverride).toBe('string');
  });
});

describe('missing data is not suspension', () => {
  /**
   * The failure mode that would be far worse than the gap being closed: inferring suspension from an
   * unresolved snapshot would turn any resolver outage into a tenant-wide write outage. Unresolved is
   * the entitlement gates' problem, and they fail closed there.
   */
  it('a context with no snapshot still writes', async () => {
    await expect(write(ctxWithStatus(undefined))).resolves.toBeTruthy();
  });
});
