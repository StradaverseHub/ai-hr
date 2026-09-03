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
import { and, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { recordDecision } from './agent-proposal';
import { appendEvent, actorOf } from '../db/events';
import * as schema from '../db/schema';
import { packFor } from '../localization/registry';
import {
  DETECTORS,
  HYPOTHESIS_DETECTOR_ID,
  resolveDisposition,
  type Detector,
  type DetectorContext,
  type Disposition,
  type Finding,
  type PayslipFigures,
  type Severity,
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
  'batch-swing': { batchSwingPct: 15 },
};

/** The run-level circuit breaker's id. Not in DETECTORS — it is not a per-employee detector. */
export const CIRCUIT_BREAKER_ID = 'batch-swing';

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
 * The per-employee contexts for one batch, WITHOUT evaluating anything.
 *
 * ADR-0084 §2.6's hypothesis layer needs the same slice of the run the detectors get — this cycle's
 * figures and the prior one's — but it must run OUTSIDE a transaction, because it calls a provider and
 * writes to the ledger (core/agent-proposal.ts property 2). So it reads through this rather than
 * through `evaluateBatchAnomalies`, which is transactional by design and stays that way.
 *
 * Null when the batch does not exist, matching `gatherContext`.
 */
export async function loadBatchContexts(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<DetectorContext[] | null> {
  return withTenant(ctx, async (tx) => (await gatherContext(tx, ctx.tenantId, p.batchId))?.contexts ?? null);
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
 * Supersede the LIVE verdicts standing against particular employments on a batch. Returns how many moved.
 *
 * 9066bd6c — WHY REMOVAL NEEDS THIS AND REPROCESSING DOES NOT. `evaluateBatchAnomalies` supersedes every
 * live verdict on the batch before writing the new generation, so any path that regenerates the run
 * (reset → draft → process again) is already covered by that alone. Removing one employee's result
 * deliberately leaves the run PROCESSED and regenerates nothing — so without this, an unresolved BLOCK
 * verdict for somebody who no longer has a payslip keeps refusing `closeBatch`: `openBlockingVerdicts`
 * above is keyed on batchId and joins no payslip, and Close is the operator's very next action. The
 * screen would then count an employee who is not on the run as the reason the run cannot be published.
 *
 * SUPERSEDE, NOT DELETE — the same idiom, and the same reason, as a re-evaluation: the row is the record
 * of what the system believed when a human looked at it, and after a removal there is nothing left to
 * recompute it from. The `payroll_anomaly_finding` rows hang off it and are kept with it.
 */
export async function supersedeVerdictsForEmployments(
  tx: Tx,
  p: { batchId: string; employmentIds: string[] },
): Promise<number> {
  if (p.employmentIds.length === 0) return 0;
  const rows = await tx
    .update(schema.payrollAnomalyVerdict)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(schema.payrollAnomalyVerdict.batchId, p.batchId),
        inArray(schema.payrollAnomalyVerdict.employmentId, p.employmentIds),
        isNull(schema.payrollAnomalyVerdict.supersededAt),
      ),
    )
    .returning({ id: schema.payrollAnomalyVerdict.id });
  return rows.length;
}

/**
 * The ledger rows a resolution answers — the ONLY place `anomaly_hypothesis` gets an agreement rate.
 *
 * ⚠️ **IT REFUSES TO GUESS.** A resolution is recorded per VERDICT, not per finding, so it is
 * attributable to a hypothesis only when EVERY finding on that verdict is one. A verdict carrying a rule
 * finding as well tells us nothing about which of them the operator meant, and a misattributed agreement
 * rate is worse than a missing one — it is the number ADR-0084 §2.8 would grant autonomy on.
 * `proposeHypotheses` only ever asks about AUTO-CLEARED employees precisely so this holds by
 * construction; the check is here because "by construction" has to survive the next person.
 *
 * Only UNDECIDED proposals are returned: the first human answer about a given shape is the one that
 * counts, not the last operator to re-resolve a re-materialised copy of it.
 */
async function hypothesisProposalsToStamp(tx: Tx, verdictId: string): Promise<string[]> {
  const findings = await tx
    .select({
      detectorId: schema.payrollAnomalyFinding.detectorId,
      proposalId: schema.payrollAnomalyFinding.proposalId,
    })
    .from(schema.payrollAnomalyFinding)
    .where(eq(schema.payrollAnomalyFinding.verdictId, verdictId));
  if (findings.length === 0) return [];
  if (!findings.every((f) => f.detectorId === HYPOTHESIS_DETECTOR_ID)) return [];
  const ids = findings.map((f) => f.proposalId).filter((x): x is string => x !== null);
  if (ids.length === 0) return [];
  const open = await tx
    .select({ id: schema.agentProposal.id })
    .from(schema.agentProposal)
    .where(and(inArray(schema.agentProposal.id, ids), isNull(schema.agentProposal.decision)));
  return open.map((r) => r.id);
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
  const toStamp = await withTenant(ctx, async (tx) => {
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

    // ADR-0084 §2.3 — which ledger rows this human just answered. Read INSIDE the transaction (it is a
    // read of the verdict being resolved) and stamped OUTSIDE it, below.
    return hypothesisProposalsToStamp(tx, p.verdictId);
  });

  /**
   * ⚠️ **THE ONLY REAL AGREEMENT RATE THE PAYROLL SIDE OF THIS PRODUCT HAS.** `anomaly_narration` has no
   * human decision — nobody approves prose — and `close_fixed_upstream`'s is structurally 1.0 (r236).
   * Here an operator looked at a hypothesis a model raised and said whether it was a real problem, which
   * is precisely ADR-0084 §2.3's `agreement rate` and the first payroll input to §2.8's autonomy test.
   *
   * `false_positive` is the model being WRONG. `accepted` and `fixed_upstream` are both it being right —
   * they differ in what the human then did about it, not in whether there was something to do.
   *
   * OUTSIDE the transaction above: `recordDecision` opens its own (agent-proposal property 2), and a
   * nested `withTenant` holds a second pooled connection for the duration of the outer one.
   */
  const decision = p.resolution === 'false_positive' ? 'declined' : 'approved';
  for (const proposalId of toStamp) await recordDecision(ctx, { proposalId, decision });
}

/**
 * THE RUN-LEVEL CIRCUIT BREAKER (ADR-0076 §4). Total batch net movement against the prior cycle.
 *
 * WHY THIS CANNOT BE A PER-EMPLOYEE DETECTOR, which is the whole reason it exists separately: a global
 * mis-key — the wrong pack version, the wrong period, a rate applied to everyone — moves EVERY employee
 * together. Each individual movement can sit comfortably inside `net-swing`'s threshold while the batch
 * total moves by a third. Per-employee detectors rate that as unremarkable precisely because it is
 * uniform; only the aggregate sees it.
 *
 * IT IS RECOMPUTED, NOT STORED. The comparison is a pure function of two batches' payslip totals, so
 * recomputing at close time is always current and cannot go stale behind a re-run — whereas a stored
 * verdict would have to be superseded in lockstep with every payslip edit. The trade is that there is no
 * per-batch "accepted" row to tick.
 *
 * SO THE ESCAPE HATCH IS THE THRESHOLD ITSELF. A genuine month-end (a bonus run, a group-wide increment)
 * legitimately moves the total, and the operator raises `batchSwingPct` for that company in
 * `payroll_anomaly_config` — a versioned, audited, deploy-free change, which is the entire reason
 * thresholds live in the database. Disabling the row switches the breaker off for that company.
 */
export type CircuitBreakerVerdict = {
  tripped: boolean;
  /** Null when there is no prior cycle to compare against — the breaker self-disables on cycle one. */
  movementPct: number | null;
  thresholdPct: number;
  currentNet: number;
  priorNet: number;
  skippedReason: string | null;
};

export async function evaluateCircuitBreaker(tx: Tx, tenantId: string, batchId: string): Promise<CircuitBreakerVerdict> {
  const [batch] = await tx
    .select({
      companyId: schema.payrollBatch.companyId,
      payPeriod: schema.payrollBatch.payPeriod,
    })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, batchId))
    .limit(1);

  const cfgRows = await tx
    .select({
      companyId: schema.payrollAnomalyConfig.companyId,
      enabled: schema.payrollAnomalyConfig.enabled,
      params: schema.payrollAnomalyConfig.params,
    })
    .from(schema.payrollAnomalyConfig)
    .where(
      and(
        eq(schema.payrollAnomalyConfig.tenantId, tenantId),
        eq(schema.payrollAnomalyConfig.detectorId, CIRCUIT_BREAKER_ID),
        isNull(schema.payrollAnomalyConfig.archivedAt),
      ),
    );
  const cfg =
    cfgRows.find((r) => batch && r.companyId === batch.companyId) ?? cfgRows.find((r) => r.companyId === null) ?? null;
  const thresholdPct = num((cfg?.params as Record<string, unknown>)?.batchSwingPct) || 15;

  const blank: CircuitBreakerVerdict = {
    tripped: false,
    movementPct: null,
    thresholdPct,
    currentNet: 0,
    priorNet: 0,
    skippedReason: null,
  };
  if (!batch) return { ...blank, skippedReason: 'batch not found' };
  if (cfg && cfg.enabled === false) return { ...blank, skippedReason: 'disabled by configuration' };

  const netOf = async (id: string): Promise<number> => {
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${schema.payslip.netPay}), 0)::float8` })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, id));
    return num(row?.total);
  };

  const [priorBatch] = await tx
    .select({ id: schema.payrollBatch.id })
    .from(schema.payrollBatch)
    .where(
      and(eq(schema.payrollBatch.companyId, batch.companyId), lt(schema.payrollBatch.payPeriod, batch.payPeriod)),
    )
    .orderBy(sql`${schema.payrollBatch.payPeriod} desc`)
    .limit(1);
  if (!priorBatch) return { ...blank, skippedReason: 'no prior cycle to compare against' };

  const [currentNet, priorNet] = [await netOf(batchId), await netOf(priorBatch.id)];
  // A prior cycle that paid nothing gives no meaningful percentage; the per-employee detectors own that.
  if (priorNet === 0) return { ...blank, currentNet, skippedReason: 'prior cycle net was zero' };

  const movementPct = ((currentNet - priorNet) / Math.abs(priorNet)) * 100;
  return {
    tripped: Math.abs(movementPct) > thresholdPct,
    movementPct: Math.round(movementPct * 10) / 10,
    thresholdPct,
    currentNet,
    priorNet,
    skippedReason: null,
  };
}

/**
 * ADR-0076 §5 — the instrumentation. These are the numbers ADR-0074's success is defined in, and the
 * reason Phase 1a ships them even though early figures will be small and dull: nobody currently knows
 * the baseline, so no autonomy claim downstream can be grounded in anything.
 *
 * COVERAGE IS REPORTED BESIDE THE AUTO-CLEAR RATE, ALWAYS. A 100% auto-clear rate on 40% coverage is not
 * a clean bill of health, it is a thin one, and separating the two numbers is what stops the first from
 * being read as the second.
 */
export type AnomalyMetrics = {
  batchId: string;
  total: number;
  autoClear: number;
  review: number;
  block: number;
  /** autoClear / total. The ADR-0074 headline; target >= 0.95. */
  autoClearRate: number;
  /** detectorsRun / (run + skipped), averaged. Read this BEFORE trusting autoClearRate. */
  coverage: number;
  /** (review + block) / total * 1000. ADR-0074 target <= 50. */
  flaggedPerThousand: number;
  /** resolution = 'false_positive' over all flagged-and-resolved verdicts. */
  falsePositiveRate: number | null;
  /** Median seconds between computedAt and resolvedAt for resolved flags. ADR-0074 target < 300s. */
  mttrSeconds: number | null;
  /** Flagged verdicts a human has not yet dispositioned. */
  unresolvedFlagged: number;
};

export async function anomalyMetrics(ctx: SessionContext, p: { batchId: string }): Promise<AnomalyMetrics> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        disposition: schema.payrollAnomalyVerdict.disposition,
        detectorsRun: schema.payrollAnomalyVerdict.detectorsRun,
        detectorsSkipped: schema.payrollAnomalyVerdict.detectorsSkipped,
        computedAt: schema.payrollAnomalyVerdict.computedAt,
        resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
        resolution: schema.payrollAnomalyVerdict.resolution,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(
        and(
          eq(schema.payrollAnomalyVerdict.batchId, p.batchId),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
        ),
      );

    const total = rows.length;
    const autoClear = rows.filter((r) => r.disposition === 'auto_clear').length;
    const review = rows.filter((r) => r.disposition === 'review').length;
    const block = rows.filter((r) => r.disposition === 'block').length;
    const flagged = rows.filter((r) => r.disposition !== 'auto_clear');
    const resolvedFlags = flagged.filter((r) => r.resolvedAt != null);

    const coverage =
      total === 0
        ? 1
        : rows.reduce((acc, r) => {
            const ran = (r.detectorsRun as string[] | null)?.length ?? 0;
            const skipped = (r.detectorsSkipped as unknown[] | null)?.length ?? 0;
            return acc + (ran + skipped === 0 ? 1 : ran / (ran + skipped));
          }, 0) / total;

    const durations = resolvedFlags
      .map((r) => (r.resolvedAt!.getTime() - r.computedAt.getTime()) / 1000)
      .sort((x, y) => x - y);
    const median = durations.length
      ? durations.length % 2
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2
      : null;

    return {
      batchId: p.batchId,
      total,
      autoClear,
      review,
      block,
      autoClearRate: total === 0 ? 1 : autoClear / total,
      coverage,
      flaggedPerThousand: total === 0 ? 0 : ((review + block) / total) * 1000,
      falsePositiveRate: resolvedFlags.length
        ? resolvedFlags.filter((r) => r.resolution === 'false_positive').length / resolvedFlags.length
        : null,
      mttrSeconds: median,
      unresolvedFlagged: flagged.length - resolvedFlags.length,
    };
  });
}

/**
 * Has the evaluator ever written a live verdict for this batch?
 *
 * The circuit breaker's additivity gate. The per-employee guard is inherently additive because it reads
 * stored verdicts and finds none on an un-evaluated batch; the breaker is recomputed from payslip totals
 * and would happily fire on a batch this layer has never seen. This is what stops it.
 */
export async function anomalyEvaluated(tx: Tx, batchId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.payrollAnomalyVerdict.id })
    .from(schema.payrollAnomalyVerdict)
    .where(
      and(eq(schema.payrollAnomalyVerdict.batchId, batchId), isNull(schema.payrollAnomalyVerdict.supersededAt)),
    )
    .limit(1);
  return !!row;
}

/** One row of the exceptions queue: the verdict, its findings, and enough identity to act on it. */
export type QueueRow = {
  verdictId: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  disposition: Disposition;
  computedAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
  detectorsRunCount: number;
  detectorsSkipped: SkippedDetector[];
  /** `narrative` is ADR-0076 §2.6's optional prose: null until an operator asks for it, and null forever
   *  for a tenant with no AI provider. The facts beside it are the evidence and never depend on it. */
  findings: {
    id: string;
    detectorId: string;
    severity: Severity;
    facts: Record<string, string | number>;
    suggestedAction: string;
    narrative: string | null;
  }[];
};

/**
 * ADR-0074 — THE EXCEPTIONS QUEUE ACROSS EVERY RUN, which is the shape "the analyst's whole day"
 * actually has.
 *
 * ⚠️ **WHY THIS EXISTS, MEASURED ON PRODUCTION RATHER THAN ASSUMED.** 81 flagged verdicts were sitting
 * live and unresolved across **23 different batches**, and NOT ONE had ever been dispositioned. The
 * reason is structural, not negligence: the only place to resolve one was
 * `/payroll/<batchId>/anomalies`, so clearing that queue meant twenty-three separate visits, and the
 * Control Tower — which is the screen an operator actually opens — listed the RUNS and linked into each.
 *
 * **AND THAT IS WHAT HAS BEEN BLOCKING THE TOWER'S OWN HEADLINE.** `falsePositiveRate` and `mttrSeconds`
 * are structurally NULL until a human dispositions a flag, and `impliedOperators` refuses to print
 * without them (ADR-0074 §5, core/control-tower.ts). The staffing answer the owner keeps asking for has
 * been waiting on a human signal that the product made expensive to give. A per-run queue is also the
 * payroll noun leaking through a control plane that ADR-0083 says is not about payroll.
 *
 * ONE READER, ONE ROW SHAPE. This returns `QueueRow` — the same shape `anomalyQueue` returns and the
 * same shape the per-run screen renders — plus the run each row came from, because out of its own batch
 * a row has to say which period it belongs to. A second row shape here is how the two screens would come
 * to describe the same verdict differently.
 *
 * WORST FIRST, THEN OLDEST FIRST. Blocks stop a run from closing, so they outrank reviews; within a
 * severity the longest-waiting comes first, because the metric this unblocks is time-to-resolution and a
 * queue that buries the oldest item optimises against its own measurement.
 */
/** A queue row plus the run it came from — out of its own batch, a row has to say which period it is. */
export type OpenExceptionRow = QueueRow & { payPeriod: string; batchId: string };

export async function openExceptionsAcrossRuns(
  ctx: SessionContext,
  p?: { limit?: number },
): Promise<{ rows: OpenExceptionRow[]; total: number; cappedOut: boolean }> {
  const limit = p?.limit ?? 100;
  return withTenant(ctx, async (tx) => {
    const verdicts = await tx
      .select({
        verdictId: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        batchId: schema.payrollAnomalyVerdict.batchId,
        disposition: schema.payrollAnomalyVerdict.disposition,
        computedAt: schema.payrollAnomalyVerdict.computedAt,
        resolution: schema.payrollAnomalyVerdict.resolution,
        resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
        detectorsRun: schema.payrollAnomalyVerdict.detectorsRun,
        detectorsSkipped: schema.payrollAnomalyVerdict.detectorsSkipped,
        employeeName: schema.person.fullName,
        employeeCode: schema.employment.employeeCode,
        payPeriod: schema.payrollBatch.payPeriod,
      })
      .from(schema.payrollAnomalyVerdict)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.payrollAnomalyVerdict.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payrollAnomalyVerdict.batchId))
      .where(
        and(
          // LIVE only: a superseded verdict is what the system believed before the last re-evaluation,
          // and resolving one would stamp a judgement on a reading nobody is looking at.
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          // UNRESOLVED only. This queue is work outstanding; what has been decided belongs to its run.
          isNull(schema.payrollAnomalyVerdict.resolvedAt),
          // Auto-cleared rows are excluded HERE and deliberately, unlike the per-run screen which lists
          // them so a human can raise a false negative. That affordance is per-run by nature — it needs
          // the whole run in front of you to notice an omission — and a cross-run list of everything the
          // system cleared would be thousands of rows nobody is being asked to act on.
          ne(schema.payrollAnomalyVerdict.disposition, 'auto_clear'),
        ),
      );
    if (verdicts.length === 0) return { rows: [], total: 0, cappedOut: false };

    const rank: Record<string, number> = { block: 0, review: 1, auto_clear: 2 };
    const ordered = verdicts.sort((x, y) => {
      const d = (rank[x.disposition] ?? 9) - (rank[y.disposition] ?? 9);
      if (d !== 0) return d;
      return x.computedAt.getTime() - y.computedAt.getTime();
    });
    // ⚠️ CAPPED, AND THE COUNT IS RETURNED SO THE SCREEN CAN SAY SO. A page that silently shows the first
    // hundred of nine hundred reads as a queue somebody has nearly finished (AGENTS: no silent caps).
    const page = ordered.slice(0, limit);

    // One read for every finding on the page, then grouped in memory — the same no-N+1 discipline
    // `anomalyQueue` follows, for the same reason.
    const findings = await tx
      .select({
        id: schema.payrollAnomalyFinding.id,
        verdictId: schema.payrollAnomalyFinding.verdictId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
        severity: schema.payrollAnomalyFinding.severity,
        facts: schema.payrollAnomalyFinding.facts,
        suggestedAction: schema.payrollAnomalyFinding.suggestedAction,
        narrative: schema.payrollAnomalyFinding.narrative,
      })
      .from(schema.payrollAnomalyFinding)
      .where(
        inArray(
          schema.payrollAnomalyFinding.verdictId,
          page.map((v) => v.verdictId),
        ),
      );
    const byVerdict = new Map<string, QueueRow['findings']>();
    for (const f of findings) {
      const list = byVerdict.get(f.verdictId) ?? [];
      list.push({
        id: f.id,
        detectorId: f.detectorId,
        severity: f.severity as Severity,
        facts: (f.facts ?? {}) as Record<string, string | number>,
        suggestedAction: f.suggestedAction,
        narrative: f.narrative,
      });
      byVerdict.set(f.verdictId, list);
    }

    return {
      rows: page.map((v) => ({
        verdictId: v.verdictId,
        employmentId: v.employmentId,
        employeeName: v.employeeName,
        employeeCode: v.employeeCode,
        disposition: v.disposition as Disposition,
        computedAt: v.computedAt,
        resolution: v.resolution,
        resolvedAt: v.resolvedAt,
        detectorsRunCount: (v.detectorsRun as string[] | null)?.length ?? 0,
        detectorsSkipped: (v.detectorsSkipped as SkippedDetector[] | null) ?? [],
        findings: byVerdict.get(v.verdictId) ?? [],
        payPeriod: v.payPeriod,
        batchId: v.batchId,
      })),
      total: ordered.length,
      cappedOut: ordered.length > page.length,
    };
  });
}

/**
 * The exceptions queue for one batch — the analyst's whole day, in ADR-0074's terms.
 *
 * ORDERED WORST-FIRST AND UNRESOLVED-FIRST, because the queue's job is to be worked top-down: blocks stop
 * the run from closing, reviews do not, and anything already dispositioned is history. Auto-cleared
 * verdicts are included but sort last — they are the denominator of the auto-clear rate and the only place
 * a human can raise a FALSE NEGATIVE, which ADR-0076 §5 says must be possible from day one.
 */
export async function anomalyQueue(ctx: SessionContext, p: { batchId: string }): Promise<QueueRow[]> {
  return withTenant(ctx, async (tx) => {
    const verdicts = await tx
      .select({
        verdictId: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        disposition: schema.payrollAnomalyVerdict.disposition,
        computedAt: schema.payrollAnomalyVerdict.computedAt,
        resolution: schema.payrollAnomalyVerdict.resolution,
        resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
        detectorsRun: schema.payrollAnomalyVerdict.detectorsRun,
        detectorsSkipped: schema.payrollAnomalyVerdict.detectorsSkipped,
        employeeName: schema.person.fullName,
        employeeCode: schema.employment.employeeCode,
      })
      .from(schema.payrollAnomalyVerdict)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.payrollAnomalyVerdict.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .where(
        and(
          eq(schema.payrollAnomalyVerdict.batchId, p.batchId),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
        ),
      );
    if (verdicts.length === 0) return [];

    // One read for every finding in the batch, then grouped in memory — the same no-N+1 discipline the
    // evaluator follows, for the same reason: this page must open for a 3,000-person run.
    const findings = await tx
      .select({
        id: schema.payrollAnomalyFinding.id,
        verdictId: schema.payrollAnomalyFinding.verdictId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
        severity: schema.payrollAnomalyFinding.severity,
        facts: schema.payrollAnomalyFinding.facts,
        suggestedAction: schema.payrollAnomalyFinding.suggestedAction,
        narrative: schema.payrollAnomalyFinding.narrative,
      })
      .from(schema.payrollAnomalyFinding)
      .where(
        inArray(
          schema.payrollAnomalyFinding.verdictId,
          verdicts.map((v) => v.verdictId),
        ),
      );
    const byVerdict = new Map<string, QueueRow['findings']>();
    for (const f of findings) {
      const list = byVerdict.get(f.verdictId) ?? [];
      list.push({
        id: f.id,
        detectorId: f.detectorId,
        severity: f.severity as Severity,
        facts: (f.facts ?? {}) as Record<string, string | number>,
        suggestedAction: f.suggestedAction,
        narrative: f.narrative,
      });
      byVerdict.set(f.verdictId, list);
    }

    const rank: Record<string, number> = { block: 0, review: 1, auto_clear: 2 };
    return verdicts
      .map((v) => ({
        verdictId: v.verdictId,
        employmentId: v.employmentId,
        employeeName: v.employeeName,
        employeeCode: v.employeeCode,
        disposition: v.disposition as Disposition,
        computedAt: v.computedAt,
        resolution: v.resolution,
        resolvedAt: v.resolvedAt,
        detectorsRunCount: (v.detectorsRun as string[] | null)?.length ?? 0,
        detectorsSkipped: (v.detectorsSkipped as SkippedDetector[] | null) ?? [],
        findings: byVerdict.get(v.verdictId) ?? [],
      }))
      .sort((x, y) => {
        const unresolved = Number(x.resolvedAt != null) - Number(y.resolvedAt != null);
        if (unresolved !== 0) return unresolved;
        const d = rank[x.disposition] - rank[y.disposition];
        if (d !== 0) return d;
        return x.employeeName.localeCompare(y.employeeName);
      });
  });
}
