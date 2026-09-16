/**
 * READINESS 2.1 — AN ALARM FOR THE ENTITLEMENT ENGINE GOING DARK.
 *
 * ── THE OUTAGE THIS EXISTS FOR ───────────────────────────────────────────────────────────────────
 * On 2026-09-12 the reporting tenant had ZERO entitlement templates and ZERO eligibility rules in
 * force. Nobody resolved to any leave entitlement. It stayed that way for a day and NOTHING anywhere
 * raised an alarm; the reporter found it themselves that evening. Nobody else would have noticed
 * until an employee was refused leave.
 *
 * The outage is closed. What survives is the shape of the risk: `entitlement_template` +
 * `entitlement_eligibility_rule` are, since 6e9a126e release three deleted `benefit_scheme`,
 * `scheme_leave_entitlement` and `leave_policy`, the ONLY thing that decides an employee's days. One
 * admin edit can take the whole layer out of force, and every engine downstream reads that as
 * "no opinion" (`noEntitlementOpinion`, core/leave-compute.ts) — which is correct behaviour and is
 * exactly why it is silent.
 *
 * ── READ-ONLY, AND POSTGRES ENFORCES IT RATHER THAN THIS COMMENT ────────────────────────────────
 * Every transaction this module opens issues `SET TRANSACTION READ ONLY` as its first statement, so
 * an INSERT/UPDATE/DELETE reaching this path is refused by the server with
 * "cannot execute ... in a read-only transaction". A detector that can change a figure is a second
 * way to cause the outage it is watching for. `test/r296-entitlement-alarm.test.ts` pins it by trying
 * a write inside the same transaction.
 *
 * ── HOW TENANT SCOPING IS DONE, AND WHY IT IS NOT LEFT TO RLS ───────────────────────────────────
 * The six cron sweeps connect as the OWNER role to enumerate tenants, and the owner BYPASSES RLS. So
 * every per-tenant read below goes through `withTenant` on the APPLICATION pool (the singleton in
 * db/client.ts, `ai_hr_app`, NOBYPASSRLS) — the same path every screen takes — AND carries an
 * explicit `tenant_id` predicate of its own. Neither is load-bearing alone: the explicit predicate is
 * what makes the scoping application-layer, and RLS is the backstop, not the mechanism.
 *
 * The one place that matters most is the engine itself. `buildTemplateEntitlementResolver` and
 * `resolveOrgCriteriaTargets` carry no tenant predicate of their own (they were written for a
 * request, where RLS binds them). They are therefore fed ONLY ids this module has already scoped:
 * the employment ids come from an explicit `tenant_id =` query and are passed as the resolver's
 * `employmentIds` RESTRICTION, and the leave type ids likewise. A restriction can only narrow, so
 * even with RLS removed the resolver could not answer about another tenant's people.
 *
 * ── IT ASKS THE ENGINE; IT DOES NOT RE-DERIVE ELIGIBILITY ───────────────────────────────────────
 * core/entitlement-template.ts's header is explicit that a second "who does this apply to" matcher is
 * "the defect wearing the fix's clothes". So "does anybody resolve" is `winnerFor` — the engine's own
 * batched answer, including the r193 sole-table branch and the 76ffdcf2 default-table branch — and
 * "who is an active employee" is `resolveOrgCriteriaTargets` with an EMPTY criteria object, which is
 * that module's documented spelling of "everyone". Nothing here compares a date to a window by hand
 * except the template COUNTS, which are a different question from eligibility.
 *
 * ── THE TWO PREDICATES, AND THE THREE THINGS THAT MUST NOT ALARM ────────────────────────────────
 *
 * ALARM 1 · ENGINE DARK (tenant scale) —
 *     templatesInForce === 0 AND templatesStarted > 0 AND activeEmployments > 0
 *
 *   `templatesStarted` counts templates whose `valid_from <= today` — versions that HAVE ALREADY BEEN
 *   IN FORCE at some point, whether or not they still are. That single term is what separates the
 *   two zeroes the reporter's own item asks about:
 *
 *     • A BRAND-NEW TENANT has no template rows at all ⇒ started = 0 ⇒ silent. An alarm that fires on
 *       every freshly provisioned customer is an alarm nobody reads, and it would fire on the day the
 *       tenant is created, before anybody could have configured anything.
 *     • A TENANT MID-SETUP, whose only templates are dated to start next month, has ever > 0 but
 *       started = 0 ⇒ silent. Nothing has stopped; nothing had started.
 *     • A TENANT THAT WAS CONFIGURED AND IS NOW ZERO has started > 0 and inForce = 0 ⇒ ALARM. That is
 *       the 2026-09-12 state exactly.
 *
 *   `activeEmployments > 0` is the second, independent reason a new tenant is silent: nobody can be
 *   refused leave in a tenant with no employees, so there is no incident to raise.
 *
 *   A DELIBERATELY RETIRED VERSION DOES NOT ALARM, and this falls out of the predicate rather than
 *   being special-cased: retiring one template or one rule while anything else is still in force
 *   leaves `templatesInForce > 0`. The reporter retired rule `e1aa6e06` on purpose on the evening of
 *   2026-09-12 and 1 template + 1 rule remained in force — that state is healthy and must stay silent.
 *   Only retiring the LAST thing in force is an alarm, because only then does nobody resolve.
 *
 *   ⚠️ IT IS DELIBERATELY NOT "eligibility rules in force dropped to zero". A leave type with exactly
 *   ONE table in force and NO rule resolves for EVERYBODY (r193 fault 3), and a leave type with a
 *   default table set resolves for everybody the rules missed (76ffdcf2). Alarming on zero rules would
 *   therefore fire on two configurations this product treats as correct. Rule counts are REPORTED, for
 *   the operator reading the line, and never alarmed on. Whether the rules actually reach anybody is
 *   alarm 2's question, asked of the engine instead of guessed from a count.
 *
 * ALARM 2 · A LEAVE TYPE RESOLVES FOR NOBODY —
 *     for an ACTIVE leave type with at least one template IN FORCE today,
 *     no active employment has a `winnerFor(employment, type)`
 *
 *   This is r209's distinction, which `buildTemplateEntitlementResolver.hasTemplatesFor` exists to
 *   make: tables exist, they are correct, and no rule points anybody at one. The configuration is
 *   half-built and 0.00 is a defect somebody has to go and fix — as opposed to a type with no table
 *   at all, where nobody was ever meant to get days and 0.00 is the truth.
 *
 *   ⚠️ A TYPE WITH NO TABLE IN FORCE IS EXCLUDED, AND THAT IS A DECISION, NOT AN OVERSIGHT. It is the
 *   product position core/entitlement-scheme-view.ts already ships to the screen: "Types with NO table
 *   at all are deliberately absent: nobody was ever meant to get days there, so flagging them would
 *   bury the ones that are genuinely half-configured." An alarm taking the opposite position would
 *   contradict a screen, and on the reporting tenant — 1 template in force across nine active leave
 *   types as measured on 2026-09-13 — it would have raised eight findings on its first night. The
 *   tenant-scale case, where EVERY type loses its table at once, is alarm 1 and is the box the
 *   readiness item actually asks for.
 *
 * ── WHAT THIS DOES NOT DETECT, STATED PLAINLY ───────────────────────────────────────────────────
 * A tenant whose templates were HARD DELETED rather than retired reads as never-configured and stays
 * silent. `deleteEntitlementTemplate` already refuses a lineage whose window overlaps a non-zero
 * granting ledger row, so an operating tenant cannot ordinarily reach that state — but the guard is
 * an approximation (the ledger records no template reference at all; see that function's header), so
 * this is a real residual and not a reasoned-away one. Closing it needs the deciding lineage recorded
 * ON the grant, which is a schema change and a separate item.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { withTenant, type SessionContext, type Tx } from '../db/client';
import { employment, entitlementEligibilityRule, entitlementTemplate, leaveType } from '../db/schema';
import { resolveOrgCriteriaTargets } from './org-criteria';
// ADR-0080 D9 — core/entitlement-template.ts is a LEAVE PACK boundary module and this file is an
// outside consumer, so it takes the engine through the pack facade exactly as
// core/entitlement-scheme-view.ts does. Importing the boundary directly would need an entry on
// test/pack-drift-allowlist.json, which is audited debt that may only ever shrink.
import { buildTemplateEntitlementResolver } from '../packs/leave/service';
import { describeSkips, loadSweepScope } from './sweep-scope';

/** Which of the two readiness 2.1 boxes a finding is. */
export type EntitlementAlarmKind =
  /** "a tenant's entitlement templates in force dropped to zero" */
  | 'engine_dark'
  /** "a leave type resolves for nobody" */
  | 'type_resolves_for_nobody';

export type EntitlementAlarm = {
  kind: EntitlementAlarmKind;
  /** Null for `engine_dark`, which is about the tenant rather than one type. */
  leaveTypeId: string | null;
  leaveTypeCode: string | null;
  leaveTypeName: string | null;
  /** One plain line, written to be readable in a 20-line journal tail with no other context. */
  message: string;
};

/**
 * Why the tenant-scale check stayed silent, when it did. Reported rather than inferred, so an operator
 * asking "why did this tenant not alarm" gets an answer instead of an absence.
 */
export type EntitlementQuietReason =
  /** No entitlement template row has ever existed. A freshly provisioned tenant. */
  | 'never_configured'
  /** Templates exist but none has started yet (every `valid_from` is in the future). Mid-setup. */
  | 'not_started_yet'
  /** Nobody is employed here as at today, so nobody can be refused leave. */
  | 'no_active_employments';

export type TenantEntitlementHealth = {
  tenantId: string;
  asOf: string;
  activeEmployments: number;
  /** Every `entitlement_template` row for this tenant, whatever its window. */
  templatesEver: number;
  /** Rows whose `valid_from <= asOf` — versions that have already been in force at some point. */
  templatesStarted: number;
  /** Rows in force on `asOf`: `valid_from <= asOf < valid_to` (half-open; NULL `valid_to` is open). */
  templatesInForce: number;
  /** Reported only. Zero rules is a legitimate configuration — see the header. */
  rulesInForce: number;
  leaveTypesActive: number;
  leaveTypesWithTemplateInForce: number;
  /** The latest `valid_to` among started templates — the day the engine went dark. Null if none. */
  lastStoppedOn: string | null;
  quiet: EntitlementQuietReason | null;
  alarms: EntitlementAlarm[];
};

/** The tenant-scale facts alarm 1 is a function of. Split out so the predicate is testable without a database. */
export type EngineDarkFacts = {
  activeEmployments: number;
  templatesStarted: number;
  templatesInForce: number;
};

/**
 * ALARM 1's predicate, in one place and pure.
 *
 * Every term is load-bearing and each one is pinned by its own case in
 * `test/r296-entitlement-alarm.test.ts`:
 *   `templatesInForce === 0`  — nothing decides anybody's days today.
 *   `templatesStarted > 0`    — and something used to, so this is a LOSS and not an empty tenant.
 *   `activeEmployments > 0`   — and there is somebody it can hurt.
 */
export function engineIsDark(f: EngineDarkFacts): boolean {
  return f.templatesInForce === 0 && f.templatesStarted > 0 && f.activeEmployments > 0;
}

/**
 * Why alarm 1 stayed silent, or null when it fired. Checked in the order an operator would ask them:
 * an empty tenant is empty before it is unconfigured.
 */
export function quietReasonFor(f: EngineDarkFacts & { templatesEver: number }): EntitlementQuietReason | null {
  if (engineIsDark(f)) return null;
  if (f.templatesInForce > 0) return null; // healthy — nothing to explain
  if (f.activeEmployments === 0) return 'no_active_employments';
  if (f.templatesEver === 0) return 'never_configured';
  return 'not_started_yet';
}

/** `count(*) filter (...)`, as a number rather than the bigint string postgres-js returns. */
const filtered = (where: SQL) =>
  sql<number>`count(*) filter (where ${where})::int`.mapWith(Number);

/**
 * THE PER-TENANT CHECK. One read-only transaction on the application pool, scoped to one tenant.
 *
 * Cost, so a future round can see where the ceiling is: four aggregate/list queries plus whatever
 * `buildTemplateEntitlementResolver` costs, which is ONE `resolveOrgCriteriaTargets` query per
 * eligibility rule in force, narrowed to this tenant's employments. Rules are the number of
 * populations HR has described (one on the reporting tenant, three before that), not a data volume —
 * but the employment id list is passed in full, so a tenant with tens of thousands of employments
 * would want that restriction replaced with a tenant predicate inside the resolver.
 */
export async function checkTenantEntitlementHealth(
  ctx: SessionContext,
  asOf: string,
): Promise<TenantEntitlementHealth> {
  return withTenant(ctx, async (tx: Tx) => {
    // THE READ-ONLY GUARANTEE, enforced by the server. Issued as the first statement inside the
    // transaction body; `withTenant`'s own set_config calls are SELECTs and do not close the window
    // (verified against PG16, and the same position db/client.ts already issues its suspension
    // read-only from). Any write from here on is refused with a Postgres error, not a code review.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);

    const started = sql`${entitlementTemplate.validFrom} <= ${asOf}::date`;
    const inForce = sql`${entitlementTemplate.validFrom} <= ${asOf}::date and (${entitlementTemplate.validTo} is null or ${entitlementTemplate.validTo} > ${asOf}::date)`;
    const [tpl] = await tx
      .select({
        ever: sql<number>`count(*)::int`.mapWith(Number),
        started: filtered(started),
        inForce: filtered(inForce),
        // The day the engine went dark: the latest close date among versions that had started. NULL
        // where nothing has been closed, which is the never-configured and mid-setup cases.
        lastStoppedOn: sql<
          string | null
        >`max(${entitlementTemplate.validTo}) filter (where ${started})::text`,
      })
      .from(entitlementTemplate)
      // EXPLICIT, not left to RLS — the sweep's owner role would bypass the policy entirely.
      .where(eq(entitlementTemplate.tenantId, ctx.tenantId));

    const [rule] = await tx
      .select({
        inForce: filtered(
          sql`${entitlementEligibilityRule.validFrom} <= ${asOf}::date and (${entitlementEligibilityRule.validTo} is null or ${entitlementEligibilityRule.validTo} > ${asOf}::date)`,
        ),
      })
      .from(entitlementEligibilityRule)
      .where(eq(entitlementEligibilityRule.tenantId, ctx.tenantId));

    // The employment ids this tenant owns, stated explicitly. Everything the engine is later asked
    // about is a SUBSET of this list, which is what makes the tenant scoping application-layer.
    const owned = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.tenantId, ctx.tenantId));
    const ownedIds = owned.map((e) => e.id);

    // "Who is an active employee as at today" — the criteria resolver's own answer to an EMPTY
    // criteria object, which that module documents as "no restrictions ⇒ every active employment".
    // Written this way rather than as a second hired_on / terminated_on comparison so the population
    // the alarm reasons about is the same one every bulk screen reaches.
    const activeIds = ownedIds.length
      ? await resolveOrgCriteriaTargets(tx, { criteria: {}, asOf, employmentIds: ownedIds })
      : [];

    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(and(eq(leaveType.tenantId, ctx.tenantId), isNull(leaveType.archivedAt)));

    const resolver = await buildTemplateEntitlementResolver(tx, {
      employmentIds: activeIds,
      leaveTypeIds: types.map((t) => t.id),
      asOf,
    });

    const facts: EngineDarkFacts & { templatesEver: number } = {
      activeEmployments: activeIds.length,
      templatesEver: tpl.ever,
      templatesStarted: tpl.started,
      templatesInForce: tpl.inForce,
    };

    const alarms: EntitlementAlarm[] = [];
    if (engineIsDark(facts)) {
      alarms.push({
        kind: 'engine_dark',
        leaveTypeId: null,
        leaveTypeCode: null,
        leaveTypeName: null,
        message:
          `ENTITLEMENT ENGINE DARK — 0 entitlement tables in force on ${asOf}, but ${tpl.started} ` +
          `version(s) have been in force before` +
          (tpl.lastStoppedOn ? ` (the last one stopped on ${tpl.lastStoppedOn})` : '') +
          `. ${activeIds.length} active employee(s) now resolve to no leave entitlement at all. ` +
          `Restore a table and a rule in force at /admin/leave-config; nothing here changes anything.`,
      });
    }

    // ALARM 2. Only types the engine says have a table in force are asked about — see the header on
    // why a type with no table is not a finding. `hasTemplatesFor` is the resolver's own r209 answer,
    // captured before its short-circuits, so it is truthful even on a tenant the resolver called empty.
    let typesWithTemplate = 0;
    for (const t of types) {
      if (!resolver.hasTemplatesFor(t.id)) continue;
      typesWithTemplate += 1;
      const reachesSomebody = activeIds.some((id) => resolver.winnerFor(id, t.id) !== null);
      if (reachesSomebody) continue;
      alarms.push({
        kind: 'type_resolves_for_nobody',
        leaveTypeId: t.id,
        leaveTypeCode: t.code,
        leaveTypeName: t.name,
        message:
          `LEAVE TYPE RESOLVES FOR NOBODY — "${t.name}" (${t.code}) has at least one entitlement table ` +
          `in force on ${asOf}, and not one of the ${activeIds.length} active employee(s) is reached by ` +
          `any eligibility rule, sole table or default table for it. The tables are unreachable, not absent.`,
      });
    }

    return {
      tenantId: ctx.tenantId,
      asOf,
      activeEmployments: activeIds.length,
      templatesEver: tpl.ever,
      templatesStarted: tpl.started,
      templatesInForce: tpl.inForce,
      rulesInForce: rule.inForce,
      leaveTypesActive: types.length,
      leaveTypesWithTemplateInForce: typesWithTemplate,
      lastStoppedOn: tpl.lastStoppedOn ?? null,
      quiet: quietReasonFor(facts),
      alarms,
    };
  });
}

/** Plain-English rendering of a quiet reason, for the line the operator reads. */
const QUIET_WORDS: Record<EntitlementQuietReason, string> = {
  never_configured: 'no entitlement table has ever been written here',
  not_started_yet: 'entitlement tables exist but none has started yet',
  no_active_employments: 'nobody is employed here today',
};

export type EntitlementAlarmRun = {
  /** Tenants the check actually evaluated. */
  tenantsChecked: number;
  /** Tenants the check could NOT evaluate. A hole in the answer, not a finding. */
  tenantsFailed: number;
  /** Tenants stepped over for standing (core/sweep-scope.ts). Not a failure. */
  tenantsSkipped: number;
  /** Tenants with at least one alarm. */
  tenantsAlarming: number;
  /** Total findings across every tenant. */
  alarms: number;
  /** Per-tenant detail, in enumeration order. Failed tenants are absent. */
  health: TenantEntitlementHealth[];
};

type OwnerDb = Parameters<typeof loadSweepScope>[0];

/**
 * THE CROSS-TENANT SWEEP. Enumerates tenants with the owner role — the only thing the owner
 * connection is used for — and runs the per-tenant check on the application pool for each.
 *
 * `log` is injected so the same function is driven by the cron script and asserted by the suite
 * without either owning a console.
 */
export async function entitlementAlarmSweep(
  ownerDb: OwnerDb,
  opts: { asOf: string; log?: (line: string) => void },
): Promise<EntitlementAlarmRun> {
  const log = opts.log ?? (() => {});
  const scope = await loadSweepScope(ownerDb);
  log(
    `entitlement:alarm — ${scope.run.length} tenant(s) in scope, as at ${opts.asOf}` +
      (scope.skipped.length > 0 ? `, ${scope.skipped.length} skipped` : ''),
  );
  for (const line of describeSkips(scope)) log(line);

  const out: EntitlementAlarmRun = {
    tenantsChecked: 0,
    tenantsFailed: 0,
    tenantsSkipped: scope.skipped.length,
    tenantsAlarming: 0,
    alarms: 0,
    health: [],
  };

  for (const t of scope.run) {
    try {
      // NO entitlement snapshot, deliberately: nothing this check reads is behind a billable module
      // gate, and a context with no snapshot is the documented "not known to be bad" case in
      // withTenant. `hr_admin` is what lets `app.is_admin()` show the sweep every employment, exactly
      // as the other sweeps' system contexts do. No userId ⇒ no actor ⇒ nothing to append anyway.
      const health = await checkTenantEntitlementHealth({ tenantId: t.id, roles: ['hr_admin'] }, opts.asOf);
      out.tenantsChecked += 1;
      out.health.push(health);
      if (health.alarms.length > 0) {
        out.tenantsAlarming += 1;
        out.alarms += health.alarms.length;
        log(
          `  ✗ ${t.name} (${t.id}): ${health.alarms.length} ALARM(S) — ` +
            `${health.templatesInForce} table(s) and ${health.rulesInForce} rule(s) in force, ` +
            `${health.activeEmployments} active employee(s)`,
        );
        for (const a of health.alarms) log(`      ${a.message}`);
      } else {
        log(
          `  ✓ ${t.name} (${t.id}): ${health.templatesInForce} table(s) and ${health.rulesInForce} rule(s) ` +
            `in force, ${health.leaveTypesWithTemplateInForce}/${health.leaveTypesActive} leave type(s) ` +
            `covered, ${health.activeEmployments} active employee(s)` +
            (health.quiet ? ` — no alarm: ${QUIET_WORDS[health.quiet]}` : ''),
        );
      }
    } catch (e) {
      // A tenant the check could not evaluate is a HOLE, not a clean bill of health, and it is what
      // makes the process exit non-zero below. Reporting it as "no alarms" is the failure mode this
      // whole item exists to remove.
      out.tenantsFailed += 1;
      log(`  ! ${t.name} (${t.id}): COULD NOT CHECK — ${(e as Error).message}`);
    }
  }

  log(
    `entitlement:alarm done — ${out.tenantsChecked} tenant(s) checked, ${out.alarms} alarm(s) across ` +
      `${out.tenantsAlarming} tenant(s), ${out.tenantsFailed} tenant(s) could not be checked` +
      (out.tenantsSkipped > 0 ? `, ${out.tenantsSkipped} skipped for standing` : '') +
      '.',
  );
  return out;
}

/** Exit codes. Distinct, because the wrapper's alert text carries the number and they mean different things. */
export const ALARM_EXIT = {
  /** Checked every tenant in scope; nothing is dark. */
  CLEAN: 0,
  /** The check itself could not answer for at least one tenant. You do not know. */
  INDETERMINATE: 2,
  /** Checked, and at least one tenant's entitlement engine is dark or unreachable. You know, and it is bad. */
  ALARM: 3,
} as const;

/**
 * Exit code for a completed run.
 *
 * A HOLE OUTRANKS A FINDING. If any tenant could not be checked, the run's headline is "this answer is
 * incomplete" — the alarms it did find are still printed, and both codes are non-zero so
 * `deploy/cron-alert.sh` alerts either way.
 */
export function alarmExitCode(run: Pick<EntitlementAlarmRun, 'tenantsFailed' | 'alarms'>): number {
  if (run.tenantsFailed > 0) return ALARM_EXIT.INDETERMINATE;
  if (run.alarms > 0) return ALARM_EXIT.ALARM;
  return ALARM_EXIT.CLEAN;
}
