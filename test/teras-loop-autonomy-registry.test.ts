/** AI v2 Phase 2 P2-1 — the agent registry and the capability inventory say exactly what each loop can do at each
 * level, and stay in step with the cap in code (core/loops/autonomy.ts) and the automatic steps actually built
 * (core/loops/act.ts). No database. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {registeredWorker,registeredWorkers,workerDeclarationProblems} from '../core/agent-registry/workers';
import {AGENT_LOOP_LEVELS} from '../lib/ai/agent-capability-inventory';
import {CAPPED_CATEGORIES,LOOP_AUTONOMY,levelAllowed,maxLevel,promotableTo,touchesCapped} from '../core/loops/autonomy';
import {ACTING_LOOPS} from '../core/loops/act';
import {LOOP_IDS,isLoopId} from '../core/loops/types';

describe('what each loop can do at each level',()=>{
 it('the registry ceiling and automatic step match the cap in code and the steps built, for every loop',()=>{
  expect(Object.fromEntries(LOOP_IDS.map(id=>{const autonomy=registeredWorker(id)!.autonomy!;return [id,[autonomy.ceiling,autonomy.act!==null]];}))).toEqual({
   loop_probation_ending:[1,false],loop_payroll_inputs:[1,false],loop_missing_employee_data:[3,true],loop_missed_clock_outs:[3,true],loop_document_expiry:[1,false],
   // AI v2 P2-2a: the Salary payroll loop (pay) stays at Prepare.
   loop_salary_payroll:[1,false]});
  for(const id of LOOP_IDS){
   const autonomy=registeredWorker(id)!.autonomy!;
   expect(autonomy.ceiling,id).toBe(promotableTo(id));
   expect(autonomy.act!==null,id).toBe(LOOP_AUTONOMY[id].actor&&promotableTo(id)>1);
   expect(ACTING_LOOPS.includes(id),id).toBe(autonomy.act!==null);
  }
 });
 it('the inventory names each level the loop may reach, and no level above its cap',()=>{
  // Every loop the registry runs, the Phase 2 payroll Audit loop (its own runner, not a LoopId) included.
  const loops=registeredWorkers().filter(worker=>worker.record.kind==='loop_runs').map(worker=>worker.id);
  expect(loops).toEqual(expect.arrayContaining([...LOOP_IDS,'loop_payroll_audit']));
  expect(Object.keys(AGENT_LOOP_LEVELS).sort()).toEqual([...loops].sort());
  for(const id of LOOP_IDS){
   const levels=AGENT_LOOP_LEVELS[id] as Readonly<Record<string,string>>;
   expect(Object.keys(levels).map(Number).sort(),id).toEqual(Array.from({length:promotableTo(id)+1},(_,level)=>level));
   for(const text of Object.values(levels))expect(text.trim().length,id).toBeGreaterThan(10);
  }
  // Pay, employment status, access, discipline and statutory filing loops: Prepare at most.
  for(const id of ['loop_probation_ending','loop_payroll_inputs','loop_document_expiry','loop_salary_payroll','loop_payroll_audit'] as const){
   expect(Object.keys(AGENT_LOOP_LEVELS[id])).toEqual(['0','1']);
  }
 });
 // Wave 1 integration: the Prepare-only cap holds for every loop, the Phase 2 Salary payroll and Audit loops included, in
 // the registry, in code and in the database (migration 0963's two CHECKs list the only loops that may act).
 it('the cap holds for every loop: only missed clock-outs and missing employee data may go above Prepare',()=>{
  const loops=registeredWorkers().filter(worker=>worker.record.kind==='loop_runs');
  const acting=['loop_missed_clock_outs','loop_missing_employee_data'];
  expect(loops.map(worker=>worker.id).sort()).toEqual([...LOOP_IDS,'loop_payroll_audit'].sort());
  for(const worker of loops){
   const capped=!acting.includes(worker.id);
   expect(worker.autonomy,worker.id).toEqual(capped?{ceiling:1,act:null}:expect.objectContaining({ceiling:3}));
   expect(worker.effect,worker.id).toBe('prepare');
   if(isLoopId(worker.id)){
    expect(maxLevel(worker.id)>1,worker.id).toBe(!capped);
    for(const level of [2,3])expect(levelAllowed(worker.id,level),worker.id+' '+level).toBe(!capped);
    expect(levelAllowed(worker.id,1),worker.id).toBe(true);
   }
  }
  // Pay, employment status, access, discipline or statutory filing caps a loop whatever its stated ceiling.
  expect(touchesCapped(LOOP_AUTONOMY.loop_salary_payroll.categories)).toBe(true);
  expect(LOOP_AUTONOMY.loop_salary_payroll.categories).toContain('pay');
  for(const category of CAPPED_CATEGORIES)expect(maxLevel('loop_salary_payroll',{categories:[category],ceiling:3,actor:true,criteria:['prepared']}),category).toBe(1);
  // The Audit loop has no level of its own: the level service accepts only a LoopId, so it is refused there.
  expect(isLoopId('loop_payroll_audit')).toBe(false);
  // The database repeats the cap: both CHECKs of 0963 allow a level above Prepare for exactly the two acting loops.
  const sql=readFileSync(new URL('../db/migrations/2004_teras_loop_autonomy.sql',import.meta.url),'utf8');
  const allowed=(name:string)=>{const m=new RegExp(`CONSTRAINT ${name} CHECK \\((?:to_)?level<=1 OR worker_id IN \\(([^)]*)\\)\\)`).exec(sql);
   return (m?.[1]??'').split(',').map(value=>value.trim().replace(/'/g,'')).filter(Boolean).sort();};
  expect(allowed('teras_loop_level_cap')).toEqual([...acting].sort());
  expect(allowed('teras_loop_level_change_cap')).toEqual([...acting].sort());
 });
 it('only a loop declares an autonomy, and a loop must declare one that fits the contract',()=>{
  for(const worker of registeredWorkers())expect(worker.autonomy!==undefined,worker.id).toBe(worker.record.kind==='loop_runs');
  const loop=structuredClone(registeredWorker('loop_missed_clock_outs')!) as unknown as Record<string,unknown>;
  expect(workerDeclarationProblems(loop)).toEqual([]);
  expect(workerDeclarationProblems({...loop,autonomy:undefined})).toContain('autonomy');
  expect(workerDeclarationProblems({...loop,autonomy:{ceiling:3,act:null}})).toContain('autonomy');
  expect(workerDeclarationProblems({...loop,autonomy:{ceiling:1,act:{does:'x',owner:'core/x.ts#y',undo:'z'}}})).toContain('autonomy');
  expect(workerDeclarationProblems({...loop,autonomy:{ceiling:3,act:{does:'Sets it',owner:'not an anchor',undo:'Undo'}}})).toContain('autonomy');
  const other=structuredClone(registeredWorker('claims_triage')!) as unknown as Record<string,unknown>;
  expect(workerDeclarationProblems({...other,autonomy:{ceiling:1,act:null}})).toContain('autonomy');
 });
});
