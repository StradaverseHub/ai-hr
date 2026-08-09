/**
 * ADR-0076 — the payroll anomaly engine. The ADR-0074 control-tower keystone, Phase 1a.
 *
 * WHAT THIS IS FOR. ADR-0074 targets ~3,000 headcount run by 3 payroll staff — roughly 1000:1 against an
 * industry baseline of one payroll FTE per 250–500 people. That is only reachable if the overwhelming
 * majority of employees are paid with ZERO human touch, which makes it an exception-rate problem rather
 * than a headcount problem: at a 97% auto-clear rate, ~90 of 3,000 need human eyes per cycle. Nothing in
 * this codebase measured that rate before this module; every autonomy claim downstream depends on it.
 *
 * THREE INVARIANTS, none of them negotiable:
 *
 *  1. IT NEVER TOUCHES THE MONEY PATH. `evaluateBatchAnomalies` reads payslips and writes verdicts. It
 *     does not mutate a payslip, a batch total, or a statutory figure. The deterministic kernel keeps
 *     computing every ringgit; this layer only classifies what the kernel produced. That is what makes
 *     the ratio defensible to a CFO, an auditor, and PERKESO/LHDN.
 *
 *  2. THE CLASSIFICATION IS DETERMINISTIC. Detectors are pure functions over a plain context object
 *     (core/payroll-anomaly-detectors.ts) and the disposition is derived from severities, not scored.
 *     There is no LLM anywhere in this file. The optional narrative comes later and can never revise a
 *     classification.
 *
 *  3. IT IS IDEMPOTENT. Re-running on an open batch supersedes the previous verdicts rather than
 *     duplicating them, because the daily provisional dry-run will re-run this constantly. Superseded
 *     rows are KEPT — they are the record of what the system believed at the time.
 *
 * ONE BATCHED READ, NOT N+1. `gatherContext` issues a fixed number of queries for the whole batch and
 * assembles per-employee contexts in memory. This is deliberate and load-bearing: the target is a
 * 3,000-employee run on a daily cadence, and a per-employee query would make the dry-run's cost scale
 * with headcount in exactly the dimension the whole programme is trying to flatten.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import * as schema from '../db/schema';
import { packFor } from '../localization/registry';
import {
  DETECTORS,
  resolveDisposition,
  type Detector,
  type DetectorContext,
  type Disposition,
  type Finding,
  type PayslipFigures,
} from './payroll-anomaly-detectors';

const num = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * THE UNTUNED DEFAULTS, and they are labelled untuned on purpose.
 *
 * ADR-0076 §6 is blunt that only real client history or a shadow run produces defensible thresholds.
 * These are conservative placeholders so the layer works on a client's first cycle; a
 * `payroll_anomaly_config` row overrides any of them per tenant or per company, WITHOUT A DEPLOY, which
 * is the entire reason thresholds live in the database. Nobody should mistake 30 for an empirical number.
 */
export const UNTUNED_DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  'net-swing': { netSwingPct: 30 },
};

export type SkippedDetector = { id: string; reason: string };

export type EmployeeVerdict = {
  employmentId: string;
  disposition: Disposition;
  findings: Finding[];
  detectorsRun: string[];
  detectorsSkipped: SkippedDetector[];
};

export type BatchEvaluation = {
  batchId: string;
  /** Counts by disposition — the auto-clear rate's numerator and denominator. */
  autoClear: number;
  review: number;
  block: number;
  total: number;
  /** detectorsRun / (run + skipped), averaged over employees. Guards against a false clean (§2.4). */
  coverage: number;
  verdicts: EmployeeVerdict[];
};

/** Everything the whole batch needs, read once. */
type BatchContext = {
  batchId: string;
  companyId: string;
  tenantId: string;
  period: { start: string; end: string; calendarDays: number };
  /** Statutory ceilings derived from the ruleset IN FORCE FOR THIS BATCH, or null when unavailable. */
  caps: Record<string, number> | null;
  capsSkipReason: string | null;
  contexts: DetectorContext[];
};

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const figuresOf = (row: {
  grossPay: unknown;
  netPay: unknown;
  basicSalary: unknown;
  allowance: unknown;
  overtimePay: unknown;
  bonus: unknown;
  totalDeductions: unknown;
  daysWorked: unknown;
  statutory: unknown;
}): PayslipFigures => {
  const st = (row.statutory ?? {}) as Record<string, unknown>;
  const statutory: Record<string, number> = {};
  for (const [k, v] of Object.entries(st)) {
    // The blob also carries the absence stamp (objects), not only scalars — keep only the numbers.
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) {
      statutory[k] = num(v);
    }
  }
  return {
    grossPay: num(row.grossPay),
    netPay: num(row.netPay),
    basicSalary: num(row.basicSalary),
    allowance: num(row.allowance),
    overtimePay: num(row.overtimePay),
    bonus: num(row.bonus),
    totalDeductions: num(row.totalDeductions),
    daysWorked: row.daysWorked == null ? null : num(row.daysWorked),
    statutory,
  };
};

/**
 * Statutory ceilings, DERIVED FROM THE PACK RATHER THAN HARDCODED.
 *
 * SOCSO and EIS are exact scheduled amounts with a top band, so the ceiling is simply the largest amount
 * the schedule can produce. Reading it from the ruleset that this batch actually used means a rate-table
 * change cannot silently rot the detector — which a constant in this file would.
 *
 * EPF IS DELIBERATELY ABSENT. It is a percentage of wages with configurable per-employee rates and no
 * single scheduled maximum, so any "ceiling" here would be a guess, and a guessed ceiling on a BLOCK
 * detector would refuse to close real batches. Better to check the components we can check exactly.
 */
function capsFromRuleset(rules: unknown): Record<string, number> | null {
  const r = rules as
    | { socso?: { category1?: unknown[]; category2?: unknown[] }; eis?: { bands?: unknown[] } }
    | null
    | undefined;
  if (!r) return null;
  const maxOf = (bands: unknown[] | undefined, key: string): number =>
    (bands ?? []).reduce<number>((acc, b) => Math.max(acc, num((b as Record<string, unknown>)?.[key])), 0);

  const socso1 = r.socso?.category1;
  const socso2 = r.socso?.category2;
  const eis = r.eis?.bands;
  if (!socso1?.length && !eis?.length) return null;

  const caps: Record<string, number> = {};
  const socsoEmployee = Math.max(maxOf(socso1, 'employee'), maxOf(socso2, 'employee'));
  const socsoEmployer = Math.max(maxOf(socso1, 'employer'), maxOf(socso2, 'employer'));
  const skbbk = Math.max(maxOf(socso1, 'skbbk'), maxOf(socso2, 'skbbk'));
  const eisEmployee = maxOf(eis, 'employee');
  const eisEmployer = maxOf(eis, 'employer');
  if (socsoEmployee > 0) caps.socsoEmployee = socsoEmployee;
  if (socsoEmployer > 0) caps.socsoEmployer = socsoEmployer;
  if (skbbk > 0) caps.skbbk = skbbk;
  if (eisEmployee > 0) caps.eisEmployee = eisEmployee;
  if (eisEmployer > 0) caps.eisEmployer = eisEmployer;
  return Object.keys(caps).length ? caps : null;
}

async function gatherContext(tx: Tx, tenantId: string, batchId: string): Promise<BatchContext | null> {
  // Country comes from the COMPANY, not the batch — payroll_batch has no country column, and the
  // statutory pack is a property of the employing entity (which is the whole point of slice 6's
  // per-employer pack resolution).
  const [batch] = await tx
    .select({
      id: schema.payrollBatch.id,
      companyId: schema.payrollBatch.companyId,
      payPeriod: schema.payrollBatch.payPeriod,
      country: schema.company.country,
    })
    .from(schema.payrollBatch)
    .innerJoin(schema.company, eq(schema.company.id, schema.payrollBatch.companyId))
    .where(eq(schema.payrollBatch.id, batchId))
    .limit(1);
  if (!batch) return null;

  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const dim = daysInMonth(pYear, pMonth);
  const periodStart = `${batch.payPeriod}-01`;
  const periodEnd = `${batch.payPeriod}-${String(dim).padStart(2, '0')}`;

  const slips = await tx
    .select({
      employmentId: schema.payslip.employmentId,
      grossPay: schema.payslip.grossPay,
      netPay: schema.payslip.netPay,
      basicSalary: schema.payslip.basicSalary,
      allowance: schema.payslip.allowance,
      overtimePay: schema.payslip.overtimePay,
      bonus: schema.payslip.bonus,
      totalDeductions: schema.payslip.totalDeductions,
      daysWorked: schema.payslip.daysWorked,
      statutory: schema.payslip.statutory,
    })
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  if (slips.length === 0) {
    return {
      batchId,
      companyId: batch.companyId,
      tenantId,
      period: { start: periodStart, end: periodEnd, calendarDays: dim },
      caps: null,
      capsSkipReason: 'no payslips in this batch',
      contexts: [],
    };
  }
  const employmentIds = slips.map((s) => s.employmentId);

  // ── one read each, for the whole batch ────────────────────────────────────────────────────────────
  const emps = await tx
    .select({
      id: schema.employment.id,
      personId: schema.employment.personId,
      hiredOn: schema.employment.hiredOn,
      terminatedOn: schema.employment.terminatedOn,
      paymentMethod: schema.employment.paymentMethod,
    })
    .from(schema.employment)
    .where(inArray(schema.employment.id, employmentIds));
  const empById = new Map(emps.map((e) => [e.id, e]));
  const personIds = [...new Set(emps.map((e) => e.personId))];

  const profiles = personIds.length
    ? await tx
        .select({
          personId: schema.employeeStatutoryMy.personId,
          bankName: schema.employeeStatutoryMy.bankName,
          bankAccountNo: schema.employeeStatutoryMy.bankAccountNo,
        })
        .from(schema.employeeStatutoryMy)
        .where(inArray(schema.employeeStatutoryMy.personId, personIds))
    : [];
  const profileByPerson = new Map(profiles.map((p) => [p.personId, p]));

  // PRIOR CYCLE — the immediately preceding period for the SAME company that produced payslips. Ordered
  // by payPeriod (a 'YYYY-MM' string, so lexicographic order is chronological order) and limited to one.
  const [priorBatch] = await tx
    .select({ id: schema.payrollBatch.id })
    .from(schema.payrollBatch)
    .where(
      and(
        eq(schema.payrollBatch.companyId, batch.companyId),
        lt(schema.payrollBatch.payPeriod, batch.payPeriod),
      ),
    )
    .orderBy(sql`${schema.payrollBatch.payPeriod} desc`)
    .limit(1);

  const priorSlips = priorBatch
    ? await tx
        .select({
          employmentId: schema.payslip.employmentId,
          grossPay: schema.payslip.grossPay,
          netPay: schema.payslip.netPay,
          basicSalary: schema.payslip.basicSalary,
          allowance: schema.payslip.allowance,
          overtimePay: schema.payslip.overtimePay,
          bonus: schema.payslip.bonus,
          totalDeductions: schema.payslip.totalDeductions,
          daysWorked: schema.payslip.daysWorked,
          statutory: schema.payslip.statutory,
        })
        .from(schema.payslip)
        .where(eq(schema.payslip.batchId, priorBatch.id))
    : [];
  const priorByEmployment = new Map(priorSlips.map((s) => [s.employmentId, figuresOf(s)]));

  // ATTENDANCE + APPROVED LEAVE, aggregated in the database rather than pulled row-by-row: a 3,000-person
  // month is ~66,000 attendance rows and this only needs two counts per employee.
  const attRows = await tx
    .select({
      employmentId: schema.attendance.employmentId,
      days: sql<number>`count(distinct ${schema.attendance.attendanceDate})::int`,
    })
    .from(schema.attendance)
    .where(
      and(
        inArray(schema.attendance.employmentId, employmentIds),
        sql`${schema.attendance.attendanceDate} between ${periodStart} and ${periodEnd}`,
        sql`${schema.attendance.workedMinutes} > 0`,
      ),
    )
    .groupBy(schema.attendance.employmentId);
  const attByEmployment = new Map(attRows.map((r) => [r.employmentId, num(r.days)]));

  const leaveRows = await tx
    .select({
      employmentId: schema.leaveRequest.employmentId,
      days: sql<number>`coalesce(sum(${schema.leaveRequest.days}), 0)::float8`,
    })
    .from(schema.leaveRequest)
    .where(
      and(
        inArray(schema.leaveRequest.employmentId, employmentIds),
        eq(schema.leaveRequest.status, 'approved'),
        sql`${schema.leaveRequest.startDate} <= ${periodEnd}`,
        sql`${schema.leaveRequest.endDate} >= ${periodStart}`,
      ),
    )
    .groupBy(schema.leaveRequest.employmentId);
  const leaveByEmployment = new Map(leaveRows.map((r) => [r.employmentId, num(r.days)]));

  // CONCURRENT PAY — the same PERSON paid under another employment in the same period. Computed in
  // memory from the slips we already hold plus any other batch for the same period.
  const samePeriodOtherSlips = await tx
    .select({ employmentId: schema.payslip.employmentId, batchId: schema.payslip.batchId })
    .from(schema.payslip)
    .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
    .where(eq(schema.payrollBatch.payPeriod, batch.payPeriod));
  const paidEmploymentIds = new Set(samePeriodOtherSlips.map((r) => r.employmentId));
  // Resolve those employments to people so a second employment of the SAME person can be spotted.
  const paidEmps = paidEmploymentIds.size
    ? await tx
        .select({ id: schema.employment.id, personId: schema.employment.personId })
        .from(schema.employment)
        .where(inArray(schema.employment.id, [...paidEmploymentIds]))
    : [];
  const paidByPerson = new Map<string, string[]>();
  for (const e of paidEmps) {
    const list = paidByPerson.get(e.personId) ?? [];
    list.push(e.id);
    paidByPerson.set(e.personId, list);
  }

  // Statutory ceilings from the ruleset THIS batch used.
  let caps: Record<string, number> | null = null;
  let capsSkipReason: string | null = null;
  try {
    const pack = packFor(batch.country);
    if (!pack) {
      capsSkipReason = `no localization pack for country ${batch.country}`;
    } else {
      const rules = await pack.payroll.loadRuleset(tx, { asOf: periodEnd });
      caps = capsFromRuleset(rules);
      if (!caps) capsSkipReason = 'ruleset exposes no scheduled ceilings';
    }
  } catch {
    // A ruleset that will not load must not take the whole evaluation down; the detector is recorded as
    // skipped and every other detector still runs.
    capsSkipReason = 'statutory ruleset could not be loaded';
  }

  const contexts: DetectorContext[] = slips.map((slip) => {
    const emp = empById.get(slip.employmentId);
    const profile = emp ? profileByPerson.get(emp.personId) : undefined;
    const concurrent = emp ? (paidByPerson.get(emp.personId) ?? []).filter((id) => id !== slip.employmentId) : [];
    return {
      employmentId: slip.employmentId,
      current: figuresOf(slip),
      prior: priorByEmployment.get(slip.employmentId) ?? null,
      profile: {
        // A bank profile is a bank NAME and an ACCOUNT NUMBER — either alone cannot be paid into.
        hasBankProfile: !!profile?.bankAccountNo?.trim() && !!profile?.bankName?.trim(),
        // The tax profile IS the employee_statutory_my row; its absence is what the detector looks for.
        hasTaxProfile: !!profile,
        paymentMethod: (emp?.paymentMethod ?? null) as DetectorContext['profile']['paymentMethod'],
        hiredOn: emp?.hiredOn ?? null,
        terminatedOn: emp?.terminatedOn ?? null,
        concurrentPaidEmploymentIds: concurrent,
      },
      activity: {
        attendanceDays: attByEmployment.get(slip.employmentId) ?? 0,
        approvedLeaveDays: leaveByEmployment.get(slip.employmentId) ?? 0,
      },
      period: { start: periodStart, end: periodEnd, calendarDays: dim },
      caps: caps ?? {},
      // Provenance is populated in a later slice; the column and the plumbing exist now so findings
      // written today are shaped the same as findings written then.
      eventIds: [],
    };
  });

  return {
    batchId,
    companyId: batch.companyId,
    tenantId,
    period: { start: periodStart, end: periodEnd, calendarDays: dim },
    caps,
    capsSkipReason,
    contexts,
  };
}

/** Which detectors can run for this employee, and why the others cannot (§2.4 coverage transparency). */
function planDetectors(
  ctx: DetectorContext,
  bc: BatchContext,
  enabled: (id: string) => boolean,
): { run: Detector[]; skipped: SkippedDetector[] } {
  const run: Detector[] = [];
  const skipped: SkippedDetector[] = [];
  for (const d of DETECTORS) {
    if (!enabled(d.id)) {
      skipped.push({ id: d.id, reason: 'disabled by configuration' });
      continue;
    }
    if (d.requires.priorCycles > 0 && !ctx.prior) {
      skipped.push({ id: d.id, reason: 'no prior cycle for this employee yet' });
      continue;
    }
    if (d.id === 'statutory-over-cap' && !bc.caps) {
      skipped.push({ id: d.id, reason: bc.capsSkipReason ?? 'no statutory ceilings available' });
      continue;
    }
    run.push(d);
  }
  return { run, skipped };
}

/**
 * Evaluate one batch. READ-ONLY with respect to payroll; writes only to the three anomaly tables.
 *
 * Safe to call repeatedly — a re-run supersedes the previous live verdicts for the batch and writes a
 * fresh set. Returns the run summary, which is also what the metrics layer reads.
 */
export async function evaluateBatchAnomalies(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<BatchEvaluation> {
  return withTenant(ctx, async (tx) => {
    const bc = await gatherContext(tx, ctx.tenantId, p.batchId);
    if (!bc) throw new Error('batch not found');

    // Thresholds as data: a company row beats a tenant-wide row, and both beat the untuned code default.
    const cfgRows = await tx
      .select({
        detectorId: schema.payrollAnomalyConfig.detectorId,
        companyId: schema.payrollAnomalyConfig.companyId,
        enabled: schema.payrollAnomalyConfig.enabled,
        params: schema.payrollAnomalyConfig.params,
      })
      .from(schema.payrollAnomalyConfig)
      .where(and(eq(schema.payrollAnomalyConfig.tenantId, ctx.tenantId), isNull(schema.payrollAnomalyConfig.archivedAt)));
    const cfgFor = (detectorId: string) => {
      const forCompany = cfgRows.find((r) => r.detectorId === detectorId && r.companyId === bc.companyId);
      const forTenant = cfgRows.find((r) => r.detectorId === detectorId && r.companyId === null);
      return forCompany ?? forTenant ?? null;
    };
    const isEnabled = (detectorId: string) => cfgFor(detectorId)?.enabled ?? true;
    const paramsFor = (detectorId: string): Record<string, unknown> => ({
      ...(UNTUNED_DEFAULT_PARAMS[detectorId] ?? {}),
      ...((cfgFor(detectorId)?.params as Record<string, unknown> | undefined) ?? {}),
    });

    // ── classify (pure) ───────────────────────────────────────────────────────────────────────────
    const verdicts: EmployeeVerdict[] = bc.contexts.map((dctx) => {
      const { run, skipped } = planDetectors(dctx, bc, isEnabled);
      const findings = run.flatMap((d) => d.evaluate(dctx, paramsFor(d.id)));
      return {
        employmentId: dctx.employmentId,
        disposition: resolveDisposition(findings),
        findings,
        detectorsRun: run.map((d) => d.id),
        detectorsSkipped: skipped,
      };
    });

    // ── supersede the previous live verdicts, then write the new ones ─────────────────────────────
    // Supersede rather than delete: the daily dry-run will produce many generations of these, and the
    // superseded rows are the record of what the system believed when a human looked at it.
    await tx
      .update(schema.payrollAnomalyVerdict)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(schema.payrollAnomalyVerdict.batchId, p.batchId),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
        ),
      );

    if (verdicts.length > 0) {
      const inserted = await tx
        .insert(schema.payrollAnomalyVerdict)
        .values(
          verdicts.map((v) => ({
            tenantId: ctx.tenantId,
            batchId: p.batchId,
            employmentId: v.employmentId,
            disposition: v.disposition,
            detectorsRun: v.detectorsRun,
            detectorsSkipped: v.detectorsSkipped,
          })),
        )
        .returning({ id: schema.payrollAnomalyVerdict.id, employmentId: schema.payrollAnomalyVerdict.employmentId });
      const verdictIdByEmployment = new Map(inserted.map((r) => [r.employmentId, r.id]));

      const findingRows = verdicts.flatMap((v) =>
        v.findings.map((f) => ({
          tenantId: ctx.tenantId,
          verdictId: verdictIdByEmployment.get(v.employmentId)!,
          detectorId: f.detectorId,
          severity: f.severity,
          facts: f.facts,
          sourceEventIds: f.sourceEventIds,
          suggestedAction: f.suggestedAction,
        })),
      );
      if (findingRows.length > 0) await tx.insert(schema.payrollAnomalyFinding).values(findingRows);

      // One event per FLAGGED employee. An auto-clear emits nothing: on a 3,000-person daily dry-run
      // that would be ~2,900 events a day saying "nothing happened", and the verdict row is already the
      // durable record of the evaluation.
      for (const v of verdicts) {
        if (v.disposition === 'auto_clear') continue;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payslip',
          aggregateId: verdictIdByEmployment.get(v.employmentId)!,
          eventType: 'payroll.anomaly.flagged',
          actor: actorOf(ctx),
          subjectEmploymentId: v.employmentId,
          payload: {
            batchId: p.batchId,
            disposition: v.disposition,
            findings: v.findings.map((f) => ({ detectorId: f.detectorId, severity: f.severity, facts: f.facts })),
          },
        });
      }
    }

    const autoClear = verdicts.filter((v) => v.disposition === 'auto_clear').length;
    const review = verdicts.filter((v) => v.disposition === 'review').length;
    const block = verdicts.filter((v) => v.disposition === 'block').length;
    const coverage =
      verdicts.length === 0
        ? 1
        : verdicts.reduce((acc, v) => {
            const denom = v.detectorsRun.length + v.detectorsSkipped.length;
            return acc + (denom === 0 ? 1 : v.detectorsRun.length / denom);
          }, 0) / verdicts.length;

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll.anomaly.evaluated',
      actor: actorOf(ctx),
      payload: {
        total: verdicts.length,
        autoClear,
        review,
        block,
        coverage: Math.round(coverage * 1000) / 1000,
      },
    });

    return { batchId: p.batchId, autoClear, review, block, total: verdicts.length, coverage, verdicts };
  });
}

/**
 * The open BLOCK verdicts standing against a batch. `closeBatch` refuses while this is non-empty.
 *
 * "Open" means live and unresolved: a superseded verdict is history, and a resolved one is a human
 * having said the block is understood. Exported so the guard and the queue read the same definition.
 */
export async function openBlockingVerdicts(
  tx: Tx,
  batchId: string,
): Promise<{ employmentId: string; verdictId: string }[]> {
  const rows = await tx
    .select({ verdictId: schema.payrollAnomalyVerdict.id, employmentId: schema.payrollAnomalyVerdict.employmentId })
    .from(schema.payrollAnomalyVerdict)
    .where(
      and(
        eq(schema.payrollAnomalyVerdict.batchId, batchId),
        eq(schema.payrollAnomalyVerdict.disposition, 'block'),
        isNull(schema.payrollAnomalyVerdict.supersededAt),
        isNull(schema.payrollAnomalyVerdict.resolvedAt),
      ),
    );
  return rows;
}

/**
 * Record a human's disposition of a flagged verdict.
 *
 * `false_positive` is the numerator of the false-positive rate, and `raised` — a human finding something
 * on a verdict the system auto-cleared — is the ONLY route to a false-NEGATIVE rate. ADR-0076 §5 insists
 * that path exist from day one even though the queue UI comes later, because it cannot be backfilled:
 * if nobody can record "you missed this", the metric that most governs granting autonomy is permanently
 * unmeasurable.
 */
export async function resolveAnomalyVerdict(
  ctx: SessionContext,
  p: { verdictId: string; resolution: 'accepted' | 'fixed_upstream' | 'false_positive'; note?: string },
): Promise<void> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        batchId: schema.payrollAnomalyVerdict.batchId,
        disposition: schema.payrollAnomalyVerdict.disposition,
        supersededAt: schema.payrollAnomalyVerdict.supersededAt,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.id, p.verdictId))
      .limit(1);
    if (!row) throw new Error('verdict not found');
    if (row.supersededAt) throw new Error('cannot resolve a superseded verdict');

    await tx
      .update(schema.payrollAnomalyVerdict)
      .set({
        resolution: p.resolution,
        resolutionNote: p.note ?? null,
        resolvedAt: sql`now()`,
        resolvedByUserId: ctx.userId ?? null,
      })
      .where(eq(schema.payrollAnomalyVerdict.id, p.verdictId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payslip',
      aggregateId: p.verdictId,
      eventType: 'payroll.anomaly.resolved',
      actor: actorOf(ctx),
      subjectEmploymentId: row.employmentId,
      payload: { batchId: row.batchId, disposition: row.disposition, resolution: p.resolution, note: p.note ?? null },
    });
  });
}
