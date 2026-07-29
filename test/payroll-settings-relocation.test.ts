/**
 * r79a — Payroll Settings consolidation (feedback 4fb8b75a steps 1–4) + payroll-cycle readiness (707b3851).
 *
 * What each block pins, and what it would have caught BEFORE the change:
 *
 * 1. SCHEMA (steps 2–3, migration 0324). company_payroll_config no longer carries payment_basis,
 *    probation_months, review_reminder_days or default_currency, and `company` carries the two relocated
 *    columns. Red before: all four columns existed on the payroll table and neither column existed on
 *    `company`. Also pins the two named CHECK constraints BY NAME (not `rejects.toThrow()`, which passes
 *    on the wrong throw) — a bad probation or a reminder cadence outside 1..365 is refused by the database,
 *    not only by the service.
 *
 * 2. HIRING DEFAULTS SERVICE (step 3). The cleaners that moved out of core/payroll-config.ts behave
 *    identically at their new address, and every write is audited before→after. Red before: the service
 *    did not exist.
 *
 * 3. STATUTORY, ONE OWNER (step 4). The payroll-config save path no longer writes company_statutory_my,
 *    and the payroll screen renders no statutory input. This is a SOURCE-level guard on purpose: the bug
 *    was a second WRITER, and a behavioural test that only calls setPayrollConfig would pass either way
 *    (the second write lived in the server action, not the service). Red before: the action called
 *    pack.companyStatutory.set and the page rendered six statutory inputs.
 *
 * 4. CYCLE READINESS (707b3851). payrollCycleReadiness reports exactly what the run gate enforces —
 *    asserted by EQUIVALENCE against companiesMissingCycle, the same pre-flight the Process wizard uses
 *    and which shares its resolution with core/payroll-run-group.ts's INVALID_CYCLE refusal. It also
 *    separates "no cycles at all" (blocked) from "the stored default names a cycle that does not exist"
 *    (not blocked, but the field reads as configured when it is not) — the exact production shape of Chin
 *    Hin Property Group and SpaceX. Red before: neither the function nor the distinction existed.
 *
 * 5. NO AUTO-CREATION. Reading readiness for a cycle-less company creates nothing. Which cycles a company
 *    should have is a business decision, and inventing them would make a company that has never run
 *    payroll silently able to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createCompany, setCompanyDefaultPayrollCycle } from '../core/admin';
import { getHiringDefaults, setHiringDefaults } from '../core/hiring-defaults';
import { resolveProbationMonths } from '../core/org';
import { resolveReminderDays } from '../core/employment-review';
import { listPayrollCycles, setPayrollCycleActive } from '../core/payroll-cycle';
import { companiesMissingCycle } from '../core/payroll-run-group';
import { payrollCycleReadiness, payrollReadiness } from '../core/payroll-readiness';
import type { SessionContext } from '../db/client';

let b: Base;

/** A GROUP admin carrying EXPLICIT grants — companiesMissingCycle resolves companies from ctx.grants. */
function groupAdmin(): SessionContext {
  return { tenantId: b.tenantId, userId: b.adminUserId, grants: [{ role: 'hr_admin', companyId: null }] };
}

const REPO = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment EXPLAINING that a writer was removed is not a writer, and
 *  a guard that cannot tell the difference would force the explanation out of the file. */
const readSource = (rel: string) =>
  fs
    .readFileSync(path.join(REPO, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await owner.db.execute<{ column_name: string }>(
    sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`,
  );
  return new Set([...rows].map((r) => r.column_name));
}

/** The Postgres constraint name behind a Drizzle failure — the `.cause` chain carries the driver error. */
function constraintNameOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { constraint_name?: string; constraint?: string }).constraint_name
      ?? (cur as { constraint?: string }).constraint;
    if (c) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

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

describe('0324 — the four columns that left company_payroll_config', () => {
  it('drops payment_basis (dead) and the three relocated settings; company gains the two hiring columns', async () => {
    const cfgCols = await columnsOf('company_payroll_config');
    // Step 2 — nothing read payment_basis; it is gone, not merely hidden from the form.
    expect(cfgCols.has('payment_basis')).toBe(false);
    // Step 3 — moved, so gone from HERE and present at the new address.
    expect(cfgCols.has('probation_months')).toBe(false);
    expect(cfgCols.has('review_reminder_days')).toBe(false);
    expect(cfgCols.has('default_currency')).toBe(false);
    // What the screen legitimately keeps.
    expect(cfgCols.has('cut_off_day')).toBe(true);
    expect(cfgCols.has('pay_day')).toBe(true);
    expect(cfgCols.has('default_payroll_policy_id')).toBe(true);

    const companyCols = await columnsOf('company');
    expect(companyCols.has('probation_months')).toBe(true);
    expect(companyCols.has('review_reminder_days')).toBe(true);
    // The third setting collapsed into the currency column that already existed — no new column for it.
    expect(companyCols.has('currency')).toBe(true);
    expect(companyCols.has('default_currency')).toBe(false);
  });

  it('enforces the relocated settings at the DATABASE, by named constraint', async () => {
    // A non-positive probation length. Asserted by CONSTRAINT NAME, not by "it threw something".
    const badProbation = await owner.db
      .update(schema.company)
      .set({ probationMonths: 0 })
      .where(eq(schema.company.id, b.companyId))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(constraintNameOf(badProbation)).toBe('company_probation_months_check');

    // A reminder offset outside 1..365.
    const badCadence = await owner.db
      .update(schema.company)
      .set({ reviewReminderDays: [30, 400] })
      .where(eq(schema.company.id, b.companyId))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(constraintNameOf(badCadence)).toBe('company_review_reminder_days_check');

    // More than ten offsets — the "no reminder storm" cap the service applies is also a DB invariant.
    const tooMany = await owner.db
      .update(schema.company)
      .set({ reviewReminderDays: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] })
      .where(eq(schema.company.id, b.companyId))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(constraintNameOf(tooMany)).toBe('company_review_reminder_days_check');

    // The legitimate shapes still save.
    await owner.db
      .update(schema.company)
      .set({ probationMonths: 24, reviewReminderDays: [30, 14, 7] })
      .where(eq(schema.company.id, b.companyId));
  });
});

describe('hiring defaults service (the relocated settings, same behaviour)', () => {
  it('round-trips probation months, clamps <= 0 / blank to null, and keeps the default-3 resolution', async () => {
    const a = adminCtx(b);
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 6 });
    expect((await getHiringDefaults(a, b.companyId))?.probationMonths).toBe(6);

    // No arbitrary upper clamp — any positive integer is a legitimate probation length.
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 24 });
    expect((await getHiringDefaults(a, b.companyId))?.probationMonths).toBe(24);

    // <= 0 and blank ⇒ null, which resolves to the built-in 3 at compute time rather than storing junk.
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 0 });
    expect((await getHiringDefaults(a, b.companyId))?.probationMonths).toBeNull();
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: '' });
    expect((await getHiringDefaults(a, b.companyId))?.probationMonths).toBeNull();

    expect(resolveProbationMonths(null)).toBe(3);
    expect(resolveProbationMonths(0)).toBe(3);
    expect(resolveProbationMonths(6)).toBe(6);
  });

  it('round-trips the reminder cadence: sanitize, dedupe, sort desc, cap at 10; blank → null', async () => {
    const a = adminCtx(b);
    await setHiringDefaults(a, { companyId: b.companyId, reviewReminderDays: '7, 30,14, 14, 400, -3' });
    expect((await getHiringDefaults(a, b.companyId))?.reviewReminderDays).toEqual([30, 14, 7]);

    // Eleven valid offsets in, ten out — the cap that stops a typo scheduling a reminder storm, and the
    // reason the DB CHECK above can be a hard invariant rather than a hope.
    await setHiringDefaults(a, { companyId: b.companyId, reviewReminderDays: '1,2,3,4,5,6,7,8,9,10,11' });
    expect((await getHiringDefaults(a, b.companyId))?.reviewReminderDays).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);

    await setHiringDefaults(a, { companyId: b.companyId, reviewReminderDays: '' });
    expect((await getHiringDefaults(a, b.companyId))?.reviewReminderDays).toBeNull();
    expect(resolveReminderDays(null)).toEqual([30, 14, 7]);
  });

  it('audits every save with a before → after payload', async () => {
    const a = adminCtx(b);
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 6, reviewReminderDays: '14' });
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 12, reviewReminderDays: '21, 7' });

    const payload = await latestEventPayload(b.tenantId, b.companyId, 'company.hiring-defaults.set');
    expect(payload).toMatchObject({
      before: { probationMonths: 6, reviewReminderDays: [14] },
      after: { probationMonths: 12, reviewReminderDays: [21, 7] },
    });
  });

  it('keys per company — one company’s defaults never leak into another', async () => {
    const a = adminCtx(b);
    const other = await createCompany(a, { legalName: 'Second Sdn Bhd' });
    await setHiringDefaults(a, { companyId: b.companyId, probationMonths: 6 });
    expect((await getHiringDefaults(a, other.id))?.probationMonths).toBeNull();
  });
});

describe('step 4 — the company statutory block has ONE writer', () => {
  it('the payroll-config save path no longer writes company statutory', () => {
    const action = readSource('app/admin/payroll-config/actions.ts');
    // The second writer is gone. Grepping the source is the point: the duplicate write lived in the
    // server action, so a service-level test could never have seen it.
    expect(action).not.toMatch(/companyStatutory/);
    expect(action).not.toMatch(/hrdfStatus/);
    expect(action).not.toMatch(/epfEmployerNo/);
  });

  it('the payroll screen renders statutory read-only (no posted field names)', () => {
    const page = readSource('app/admin/payroll-config/page.tsx');
    // No input/select can post these back, so even a hand-crafted POST changes nothing.
    for (const field of ['hrdfStatus', 'epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'myinvoisTin', 'ssmRegistrationNo']) {
      expect(page).not.toMatch(new RegExp(`name="${field}"`));
    }
    // It still SHOWS the values, and points at the owner.
    expect(page).toMatch(/statutoryEditInOrganization/);
    expect(page).toMatch(/\/admin\/organization/);
  });

  it('step 1 — the settings hub has one card for the payroll-config screen, not three', () => {
    const hub = readSource('app/payroll/setup/page.tsx');
    const hrefs = [...hub.matchAll(/href: '(\/admin\/payroll-config)'/g)];
    expect(hrefs).toHaveLength(1);
    expect(hub).not.toMatch(/key: 'period'/);
    expect(hub).not.toMatch(/key: 'submission'/);
  });
});

describe('707b3851 — cycle readiness across companies', () => {
  it('a company with a named default but NO cycles cannot run, and says both things', async () => {
    const a = groupAdmin();
    // seedBase's company has no cycle catalog — the production shape of Chin Hin / SpaceX.
    await owner.db
      .update(schema.company)
      .set({ defaultPayrollCycle: 'Monthly' })
      .where(eq(schema.company.id, b.companyId));

    const [r] = await payrollCycleReadiness(a, [b.companyId]);
    expect(r.activeCycles).toBe(0);
    expect(r.canRunRegularPayroll).toBe(false);
    // The reported symptom: the field shows a value, so it reads as configured.
    expect(r.defaultCycleName).toBe('Monthly');
    expect(r.defaultCycleResolves).toBe(false);
  });

  it('agrees exactly with the gate that refuses the run (INVALID_CYCLE)', async () => {
    const a = groupAdmin();
    const ready = await createCompany(adminCtx(b), { legalName: 'Cycled Sdn Bhd' }); // createCompany seeds cycles
    const ids = [b.companyId, ready.id];

    const readiness = await payrollCycleReadiness(a, ids);
    const missing = new Set((await companiesMissingCycle(a, ids, 'regular')).map((m) => m.companyId));

    // Equivalence, both directions — this is what makes the settings screen trustworthy rather than a
    // second, drifting opinion about who can run payroll.
    for (const r of readiness) expect(r.canRunRegularPayroll).toBe(!missing.has(r.companyId));
    expect(readiness.find((r) => r.companyId === b.companyId)?.canRunRegularPayroll).toBe(false);
    expect(readiness.find((r) => r.companyId === ready.id)?.canRunRegularPayroll).toBe(true);
  });

  it('separates a stale default from a missing catalog: a company can run and still point at nothing', async () => {
    const a = adminCtx(b);
    const co = await createCompany(a, { legalName: 'Staleco Sdn Bhd' });
    // It starts consistent: seeded catalog, default 'Monthly' resolving to a real active cycle.
    let [r] = await payrollCycleReadiness(a, [co.id]);
    expect(r.canRunRegularPayroll).toBe(true);
    expect(r.defaultCycleResolves).toBe(true);

    // Now point the default at a name that does not exist. setCompanyDefaultPayrollCycle refuses this, so
    // the write goes in raw — which is exactly how a company reaches this state today: legacy data, or a
    // cycle renamed after the default was chosen. The catalog is untouched.
    await owner.db
      .update(schema.company)
      .set({ defaultPayrollCycle: 'Fortnightly' })
      .where(eq(schema.company.id, co.id));

    [r] = await payrollCycleReadiness(a, [co.id]);
    expect(r.defaultCycleResolves).toBe(false); // the stored name no longer resolves…
    expect(r.canRunRegularPayroll).toBe(true); // …but the company is NOT blocked. Two different problems.

    // And the reverse case: archive the one regular cycle and the company IS blocked, while the default
    // (still naming an archived cycle) is separately reported as unresolved.
    const monthly = (await listPayrollCycles(a, co.id, { activeOnly: true })).find((c) => c.runType === 'regular')!;
    await setPayrollCycleActive(a, { id: monthly.id, active: false });
    [r] = await payrollCycleReadiness(a, [co.id]);
    expect(r.canRunRegularPayroll).toBe(false);
    expect(r.activeRegularCycles).toBe(0);
  });

  it('save-time validation refuses to name a cycle that does not exist', async () => {
    const a = adminCtx(b);
    const co = await createCompany(a, { legalName: 'Guarded Sdn Bhd' });
    await expect(
      setCompanyDefaultPayrollCycle(a, { companyId: co.id, cycleName: 'Not A Cycle' }),
    ).rejects.toThrow(/not an active payroll cycle/);
    // …and the stored value is untouched, so a rejected save cannot leave a broken default behind.
    const [r] = await payrollCycleReadiness(a, [co.id]);
    expect(r.defaultCycleName).toBe('Monthly');
    expect(r.defaultCycleResolves).toBe(true);
  });

  it('reading readiness creates NOTHING — no cycle is invented for a blocked company', async () => {
    const a = adminCtx(b);
    await payrollCycleReadiness(a, [b.companyId]);
    await payrollReadiness(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const rows = await owner.db
      .select({ id: schema.payrollCycle.id })
      .from(schema.payrollCycle)
      .where(eq(schema.payrollCycle.companyId, b.companyId));
    expect(rows).toHaveLength(0);
  });

  it('the per-company readiness report carries the defaultCycle check', async () => {
    const a = adminCtx(b);
    await owner.db
      .update(schema.company)
      .set({ defaultPayrollCycle: 'Monthly' })
      .where(eq(schema.company.id, b.companyId));

    const report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const check = report.checks.find((c) => c.key === 'defaultCycle')!;
    expect(check.status).toBe('warning');
    expect(check.names).toEqual(['Monthly']); // the missing cycle is named, not just counted
    // Distinct from the empty-catalog blocker, which is what actually stops the run.
    expect(report.checks.find((c) => c.key === 'payrollCycle')?.status).toBe('blocker');
    expect(report.ready).toBe(false);
  });
});
