/** Background work lanes (ADR 0181 J1, docs/plans/2026-11-24-database-read-cost-phase-0-1.md). A lane is a named
 * subset of the bulk-job kinds in core/bulk-job-handlers.ts. A worker process started with AIHR_WORKER_LANE serves
 * only its lane, so a payroll run never waits behind an import's units. With AIHR_WORKER_LANE unset a process serves
 * every lane (the behaviour before lanes, and the rollback).
 *
 * This module is the one owner of "which lane runs a kind". It imports nothing, so the web can read it at admission
 * (core/bulk-job.ts) and the release check can read it (scripts/check-import-worker.ts) without loading any handler.
 * Every handler kind is in exactly one lane; test/bulk-job-lanes.test.ts enforces that against BULK_JOB_HANDLERS, so a
 * new kind must be placed here when its handler is added.
 *
 * The singleton ticks (Bank, Individual Transaction, reward plan companies, probation reconciliation) and the Contract
 * schedule admission run only in a process that serves the default lane (an all-lane process does). They stay
 * exactly once through their existing advisory locks and SKIP LOCKED claims either way. */
export const WORKER_LANES=['payroll','tax','import','export','default'] as const;
export type WorkerLane=(typeof WORKER_LANES)[number];

export const BULK_JOB_LANES:Readonly<Record<WorkerLane,readonly string[]>>=Object.freeze({
 // Payroll processing (its settle runs inside the same kind) and payroll history.
 payroll:Object.freeze(['payroll_process','payroll_history']),
 // Tax reprocessing, draft tax readiness and the tax basis group.
 tax:Object.freeze(['payroll_reprocess','payroll_draft_tax_readiness','payroll_tax_basis_group']),
 // File imports that load employee, register, leave, movement, attendance and fixed transaction data, with their
 // checks and reverts (they lock the same records as the import they belong to).
 import:Object.freeze(['employee_import','employee_import_revert','register_import','leave_ledger','movement_import','movement_check',
  'movement_import_revert','clocking_import','fixed_transaction_import']),
 export:Object.freeze(['payroll_transaction_export']),
 // Everything else: leave and TOIL sweeps, rosters, attendance recompute, lifecycle recovery, rewards, contracts and
 // the smaller imports.
 default:Object.freeze(['lifecycle_personnel_completion_preview','lifecycle_personnel_completion_recovery','lifecycle_manager_recovery',
  'reward_plan_reviews','reward_person_history','leave_generation','leave_accrual','leave_recalc','leave_a2c','toil_expiry','toil_year_close',
  'roster_bulk','schedule_group_bulk','attendance_recompute_preview','attendance_recompute','system_label_import','section_import',
  'recruitment_candidate_import','contract_preview','contract_automation','contract_setup','contract_schedule','contract_scheduled_automation',
  'contract_posting_apply']),
});

export const WORKER_LANE_ENV='AIHR_WORKER_LANE';

/** A worker started for lanes also advertises one marker per lane in its heartbeat kinds (bulk_job_worker.kinds), so
 * admission can tell "this lane's worker is live but older than this kind" from "this lane's worker is down" through
 * the existing app.bulk_job_worker_ready, with no SQL change. A marker never names a bulk_job_kind row. */
export const LANE_MARKER_PREFIX='lane:';
export const laneMarker=(lane:WorkerLane)=>`${LANE_MARKER_PREFIX}${lane}`;

/** Every kind this build knows, in lane order. */
export const BULK_JOB_LANE_KINDS:readonly string[]=Object.freeze(WORKER_LANES.flatMap(lane=>BULK_JOB_LANES[lane]));

const laneByKind=new Map<string,WorkerLane>(WORKER_LANES.flatMap(lane=>BULK_JOB_LANES[lane].map(kind=>[kind,lane] as const)));
export const isLaneKind=(kind:string)=>laneByKind.has(kind);
/** The lane that runs a kind. A kind this build does not list (a test fixture, or a kind from a newer migration)
 * belongs to the default lane, the lane for "everything not listed". */
export function bulkJobLaneOf(kind:string):WorkerLane{return laneByKind.get(kind)??'default';}

/** The lanes a worker process serves: AIHR_WORKER_LANE names one lane; unset (or empty) means all lanes. An unknown
 * value refuses to start with a message naming the setting, before any connection opens. */
export function workerLanesFromEnv(env:Record<string,string|undefined>):readonly WorkerLane[]{
 const raw=env[WORKER_LANE_ENV]?.trim();
 if(!raw)return WORKER_LANES;
 if(!(WORKER_LANES as readonly string[]).includes(raw))throw new Error(`${WORKER_LANE_ENV} must be one of ${WORKER_LANES.join(', ')}, or unset for all lanes.`);
 return [raw as WorkerLane];
}

/** Whether a process serving these lanes runs the singleton ticks (only the default lane does). */
export function lanesRunSingletonTicks(lanes:readonly WorkerLane[]){return lanes.includes('default');}

/** The handlers of the given lanes, in their registration order. Pure: the caller passes BULK_JOB_HANDLERS. */
export function laneHandlers<H extends {kind:string}>(handlers:readonly H[],lanes:readonly WorkerLane[]):H[]{
 const served=new Set(lanes);
 return handlers.filter(handler=>served.has(bulkJobLaneOf(handler.kind)));
}

/** Lane coverage problems for the release check (scripts/check-import-worker.ts): kinds are every bulk_job_kind row, live is each live worker's
 * advertised kinds, declaredLanes is AIHR_WORKER_LANES. */
export function laneCoverageProblems(kinds:readonly string[],live:readonly (readonly string[])[],declaredLanes:readonly string[]):string[]{
 const problems:string[]=[];
 for(const lane of WORKER_LANES){
  const servers=live.filter(advertised=>advertised.includes(laneMarker(lane)));
  if(!servers.length){
   if(declaredLanes.includes(lane))problems.push(`Worker lane "${lane}" is declared in AIHR_WORKER_LANES but no live worker serves it.`);
   continue;
  }
  const expected=kinds.filter(kind=>isLaneKind(kind)&&bulkJobLaneOf(kind)===lane);
  for(const advertised of servers){
   const missing=expected.filter(kind=>!advertised.includes(kind));
   if(missing.length)problems.push(`A live "${lane}" lane worker does not serve ${missing.map(k=>`"${k}"`).join(', ')}: it runs an older release, so these jobs are refused until it is updated.`);
  }
 }
 return problems;
}
