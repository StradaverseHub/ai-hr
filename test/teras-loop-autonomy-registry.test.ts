/** AI v2 Phase 2 P2-1 — the agent registry and the capability inventory say exactly what each loop can do at each
 * level, and stay in step with the cap in code (core/loops/autonomy.ts) and the automatic steps actually built
 * (core/loops/act.ts). No database. */
import {describe,expect,it} from 'vitest';
import {registeredWorker,registeredWorkers,workerDeclarationProblems} from '../core/agent-registry/workers';
import {AGENT_LOOP_LEVELS} from '../lib/ai/agent-capability-inventory';
import {LOOP_AUTONOMY,promotableTo} from '../core/loops/autonomy';
import {ACTING_LOOPS} from '../core/loops/act';
import {LOOP_IDS} from '../core/loops/types';

describe('what each loop can do at each level',()=>{
 it('the registry ceiling and automatic step match the cap in code and the steps built, for every loop',()=>{
  expect(Object.fromEntries(LOOP_IDS.map(id=>{const autonomy=registeredWorker(id)!.autonomy!;return [id,[autonomy.ceiling,autonomy.act!==null]];}))).toEqual({
   loop_probation_ending:[1,false],loop_payroll_inputs:[1,false],loop_missing_employee_data:[3,true],loop_missed_clock_outs:[3,true],loop_document_expiry:[1,false]});
  for(const id of LOOP_IDS){
   const autonomy=registeredWorker(id)!.autonomy!;
   expect(autonomy.ceiling,id).toBe(promotableTo(id));
   expect(autonomy.act!==null,id).toBe(LOOP_AUTONOMY[id].actor&&promotableTo(id)>1);
   expect(ACTING_LOOPS.includes(id),id).toBe(autonomy.act!==null);
  }
 });
 it('the inventory names each level the loop may reach, and no level above its cap',()=>{
  expect(Object.keys(AGENT_LOOP_LEVELS).sort()).toEqual([...LOOP_IDS].sort());
  for(const id of LOOP_IDS){
   const levels=AGENT_LOOP_LEVELS[id] as Readonly<Record<string,string>>;
   expect(Object.keys(levels).map(Number).sort(),id).toEqual(Array.from({length:promotableTo(id)+1},(_,level)=>level));
   for(const text of Object.values(levels))expect(text.trim().length,id).toBeGreaterThan(10);
  }
  // Pay, employment status, access, discipline and statutory filing loops: Prepare at most.
  for(const id of ['loop_probation_ending','loop_payroll_inputs','loop_document_expiry'] as const){
   expect(Object.keys(AGENT_LOOP_LEVELS[id])).toEqual(['0','1']);
  }
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
