/**
 * ADR-0077 slice 9 — CLOSE a tenant. The destructive half of the lifecycle, and the caller
 * `core/tenant-lifecycle.ts closureDecision` never had.
 *
 *   node --env-file=.env.production --import tsx scripts/close-tenant.ts \
 *     --tenant <uuid> --requested-by <uuid> --approved-by <uuid> --no-retention-hold
 *   …same line plus --apply to actually record it.
 *
 * `--env-file` IS MANDATORY, not decoration. db/client.ts reads DATABASE_URL at MODULE SCOPE and throws
 * if it is missing, so an import of this file fails before argv is looked at — which is why there is no
 * in-file `loadEnvFile` fallback here. (scripts/apply-dunning.ts carries one; it is unreachable for
 * exactly this reason. scripts/reactivate-tenant.ts, the sibling this file follows, does not.)
 *
 * REPORT-ONLY BY DEFAULT and it writes NOTHING without --apply, the same contract as its sibling
 * scripts/reactivate-tenant.ts and scripts/apply-dunning.ts. Reactivation and closure are the two ends
 * of one slice and the operator should meet ONE idiom, so the flag names, the env contract, the
 * report-then-apply shape and the exit codes below are deliberately copied rather than improved on.
 *
 * ── WHY A RUNNER AND NOT A SCREEN ─────────────────────────────────────────────────────────────────
 * ADR-0077 D5 keeps the platform plane OFF the tenant session, and the platform role is written but not
 * provisioned in production (PLATFORM_DATABASE_URL is unset), so a /platform screen cannot be reached
 * today. `tenant` is also owner-writable only — 0313 leaves ai_hr_app with SELECT on it — so the write
 * below cannot come from the web application at all. A runner on the owner credential is the honest
 * surface, exactly as reactivation chose.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────────
 * It does not delete anything. Closure STARTS the retention clock that ends in destruction; it is not
 * the destruction. Nothing in this repo yet performs that end, and this runner deliberately does not
 * grow one — the whole point of dual control is that the irreversible step is reached slowly.
 *
 * It does not close an open suspension window either. `tenant_suspension_window.resumed_at` means the
 * tenant RESUMED, and a tenant that was suspended and then closed never did. Stamping a resumed_at to
 * tidy the row would assert something that did not happen, and `suspendedDaysWithin` would then report
 * a frozen period that ended. The window stays open, which is the truth; nothing reads it for a closed
 * tenant because `sweepSkipReason` steps over 'closed' before any expiry arithmetic runs.
 *
 * EXIT CODES, matching the siblings: 0 = reported or applied; 1 = the closure was REFUSED, or the
 * tenant does not exist; 2 = the command line itself was unusable.
 */
import { and, count, eq, isNull, isNotNull, max } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { company, employment, tenant } from '../db/schema';
import { closureDecision, type ClosureDecision } from '../core/tenant-lifecycle';
import { todayInKualaLumpur } from '../lib/hr-date';

/** What closure ENDS, gathered before the decision so the operator reads it before they read a verdict. */
export type ClosureImpact = {
  tenantId: string;
  tenantName: string;
  status: string;
  companies: number;
  employments: number;
  activeEmployments: number;
  /** The most recent termination date in the tenant, or null if nobody has ever left. Advisory only. */
  latestTerminationOn: string | null;
};

export type ClosureOutcome = {
  /** null ⇒ no such tenant. */
  impact: ClosureImpact | null;
  decision: ClosureDecision;
  /** True only when --apply was passed AND the decision was 'close'. */
  applied: boolean;
};

export type ClosureOptions = {
  tenantId: string;
  /**
   * The two people, as OPAQUE uuids. Deliberately not resolved against `app_user`, and this is a
   * limitation worth stating rather than hiding: migration 0350 gives these columns no foreign key,
   * and the people who close a customer account are platform operators — ADR-0077 D5 keeps the
   * platform plane off the tenant session, so they are exactly the identities that do NOT appear in
   * this tenant's `app_user`. There is no platform identity table to point at yet (slice 7 is
   * unprovisioned). So the runner checks the SHAPE of the ids and that they are two DIFFERENT ones,
   * and cannot check that either is a person. When slice 7 is provisioned, this is the check to add.
   */
  requestedBy: string | null;
  approvedBy: string | null;
  /**
   * The date the LAST statutory retention obligation runs to, across every jurisdiction the tenant
   * operates in — or null to declare that nothing is held.
   *
   * REQUIRED as an explicit choice by the CLI below (`--retention-until` or `--no-retention-hold`),
   * because `null` here is ambiguous in exactly the way this slice refuses to be: it can mean "asked
   * and nothing is outstanding" or "nobody looked". core/tenant-lifecycle.ts cannot tell those apart —
   * it takes a resolved date — so the distinction has to be made by the caller, which is this file.
   *
   * Nothing in the repo can resolve it FOR the operator today: retention horizons are a pack question
   * (core/tenant-lifecycle.ts says so) and no pack carries retention rules. The nearest thing that
   * exists is core/pdpa.ts's LHDN/EPF/SOCSO ~7-year hold, which is per-PERSON and per-FIELD and governs
   * erasure of PII, not the closure of an account — so this runner PRINTS the tenant's latest
   * termination date as context and leaves the judgement where it belongs.
   */
  retentionHeldUntil: string | null;
  requestedAt: Date;
  approvedAt: Date;
  apply: boolean;
  today?: string;
};

export async function runClosure(url: string, opts: ClosureOptions): Promise<ClosureOutcome> {
  const owner = createDb(url);
  const today = opts.today ?? todayInKualaLumpur();

  const [t] = await owner.db
    .select({ id: tenant.id, name: tenant.name, status: tenant.status })
    .from(tenant)
    .where(eq(tenant.id, opts.tenantId))
    .limit(1);
  if (!t) {
    return { impact: null, decision: { action: 'refuse', reason: `no such tenant: ${opts.tenantId}` }, applied: false };
  }

  // WHAT CLOSURE ENDS — gathered BEFORE the decision, and printed before it, because a verdict read
  // without the size of the thing it applies to is a verdict nobody actually checked.
  const [companies] = await owner.db
    .select({ n: count() })
    .from(company)
    .where(eq(company.tenantId, t.id));
  const [employments] = await owner.db
    .select({ n: count() })
    .from(employment)
    .where(eq(employment.tenantId, t.id));
  const [active] = await owner.db
    .select({ n: count() })
    .from(employment)
    .where(and(eq(employment.tenantId, t.id), isNull(employment.terminatedOn)));
  const [lastLeaver] = await owner.db
    .select({ on: max(employment.terminatedOn) })
    .from(employment)
    .where(and(eq(employment.tenantId, t.id), isNotNull(employment.terminatedOn)));

  const impact: ClosureImpact = {
    tenantId: t.id,
    tenantName: t.name,
    status: t.status,
    companies: companies?.n ?? 0,
    employments: employments?.n ?? 0,
    activeEmployments: active?.n ?? 0,
    latestTerminationOn: lastLeaver?.on ?? null,
  };

  // THE DECISION IS NOT MADE HERE. Dual control, the already-closed guard and the retention comparison
  // all live in core/tenant-lifecycle.ts, are pinned by test/tenant-lifecycle.test.ts, and are reached
  // through this one call. Re-deciding any of it in the runner would give the rules a second home that
  // could drift — and the two homes would disagree on the day it mattered most.
  const decision = closureDecision({
    tenantStatus: t.status,
    requestedBy: opts.requestedBy,
    approvedBy: opts.approvedBy,
    retentionHeldUntil: opts.retentionHeldUntil,
    today,
  });

  if (decision.action === 'refuse' || !opts.apply) {
    return { impact, decision, applied: false };
  }

  // Narrowed by the guard above: closureDecision returned 'close', so both ids are non-null and
  // distinct. The DB CHECK (tenant_closure_dual_control_check, migration 0350) says the same thing a
  // second time — it is the backstop against a hand-written UPDATE, not a duplicate of this check.
  const requestedBy = opts.requestedBy!;
  const approvedBy = opts.approvedBy!;
  const closedAt = new Date();

  await owner.db.transaction(async (tx) => {
    await tx
      .update(tenant)
      .set({
        status: 'closed',
        closedAt,
        closureRequestedBy: requestedBy,
        closureRequestedAt: opts.requestedAt,
        closureApprovedBy: approvedBy,
        closureApprovedAt: opts.approvedAt,
      })
      .where(eq(tenant.id, t.id));

    // The event is the record of WHY a customer's account ended and who agreed to it. The row's five
    // closure columns carry the same facts, but a column can be UPDATEd and this log cannot.
    //
    // actor is `system`: the runner is what wrote the row. The two humans are evidence carried in the
    // payload, not the actor — attributing the write to the approver would claim they were at this
    // terminal, and scripts/reactivate-tenant.ts stamps its half of the lifecycle the same way.
    await appendEvent(tx as never, {
      tenantId: t.id,
      aggregateType: 'tenant',
      aggregateId: t.id,
      eventType: 'tenant.closed',
      actor: { type: 'system' },
      payload: {
        reason: decision.reason,
        statusBefore: impact.status,
        requestedBy,
        requestedAt: opts.requestedAt.toISOString(),
        approvedBy,
        approvedAt: opts.approvedAt.toISOString(),
        closedAt: closedAt.toISOString(),
        retentionHeldUntil: opts.retentionHeldUntil,
        companies: impact.companies,
        employments: impact.employments,
        activeEmployments: impact.activeEmployments,
        appliedOn: today,
      },
    });
  });

  return { impact, decision, applied: true };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const USAGE = [
  'usage: close-tenant.ts --tenant <uuid> --requested-by <uuid> --approved-by <uuid>',
  '                      (--retention-until YYYY-MM-DD | --no-retention-hold)',
  '                      [--requested-at <iso>] [--approved-at <iso>] [--today YYYY-MM-DD] [--apply]',
].join('\n');

/** Usage error → exit 2, distinct from a policy REFUSAL (exit 1). A malformed id is not a decision. */
function usage(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseStamp(flag: string, fallback: Date): Date {
  const raw = argOf(flag);
  if (raw === null) return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) usage(`${flag} is not a date I can read: ${raw}`);
  return d;
}

function printReport(i: ClosureImpact, opts: ClosureOptions): void {
  console.log('WHAT CLOSURE ENDS');
  console.log(`  tenant:             ${i.tenantName} (${i.tenantId})`);
  console.log(`  status now:         ${i.status}`);
  console.log(`  companies:          ${i.companies}`);
  console.log(`  employments:        ${i.employments} (${i.activeEmployments} still employed, ${i.employments - i.activeEmployments} terminated)`);
  console.log(`  latest termination: ${i.latestTerminationOn ?? 'nobody has ever left'}`);
  console.log('');
  console.log('DUAL CONTROL');
  console.log(`  requested by:       ${opts.requestedBy ?? '(none given)'} at ${opts.requestedAt.toISOString()}`);
  console.log(`  approved by:        ${opts.approvedBy ?? '(none given)'} at ${opts.approvedAt.toISOString()}`);
  console.log(
    `  retention:          ${opts.retentionHeldUntil ? `held until ${opts.retentionHeldUntil}` : 'declared clear (--no-retention-hold)'}`,
  );
  console.log('');
  console.log('WHAT THE STATUS CHANGE MEANS');
  console.log("  'closed' is not good standing: every session for this tenant becomes read-only, and every");
  console.log('  nightly sweep steps over it with "closed — the tenant is in its retention window".');
  console.log('  scripts/reactivate-tenant.ts REFUSES to reinstate a closed tenant: undoing this is a new');
  console.log('  decision that has to go back through the same two people, not a reversal of this one.');
  console.log('  Nothing is deleted here. Closure starts the retention clock; it is not the end of it.');
  console.log('');
}

if (process.argv[1]?.endsWith('close-tenant.ts')) {
  const tenantId = argOf('--tenant');
  if (!tenantId || !UUID.test(tenantId)) usage('--tenant must be a tenant uuid');

  // NOT validated as "required": a MISSING requester or approver is a dual-control refusal and must be
  // heard from closureDecision in its own words, not from an argument parser. Only a present-but-
  // malformed id is a usage error — refusing that here keeps a typo'd uuid from reading as "no approver".
  const requestedBy = argOf('--requested-by');
  const approvedBy = argOf('--approved-by');
  if (requestedBy !== null && !UUID.test(requestedBy)) usage(`--requested-by is not a uuid: ${requestedBy}`);
  if (approvedBy !== null && !UUID.test(approvedBy)) usage(`--approved-by is not a uuid: ${approvedBy}`);

  // RETENTION MUST BE STATED, one way or the other. Defaulting to "nothing held" would let a tenant be
  // closed because an operator forgot a flag, which is the one failure this whole slice exists to
  // prevent; defaulting to "held" would refuse every closure forever. So: no default, say which.
  const retentionUntil = argOf('--retention-until');
  const noHold = process.argv.includes('--no-retention-hold');
  if (retentionUntil !== null && noHold) usage('--retention-until and --no-retention-hold contradict each other');
  if (retentionUntil === null && !noHold) {
    usage(
      'retention is unresolved. Pass --retention-until YYYY-MM-DD, or --no-retention-hold to state that\n' +
        'nothing is outstanding. Nothing in this system can answer it for you: retention horizons are a\n' +
        'jurisdiction/pack question and no pack carries them yet. The report prints the tenant\'s latest\n' +
        'termination date as context.',
    );
  }
  if (retentionUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(retentionUntil)) {
    usage(`--retention-until must be YYYY-MM-DD: ${retentionUntil}`);
  }
  // --today MUST be validated to the same shape, and this is not symmetry for its own sake.
  // closureDecision compares the two as RAW STRINGS (`retentionHeldUntil > today`), so any --today that
  // sorts above the retention date turns the retention hold into a no-op while the runner still reports
  // "past every retention hold" — the operator is told the check passed when it was never applied. It is
  // the one refusal they cannot re-derive from the printed report, so a malformed value must stop here
  // rather than be silently coerced.
  const todayArg = argOf('--today');
  if (todayArg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(todayArg)) {
    usage(`--today must be YYYY-MM-DD: ${todayArg}`);
  }

  const now = new Date();
  const requestedAt = parseStamp('--requested-at', now);
  const approvedAt = parseStamp('--approved-at', now);
  // An approval that predates the request it approves is not a dual-control record, it is a typo.
  if (approvedAt < requestedAt) usage('--approved-at is before --requested-at');

  const opts: ClosureOptions = {
    tenantId,
    requestedBy,
    approvedBy,
    retentionHeldUntil: retentionUntil,
    requestedAt,
    approvedAt,
    apply: process.argv.includes('--apply'),
    today: todayArg ?? undefined,
  };

  // OWNER CREDENTIAL ONLY, like every other out-of-band runner: 0313 leaves ai_hr_app with SELECT on
  // `tenant`, so the app role physically cannot make this write.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set — tenant is owner-writable only.');
    process.exit(2);
  }

  runClosure(url, opts)
    .then((o) => {
      if (!o.impact) {
        console.error(o.decision.reason);
        process.exit(1);
      }
      printReport(o.impact, opts);
      if (o.decision.action === 'refuse') {
        console.error(`REFUSED: ${o.decision.reason}`);
        console.error('Nothing was written.');
        process.exit(1);
      }
      if (!o.applied) {
        console.log(`would close: ${o.decision.reason}`);
        console.log('\n(report only — nothing was written. Pass --apply to record the closure.)');
        process.exit(0);
      }
      console.log(`CLOSED: ${o.decision.reason}`);
      console.log('The retention clock starts now. Destruction is a separate, later act — not this runner.');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
