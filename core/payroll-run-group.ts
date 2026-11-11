/**
 * Multi-company payroll run orchestration (feedback 3653d14b, Phase 1).
 *
 * The Payroll Process wizard can now run one, several, or ALL of an administrator's companies in a single
 * initiated action. This module composes the EXISTING per-company primitives — it introduces NO kernel or
 * statutory-computation change: the payroll calculation for any single company is byte-identical to what it
 * was before. The only new behaviour is the loop, the per-company authorization + failure handling, and the
 * run-group summary that feeds the Step-3 result page.
 *
 * Engine reality (see plan §3): `generatePayslips` is all-or-nothing PER BATCH for FAILURE — it throws
 * wholesale on a hard failure and never returns a per-employee failure list. So Phase 1 reports failure at
 * COMPANY granularity (the caught throw, mapped to a reason code) plus the pre-flight "missing salary"
 * signal that already exists on the Step-2 employee row (`hasCurrentCompensation`). Per-employee failure
 * reasons are Phase 2.
 *
 * r226 AMENDS THAT IN EXACTLY ONE DIRECTION, AND IT IS NOT THE FAILURE DIRECTION. The kernel now returns a
 * per-employee SKIP list — the people the run had nothing to pay in that cycle. r369 widened WHICH runs
 * produce one (a regular run now skips an employee with no monthly basic and nothing payable) and changed
 * nothing about how it is reported: the shape, the arithmetic and the rule below are r226's. Skipped
 * is a third outcome beside succeeded and failed: it is counted separately, subtracted out of
 * `totalEmployeesFailed`, and must never be rendered as a failure. The all-or-nothing constraint on
 * FAILURE is untouched.
 *
 * Each company's run is now its own background processing job (core/payroll-processing-job.ts), admitted one
 * company at a time and presented to the user as a single run whose result screen follows the jobs and then
 * shows the same outcomes the synchronous loop reported (core/payroll-run-group-store.ts). HAZARD DISCIPLINE
 * (both covered by tests):
 *   1. Per-company AUTHORIZATION — the submitted company set (and the "all" affordance) is re-intersected
 *      server-side with the admin's actual grants (`allowedCompanies`). A company the admin cannot access
 *      becomes a NOT_AUTHORIZED failure row, never a widened run and never a hard throw.
 *   2. CATCH PER COMPANY — one company failing (typically "already processed this month") must never abort
 *      the run; its throw is mapped to a reason code and the loop continues to the next company.
 */
import { withTenant, type SessionContext } from '../db/client';
import { createAdditionalRun, createBatch } from './payroll';
import { requestPayrollProcessing } from './payroll-processing-job';
import { appendRunGroupEventTx, recordRunGroup, type StoredCompanyOutcome } from './payroll-run-group-store';
import { getActivePayrollCycle, listPayrollCycles } from './payroll-cycle';
import { allowedCompanies, listEmployeesForPayrollRun } from './read';
import { reasonForPayrollError, summarize, type CompanyOutcome, type IntendedRunType, type RunGroupReasonCode, type RunGroupResult } from './payroll-run-group-result';
export * from './payroll-run-group-result';

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). PRE-FLIGHT for the wizard's Validation
 * step: which of the selected companies have NO active cycle of the intended run type. Reuses the EXACT gate
 * the run applies per company (listPayrollCycles active → find runType===intendedRunType), keyed on the actual
 * run runType — so it flags a genuinely un-runnable company (no false positive for a null default that still
 * resolves, no false negative for a default pointing at a different type) BEFORE submit, with the company
 * named. Companies outside the admin's grants are simply dropped (authz is re-checked in the run itself).
 */
export async function companiesMissingCycle(
  ctx: SessionContext,
  companyIds: string[],
  intendedRunType: IntendedRunType,
): Promise<{ companyId: string; companyName: string }[]> {
  const allowed = await allowedCompanies(ctx);
  const allowedById = new Map(allowed.map((c) => [c.id, c.name]));
  const requested = [...new Set(companyIds)].filter(Boolean).filter((id) => allowedById.has(id));
  const missing: { companyId: string; companyName: string }[] = [];
  for (const companyId of requested) {
    const cycle = (await listPayrollCycles(ctx, companyId, { activeOnly: true })).find(
      (c) => c.runType === intendedRunType,
    );
    if (!cycle) missing.push({ companyId, companyName: allowedById.get(companyId)! });
  }
  return missing;
}

export type RunMultiCompanyInput = {
  /** Explicit company ids the admin selected, OR the sentinel handling of "all" done by the caller (the
   *  caller resolves "all" to the scoped set before calling — this module never widens beyond grants). */
  companyIds: string[];
  payPeriod: string;
  /** The cycle id chosen in Step 1 (bound to the PRIMARY company's catalog). Phase 1 uses a single shared
   *  cycle across the selected companies (plan §"Step 1"); since cycle ids are PER-COMPANY, this id only
   *  determines the intended run TYPE (resolved against the primary company), and each company's own active
   *  cycle of that type is resolved server-side below — never trusting one company's id for another. */
  payrollCycleId: string;
  paymentDate?: string;
  /** Explicit employee subset across selected companies. Only an untouched selection means whole-company default. */
  employmentIds: string[];
  /** A touched empty selection is never the implicit whole-company default. */
  explicitSelection?: boolean;
};

/**
 * Run payroll across the authorized subset of the requested companies. Composes createBatch/
 * createAdditionalRun + a background processing job per company (core/payroll-processing-job.ts; it runs the
 * same generation) with per-company authz and per-company failure handling, and records the run group the
 * result screen follows (core/payroll-run-group-store.ts). When the last company's job finishes, the group
 * settles to the same outcomes and appends the ONE run-group DomainEvent for the whole run (substrate
 * discipline: the per-company primitives already append their own batch/period events; this adds the
 * run-level audit record).
 */
export async function startMultiCompanyPayroll(
  ctx: SessionContext,
  input: RunMultiCompanyInput,
): Promise<{ groupId: string }> {
  const run = await executeRunGroup(ctx, input, 'process');
  return { groupId: await recordRunGroup(ctx, { kind: 'run', payPeriod: input.payPeriod, startedAt: run.startedAt, requested: run.requested, outcomes: run.perCompany }) };
}
/** Regular drafts compose the same creation owner, without any generation or reset capability. */
export async function saveMultiCompanyPayrollDrafts(ctx:SessionContext,input:RunMultiCompanyInput):Promise<RunGroupResult> {
  const run = await executeRunGroup(ctx,input,'draft');
  const perCompany = run.perCompany as CompanyOutcome[];
  const endedAt = new Date().toISOString();
  const result = summarize(input.payPeriod, run.startedAt, endedAt, perCompany);
  result.mode='draft';result.totalEmployeesFailed=perCompany.filter(company=>company.status==='failed').reduce((n,company)=>n+company.employeesSelected,0);
  // Substrate: one run-group-level DomainEvent so the multi-company run itself is auditable. Batch/company
  // level (no single employee subject) ⇒ subjectEmploymentId stays null (admin-only read, fail-closed).
  await withTenant(ctx, (tx) => appendRunGroupEventTx(tx, ctx, { mode: 'draft', payPeriod: input.payPeriod, startedAt: run.startedAt, endedAt, requested: run.requested, result }));
  return result;
}
/**
 * Payroll Process wizard — RESUME one existing draft and run it (7076f8af): the run's processing job, recorded as a
 * one-company group so the shared result screen follows it and then reports the outcome exactly as before
 * (succeeded with the run's own counts, or failed with the same reason row). No run-group event, as before.
 */
export async function startResumedPayrollRun(ctx: SessionContext, p: { batchId: string; companyId: string; companyName: string; payPeriod: string; employeesSelected: number }): Promise<{ groupId: string }> {
  const startedAt = new Date().toISOString();
  let outcome: StoredCompanyOutcome;
  try {
    const { jobId } = await requestPayrollProcessing(ctx, { batchId: p.batchId });
    outcome = { status: 'processing', jobId, companyId: p.companyId, companyName: p.companyName, batchId: p.batchId, employeesSelected: p.employeesSelected,
      failed: { employeesSelected: p.employeesSelected, batchId: p.batchId } };
  } catch (e) {
    // A refusal before the job (a run that is no longer a draft, lost authority) renders as a reason row, not a page.
    outcome = { companyId: p.companyId, companyName: p.companyName, status: 'failed', batchId: p.batchId, employeesSelected: p.employeesSelected, employeesSucceeded: 0, reason: reasonForPayrollError(e) };
  }
  return { groupId: await recordRunGroup(ctx, { kind: 'resume', payPeriod: p.payPeriod, startedAt, requested: [p.companyId], outcomes: [outcome] }) };
}
async function executeRunGroup(ctx:SessionContext,input:RunMultiCompanyInput,mode:'draft'|'process'):Promise<{startedAt:string;requested:string[];perCompany:StoredCompanyOutcome[]}> {
  const startedAt = new Date().toISOString();

  // HAZARD 1 — authorize every submitted company id against the admin's ACTUAL grants. The client list is
  // untrusted; a company outside allowedCompanies is dropped to a NOT_AUTHORIZED row, never a widened run.
  const allowed = await allowedCompanies(ctx);
  const allowedById = new Map(allowed.map((c) => [c.id, c.name]));
  const requested = [...new Set(input.companyIds)].filter(Boolean);

  // Determine the INTENDED run type from the Step-1 cycle id (bound to the primary company). Cycle ids are
  // per-company, so we never reuse this id for another company — only its runType. The wizard always
  // submits a selected active cycle; missing/stale selections must never silently become Regular.
  const primaryId = requested.find((id) => allowedById.has(id));
  const primaryCycle=primaryId&&input.payrollCycleId?await getActivePayrollCycle(ctx,input.payrollCycleId,primaryId):null;
  const intendedRunType=primaryCycle?.runType;

  const perCompany: StoredCompanyOutcome[] = [];
  const explicitSelection=input.explicitSelection===true||input.employmentIds.length>0;
  const population=new Map<string,Awaited<ReturnType<typeof listEmployeesForPayrollRun>>>();
  const populationErrors=new Map<string,RunGroupReasonCode>();
  for(const companyId of requested.filter(id=>allowedById.has(id))) {
    try {population.set(companyId,await listEmployeesForPayrollRun(ctx,[companyId],input.payPeriod));}
    catch(error) {populationErrors.set(companyId,reasonForPayrollError(error));}
  }
  const validIds=new Set([...population.values()].flat().map(employee=>employee.employmentId));
  const unmatchedSelection=explicitSelection&&input.employmentIds.some(id=>!validIds.has(id));
  const invalidSelection=unmatchedSelection&&populationErrors.size===0;
  // If a selected ID may belong to an unreadable company, do not silently drop it or mislabel it
  // invalid. Refuse the unproven explicit scope; readable companies with fully proven selections may
  // still proceed, while the unreadable company keeps its own failure outcome.
  const unprovenSelection=unmatchedSelection&&populationErrors.size>0;

  for (const companyId of requested) {
    const companyName = allowedById.get(companyId);
    if (!companyName) {
      // Not in the admin's grants — record and continue (do NOT throw, do NOT widen).
      perCompany.push({
        companyId,
        companyName: companyId,
        status: 'failed',
        employeesSelected: 0,
        employeesSucceeded: 0,
        reason: 'NOT_AUTHORIZED',
      });
      continue;
    }

    try {
      if(!primaryCycle) {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected:0,employeesSucceeded:0,reason:'INVALID_CYCLE'});
        continue;
      }
      if(mode==='draft'&&primaryCycle.runType!=='regular') {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected:0,employeesSucceeded:0,reason:'DRAFT_REQUIRES_REGULAR'});
        continue;
      }
      const populationError=populationErrors.get(companyId);
      if(populationError||unprovenSelection) {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected:0,employeesSucceeded:0,reason:populationError??'SYSTEM_VALIDATION_ERROR'});
        continue;
      }
      // Use the same dated population as the wizard/Generate owner. Never turn an empty explicit
      // per-company subset into undefined scope: that would pay the entire company instead.
      const companyEmps=population.get(companyId)??[];
      const valid=new Set(companyEmps.map(employee=>employee.employmentId));
      const selected=[...new Set(input.employmentIds)].filter(id=>valid.has(id));
      if(invalidSelection||(explicitSelection&&selected.length===0)) {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected:0,employeesSucceeded:0,reason:invalidSelection?'INVALID_SELECTION':'EMPTY_SELECTION'});
        continue;
      }
      const scope=explicitSelection?{employmentIds:selected}:undefined;
      const employeesSelected=scope?selected.length:companyEmps.length;

      // Resolve THIS company's OWN active cycle of the intended run type (cycle ids are per-company, so we
      // never apply the primary company's id here). A company with no active cycle of that type is an
      // INVALID_CYCLE failure for that company, not a run abort. At most one active regular cycle exists per
      // company (enforced at the app level, plan item 2), so the first match is deterministic.
      //
      // c11e81aa — THE OPERATOR'S OWN PICK WINS FOR THE COMPANY IT BELONGS TO. `getActivePayrollCycle`
      // re-validates the id against THIS company and returns null for any other, so the chosen row is used
      // where it is legitimate and the type-based resolution below still covers every other company. This
      // was a latent wart while only `runType`/`remarks` were read off the result — picking "Mid-Month"
      // resolved to whichever off_cycle cycle sorted first, losing both the identity AND the remarks label.
      // It stopped being latent the moment a transaction could name a cycle: the run has to record the
      // cycle the operator actually chose, or a row saved as "Mid-Month" is collected by nobody.
      const chosen = input.payrollCycleId ? await getActivePayrollCycle(ctx, input.payrollCycleId, companyId) : null;
      // Revalidation may observe deactivation after the shared lookup. Never substitute another cycle
      // for the company's own explicit selected row; secondary companies resolve their own same-type row.
      if(companyId===primaryId&&!chosen) {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected,employeesSucceeded:0,reason:'INVALID_CYCLE'});
        continue;
      }
      const cycle =
        chosen ?? (await listPayrollCycles(ctx, companyId, { activeOnly: true })).find((c) => c.runType === intendedRunType);
      if (!cycle) {
        perCompany.push({
          companyId,
          companyName,
          status: 'failed',
          employeesSelected,
          employeesSucceeded: 0,
          reason: 'INVALID_CYCLE',
          // Organization Module (361e3b15) — carry the intended run type so the result page's message names it.
          missingCycleRunType: intendedRunType,
        });
        continue;
      }

      // Additional cycles intentionally allow new run sequences and have no replay identity. This
      // draft course is Regular-only, matching formula OT transfer; never silently substitute a cycle.
      if(mode==='draft'&&cycle.runType!=='regular') {
        perCompany.push({companyId,companyName,status:'failed',employeesSelected,employeesSucceeded:0,reason:'DRAFT_REQUIRES_REGULAR'});
        continue;
      }
      const created =
        cycle.runType === 'regular'
          ? await createBatch(ctx, {
              companyId,
              payPeriod: input.payPeriod,
              scope,
              paymentDate: input.paymentDate || undefined,
              payrollCycleId: cycle.id,
            })
          : await createAdditionalRun(ctx, {
              companyId,
              payPeriod: input.payPeriod,
              runType: cycle.runType,
              remarks: cycle.remarks ?? undefined,
              scope,
              paymentDate: input.paymentDate || undefined,
              // c11e81aa — the run's identity, not just its behaviour. Without it a non-regular run
              // cannot be told from its same-typed siblings and collects no named transaction at all.
              payrollCycleId: cycle.id,
            });

      if(mode==='draft') {
        perCompany.push({companyId,companyName,status:'succeeded',batchId:created.batchId,employeesSelected,employeesSucceeded:0});
        continue;
      }
      // Full draft→processed generation (never the reprocessSubset path) as the run's background processing
      // job; the group settles this company to `succeeded` with the run's own payslip and skip counts (r226/r227:
      // a COUNT only, the names ride the durable event), or to `failed` with the reason its error maps to.
      const { jobId } = await requestPayrollProcessing(ctx, { batchId: created.batchId, after: perCompany.filter(c => c.status === 'processing').map(c => (c as { jobId: string }).jobId) });
      perCompany.push({ status: 'processing', jobId, companyId, companyName, batchId: created.batchId, employeesSelected, failed: { employeesSelected: 0 } });
    } catch (e) {
      // HAZARD 2 — catch PER COMPANY. One company's failure never aborts the others in the run.
      perCompany.push({
        companyId,
        companyName,
        status: 'failed',
        employeesSelected: 0,
        employeesSucceeded: 0,
        reason: reasonForPayrollError(e),
      });
    }
  }

  return { startedAt, requested, perCompany };
}
