import { describe, expect, it } from 'vitest';
import { agentBacklogByTier, agentBacklogEntries } from '../lib/ai/agent-capability-inventory';
import { BACKLOG_PROCESS_LINKS, rankAgentBacklog } from '../lib/ai/agent-backlog-ranking';
import { PROCESS_IDS, PROCESS_PROFILES, type ProcessAssessment, type ProcessId } from '../core/process-assessment';
const process=(id:ProcessId,staffActionsPer30:number|null,peopleAffected:number|null,enabled=true):ProcessAssessment=>({
  id,profile:PROCESS_PROFILES[id],enabled,measures:null,role:'measure_first',staffActionsPer30,peopleAffected,
});
const identity=(row:{source:string;entry:string})=>`${row.source}#${row.entry}`;

describe('ranked build list uses process evidence without manufacturing entry usage',()=>{
 it('includes every backlog entry exactly once, with unchanged tier ceilings and complete count reconciliation',()=>{
  const source=agentBacklogEntries(),ranked=rankAgentBacklog([]);
  expect(ranked).toHaveLength(source.length);
  expect(new Set(ranked.map(r=>r.id)).size).toBe(source.length);
  const tiers=agentBacklogByTier();
  for(const tier of ['automatic','confirm','approve'] as const)expect(ranked.filter(r=>r.tier===tier)).toHaveLength(tiers[tier]);
  const original=new Map(source.map(row=>[identity(row),row.tier]));
  for(const row of ranked)expect(row.tier).toBe(original.get(row.id));
  for(const [entry,links] of Object.entries(BACKLOG_PROCESS_LINKS)){
   expect(original.has(entry),entry).toBe(true);
   expect(links.length).toBeGreaterThan(0);
   for(const id of links)expect(PROCESS_IDS).toContain(id);
  }
 });
 it('orders by staff actions first, distinct people second, then a stable source/entry identity',()=>{
  const ranked=rankAgentBacklog([process('leave',12,4),process('claims',12,8),process('profile_change',3,30)]);
  const claims=ranked.find(r=>r.id==='app/(app)/claims/actions.ts#submitClaimAction')!;
  const leave=ranked.find(r=>r.id==='app/(app)/leave/actions.ts#adminCancelLeaveAction')!;
  const profile=ranked.find(r=>r.id==='app/(app)/admin/personnel/profile-changes/actions.ts#decideProfileChangeAction')!;
  expect(claims.rank).toBeLessThan(leave.rank);expect(leave.rank).toBeLessThan(profile.rank);
  const tied=ranked.filter(r=>r.basis==='leave').map(r=>r.id);
  expect(tied).toEqual([...tied].sort());
  expect(ranked.map(r=>r.rank)).toEqual(ranked.map((_,i)=>i+1));
 });
 it('uses the strongest linked process without adding its people or workload to another process',()=>{
  const ranked=rankAgentBacklog([process('leave',10,20),process('claims',30,3)]);
  const shared=ranked.find(r=>r.id==='app/(app)/approvals/actions.ts#bulkDecideAction')!;
  expect(shared).toMatchObject({basis:'claims',staffActionsPer30:30,peopleAffected:3,measurement:'measured'});
 });
 it('keeps zero measured work ahead of unknown work and does not borrow payroll/import/performance counts',()=>{
  const ranked=rankAgentBacklog([process('leave',0,0)]);
  expect(ranked.find(r=>r.id==='app/(app)/leave/actions.ts#adminCancelLeaveAction')).toMatchObject({measurement:'measured',staffActionsPer30:0,peopleAffected:0});
  for(const source of ['app/(app)/payroll/actions.ts','app/(app)/admin/personnel/import/actions.ts','app/(app)/performance/actions.ts']){
   const rows=ranked.filter(r=>r.source===source);
   expect(rows.length).toBeGreaterThan(0);
   expect(rows.every(r=>r.measurement==='outside_baseline'&&r.staffActionsPer30===null&&r.peopleAffected===null)).toBe(true);
  }
  expect(ranked.findIndex(r=>r.measurement==='outside_baseline')).toBeGreaterThan(0);
 });
 it('distinguishes a module that is off from an enabled process whose staff actions are unlinked',()=>{
  const entry='app/(app)/claims/actions.ts#submitClaimAction';
  expect(rankAgentBacklog([process('claims',null,null,false)]).find(r=>r.id===entry)).toMatchObject({measurement:'module_off',staffActionsPer30:null});
  expect(rankAgentBacklog([process('claims',null,5)]).find(r=>r.id===entry)).toMatchObject({measurement:'unlinked',peopleAffected:null});
 });
});
