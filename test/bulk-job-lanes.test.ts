/** ADR 0181 J1: background work lanes. The catalogue (core/bulk-job-lanes.ts) places every bulk-job kind in exactly
 * one lane, a lane process registers only its lane's handlers, only the default lane runs the singleton ticks, the
 * release check reports lane coverage, and the connection budget (db/capacity.ts) counts dedicated lanes. No database:
 * the kernel behaviour over a real queue is test/bulk-job-lanes-kernel.test.ts. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {BULK_JOB_LANES,BULK_JOB_LANE_KINDS,WORKER_LANES,bulkJobLaneOf,isLaneKind,laneCoverageProblems,laneHandlers,laneMarker,lanesRunSingletonTicks,
 workerLanesFromEnv} from '../core/bulk-job-lanes';
import {BACKGROUND_CONNECTIONS_DEFAULT,assertFleetFitsServer,databaseFleetBudget,dedicatedWorkerLanes,workerLaneProcessConnections} from '../db/capacity';
import {pgbouncerSizing} from '../deploy/pgbouncer/render-config.mjs';

const handlerKinds=BULK_JOB_HANDLERS.map(h=>h.kind);

describe('every bulk-job kind is in exactly one lane',()=>{
 it('places each registered handler in one lane and lists no kind without a handler',()=>{
  expect(new Set(handlerKinds).size).toBe(handlerKinds.length);
  const placed=WORKER_LANES.flatMap(lane=>BULK_JOB_LANES[lane]);
  // Disjoint lanes: no kind is listed twice, in one lane or across two.
  expect(new Set(placed).size).toBe(placed.length);
  expect([...placed].sort()).toEqual([...handlerKinds].sort());
  expect([...BULK_JOB_LANE_KINDS].sort()).toEqual([...handlerKinds].sort());
  for(const kind of handlerKinds)expect(WORKER_LANES.filter(lane=>BULK_JOB_LANES[lane].includes(kind)),kind).toHaveLength(1);
 });
 it('keeps the approved lane contents (ADR 0181 J1.1)',()=>{
  expect(BULK_JOB_LANES.payroll).toEqual(['payroll_process','payroll_history']);
  expect(BULK_JOB_LANES.tax).toEqual(['payroll_reprocess','payroll_draft_tax_readiness','payroll_tax_basis_group']);
  expect(BULK_JOB_LANES.export).toEqual(['payroll_transaction_export']);
  for(const kind of ['employee_import','register_import','leave_ledger','movement_import','clocking_import','fixed_transaction_import'])expect(bulkJobLaneOf(kind)).toBe('import');
  // The Contract schedule admission runs inside the bulk tick only where contract_schedule is registered.
  expect(bulkJobLaneOf('contract_schedule')).toBe('default');
  // a1a80747 — the Payroll Process list's outstanding refresh is upkeep: it never waits in front of payroll processing.
  expect(bulkJobLaneOf('payroll_run_outstanding_refresh')).toBe('default');
 });
 it('partitions the handlers: the lanes together register every handler once, in registration order',()=>{
  const perLane=WORKER_LANES.map(lane=>laneHandlers(BULK_JOB_HANDLERS,[lane]));
  expect(perLane.flat().map(h=>h.kind).sort()).toEqual([...handlerKinds].sort());
  expect(laneHandlers(BULK_JOB_HANDLERS,WORKER_LANES)).toEqual([...BULK_JOB_HANDLERS]);
  for(const [i,lane] of WORKER_LANES.entries()){
   expect(perLane[i].length,lane).toBeGreaterThan(0);
   expect(perLane[i].every(h=>bulkJobLaneOf(h.kind)===lane)).toBe(true);
  }
 });
 it('sends an unlisted kind (a fixture, or a kind from a newer migration) to the default lane and never refuses it',()=>{
  expect(isLaneKind('kernel_fixture')).toBe(false);
  expect(bulkJobLaneOf('kernel_fixture')).toBe('default');
  expect(laneMarker('payroll')).toBe('lane:payroll');
  for(const lane of WORKER_LANES)expect(isLaneKind(laneMarker(lane))).toBe(false);
 });
});

describe('a worker process serves AIHR_WORKER_LANE',()=>{
 it('serves every lane when unset (the behaviour before lanes, and the rollback), or exactly one named lane',()=>{
  expect(workerLanesFromEnv({})).toEqual(WORKER_LANES);
  expect(workerLanesFromEnv({AIHR_WORKER_LANE:''})).toEqual(WORKER_LANES);
  expect(workerLanesFromEnv({AIHR_WORKER_LANE:'payroll'})).toEqual(['payroll']);
  expect(workerLanesFromEnv({AIHR_WORKER_LANE:' tax '})).toEqual(['tax']);
  for(const value of ['all','Payroll','payroll,tax','lane:payroll'])expect(()=>workerLanesFromEnv({AIHR_WORKER_LANE:value})).toThrow(/AIHR_WORKER_LANE must be one of/);
 });
 it('runs the Bank, Individual, reward and probation ticks only where the default lane is served',()=>{
  expect(lanesRunSingletonTicks(WORKER_LANES)).toBe(true);
  expect(lanesRunSingletonTicks(['default'])).toBe(true);
  for(const lane of ['payroll','tax','import','export'] as const)expect(lanesRunSingletonTicks([lane])).toBe(false);
 });
 it('wires the worker process through the lane loop: lane handlers only, lane markers, no probation pool outside the default lane',()=>{
  const worker=readFileSync('scripts/lib/worker-lane-process.ts','utf8');
  expect(worker).toContain('const lanes=workerLanesFromEnv(process.env);');
  expect(worker).toContain('const handlers=laneHandlers(BULK_JOB_HANDLERS,lanes);');
  expect(worker).toContain('const probationOwner=singletons?createDb(url,{max:1}):null;');
  expect(worker).toContain('runWorkerLaneIteration({owner,probationOwner,lanes,handlers,ticks,');
  // The ticks are reached only through the lane loop, which gates them on the default lane.
  expect(worker).not.toMatch(/await run(BankImport|IndividualImport|RewardPlanCompany|ProbationReconciliation|BulkJob)Tick\(/);
  expect(worker).not.toContain('{handlers:BULK_JOB_HANDLERS}');
  // The supervisor (AIHR_WORKER_LANES) never loads a handler: the worker module is imported only without it.
  const runner=readFileSync('scripts/bank-import-runner.ts','utf8');
  expect(runner).not.toMatch(/^import .*(bulk-job-handlers|worker-lane-process|db\/client)/m);
  expect(runner).toContain("void import('./lib/worker-lane-process')");
 });
});

describe('the release check covers lanes',()=>{
 const kinds=['payroll_process','payroll_history','employee_import','kernel_fixture'];
 it('accepts a fleet without lane markers (a worker from before lanes) and complete lane workers',()=>{
  expect(laneCoverageProblems(kinds,[kinds],[])).toEqual([]);
  expect(laneCoverageProblems(kinds,[['payroll_process','payroll_history','lane:payroll'],[...kinds,...WORKER_LANES.map(laneMarker)]],['payroll'])).toEqual([]);
 });
 it('reports a live lane worker that lacks a kind of its lane, and a declared lane with no live worker',()=>{
  expect(laneCoverageProblems(kinds,[['payroll_history','lane:payroll']],[])).toEqual([
   'A live "payroll" lane worker does not serve "payroll_process": it runs an older release, so these jobs are refused until it is updated.']);
  expect(laneCoverageProblems(kinds,[[...kinds,'lane:default']],['tax'])).toEqual(['Worker lane "tax" is declared in AIHR_WORKER_LANES but no live worker serves it.']);
  // A kind outside the catalogue is never required of a lane worker.
  expect(laneCoverageProblems(kinds,[['employee_import','lane:import','lane:default']],[])).toEqual([]);
 });
 it('checks lane coverage in the deploy readiness script',()=>{
  const check=readFileSync('scripts/check-import-worker.ts','utf8');
  expect(check).toContain('from bulk_job_kind k left join bulk_job_worker w on k.kind=any(w.kinds)');
  expect(check).toContain('laneCoverageProblems(rows.map(r=>r.kind),live,declared)');
 });
});

describe('dedicated lanes are counted in the connection budget (db/capacity.ts)',()=>{
 const shared={AIHR_APP_WORKERS:'2',AIHR_DB_POOL_MAX:'8',AIHR_DB_TOTAL_CONNECTIONS:'16'};
 it('gives each lane process its queue owner and app pool, and the default lane the probation owner too',()=>{
  expect(workerLaneProcessConnections('default')).toBe(4);
  for(const lane of ['payroll','tax','import','export'] as const)expect(workerLaneProcessConnections(lane)).toBe(3);
  // Five lane processes need the whole default background budget on their own, before any timer, the Entra worker or
  // the report renderer, so dedicated lanes are counted on top of AIHR_DB_BACKGROUND_CONNECTIONS.
  expect(WORKER_LANES.reduce((sum,lane)=>sum+workerLaneProcessConnections(lane),0)).toBe(BACKGROUND_CONNECTIONS_DEFAULT);
 });
 it('keeps a fleet without lanes budgeted exactly as before',()=>{
  expect(databaseFleetBudget(shared)).toEqual({webConnections:16,backgroundConnections:16,workerLaneConnections:0,reservedConnections:5,requiredConnections:37});
  expect(dedicatedWorkerLanes({AIHR_WORKER_LANES:''})).toEqual([]);
 });
 it('adds three connections per declared dedicated lane, and refuses a server that cannot hold them',()=>{
  const lanes={...shared,AIHR_WORKER_LANES:'payroll,tax,import,export'};
  expect(dedicatedWorkerLanes(lanes)).toEqual(['payroll','tax','import','export']);
  expect(databaseFleetBudget(lanes)).toMatchObject({backgroundConnections:16,workerLaneConnections:12,requiredConnections:49});
  expect(assertFleetFitsServer(lanes,{maxConnections:100,superuserReserved:3})).toMatchObject({requiredConnections:49,available:97});
  expect(()=>assertFleetFitsServer(lanes,{maxConnections:50,superuserReserved:3})).toThrow('web 16 + background 16 + worker lanes 12 + reserved 5 = 49, but only 47 are available');
  expect(databaseFleetBudget({...shared,AIHR_WORKER_LANES:' payroll , import '})).toMatchObject({workerLaneConnections:6});
 });
 it('refuses an unknown, repeated or default lane in AIHR_WORKER_LANES',()=>{
  for(const value of ['default','payroll,payroll','payroll;tax','reports','payroll,'])expect(()=>dedicatedWorkerLanes({AIHR_WORKER_LANES:value}),value).toThrow(/AIHR_WORKER_LANES must list distinct lanes/);
 });
 it('leaves the pooler the same server budget the fleet check leaves the web',()=>{
  const inputs={AIHR_DB_CPU_CORES:'4',AIHR_DB_MAX_CONNECTIONS:'100'};
  const before=pgbouncerSizing(inputs).serverBudget,after=pgbouncerSizing({...inputs,AIHR_WORKER_LANES:'payroll,tax,import,export'}).serverBudget;
  expect(before-after).toBe(databaseFleetBudget({AIHR_WORKER_LANES:'payroll,tax,import,export'}).workerLaneConnections);
 });
});
