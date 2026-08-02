/**
 * ADR-0077 slice 10 — what a customer actually used on a given day, per company.
 *
 * `usage_snapshot` has existed since slice 1 and NOTHING HAS EVER WRITTEN TO IT. That is the whole
 * urgency: usage cannot be reconstructed after the fact. Employment counts change, payslips are deleted
 * with their drafts, modules are activated and deactivated — so a decision made next year to bill on past
 * usage has nothing to re-derive from. **Every day this stayed unwired is a day that can never be billed
 * retrospectively.** Slice 10's own verification criterion is "a synthetic bill for a past month
 * re-derives from snapshot rows alone", and that is only possible if the rows exist.
 *
 * THE PRICING UNIT IS DELIBERATELY STILL OPEN (plan §7.1). This over-captures on purpose: per-company
 * grain, per-country, headcount AND users AND payslips AND the active module set. Any of the plausible
 * units (per-employee, per-payslip, per-active-user, per-module) is derivable from these rows, so
 * capturing now blocks no later choice. Picking a unit first and capturing only that would.
 *
 * `payslipsGenerated` IS A DAILY DELTA, NOT A RUNNING TOTAL — the one field whose name could mislead.
 * It counts payslips CREATED on the captured day, so a month's usage is the SUM of its days. A running
 * total would make a monthly figure the difference between two snapshots, which breaks the moment a day
 * is missed (a cron that did not fire, a suspended tenant skipped) — and missed days are expected here.
 * A sum over present rows degrades gracefully; a difference between endpoints does not.
 *
 * COUNTED IN MYT, NOT UTC. `payslip.created_at` is a timestamptz and the sweep is scheduled in the small
 * hours local time; comparing its UTC date would attribute the first eight hours of every day to the day
 * before. This is the same bug the four leave sweeps carried until r92 — see
 * test/sweep-script-timezone.test.ts — and the reason the comparison below is explicit about its zone
 * rather than relying on the server's.
 *
 * ACTIVE USERS ARE ATTRIBUTED THROUGH EMPLOYMENT. `app_user` is tenant-scoped and has no company column,
 * so "users of this company" can only mean "users whose person holds an active employment there". A user
 * with employments at two companies counts once for each — which is correct for a per-company grain, and
 * is why a tenant total must be taken from the tenant's own row set rather than by summing companies.
 */
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { createDb } from '../db/client';
import { appUser, company, employment, payrollBatch, payslip, tenantModule } from '../db/schema';

type OwnerDb = ReturnType<typeof createDb>['db'];

/** One company's usage on one day — the shape of a `usage_snapshot` row. */
export type UsageCounts = {
  tenantId: string;
  companyId: string;
  companyName: string;
  capturedOn: string;
  country: string | null;
  activeEmployments: number;
  activeUsers: number;
  payslipsGenerated: number;
  modulesActive: string[];
};

/** Employment is active on `on` when it had started and had not yet ended. */
const activeOn = (on: string) =>
  and(
    sql`${employment.hiredOn} <= ${on}`,
    or(isNull(employment.terminatedOn), gte(employment.terminatedOn, on)),
  );

/**
 * Every company of every tenant in scope, with its counts for `capturedOn`.
 *
 * Runs on the OWNER connection: this is cross-tenant platform metering, so RLS must not bind it, and the
 * caller has already decided which tenants are in scope (see scripts/capture-usage.ts).
 */
export async function usageForTenant(db: OwnerDb, tenantId: string, capturedOn: string): Promise<UsageCounts[]> {
  const companies = await db
    .select({ id: company.id, name: company.legalName, country: company.country })
    .from(company)
    .where(eq(company.tenantId, tenantId));

  // The tenant's active module grants, split into tenant-wide and company-scoped. Read once rather than
  // per company: a tenant with 50 companies would otherwise issue 50 identical queries.
  //
  // ('active','trial') — the SAME set core/entitlements.ts:422 treats as enabled, and matching it is not
  // cosmetic: a trial module is a module the customer is genuinely using, and metering only 'active'
  // would under-report exactly the tenants a trial-to-paid conversation is about. One rule, two readers.
  const grants = await db
    .select({ moduleCode: tenantModule.moduleCode, companyId: tenantModule.companyId })
    .from(tenantModule)
    .where(and(eq(tenantModule.tenantId, tenantId), inArray(tenantModule.status, ['active', 'trial'])));

  const tenantWide = grants.filter((g) => g.companyId === null).map((g) => g.moduleCode);

  const out: UsageCounts[] = [];
  for (const c of companies) {
    const [emp] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(employment)
      .where(and(eq(employment.companyId, c.id), activeOn(capturedOn)));

    // DISTINCT: one person may hold more than one employment row at the same company over time, and a
    // user must not be counted twice for that.
    const [users] = await db
      .select({ n: sql<number>`count(distinct ${appUser.id})::int` })
      .from(appUser)
      .innerJoin(employment, eq(employment.personId, appUser.personId))
      .where(and(eq(appUser.tenantId, tenantId), eq(employment.companyId, c.id), activeOn(capturedOn)));

    // MYT, not UTC — see this file's header. The cast is applied to the timestamp, not to a string, so
    // Postgres does the zone conversion rather than JavaScript.
    const [slips] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          eq(payrollBatch.companyId, c.id),
          sql`(${payslip.createdAt} AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${capturedOn}::date`,
        ),
      );

    const scoped = grants.filter((g) => g.companyId === c.id).map((g) => g.moduleCode);
    // Sorted and deduplicated so the stored array is comparable between days — an unordered set would
    // make "did the module mix change" a set operation rather than an equality check.
    const modulesActive = [...new Set([...tenantWide, ...scoped])].sort();

    out.push({
      tenantId,
      companyId: c.id,
      companyName: c.name,
      capturedOn,
      country: c.country,
      activeEmployments: emp?.n ?? 0,
      activeUsers: users?.n ?? 0,
      payslipsGenerated: slips?.n ?? 0,
      modulesActive,
    });
  }
  return out;
}
