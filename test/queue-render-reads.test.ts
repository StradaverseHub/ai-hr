/** ADR 0181 queues addendum Q0: answers derived from one shared owner read per render equal the owner's own answers,
 * modelled on the owners' SQL (6373 contract_shared_work_page, 6687 probation_task_list), and the per-render memo shares
 * only within one render, one session object and one key. The database tests (contract-email-assigned-work-db,
 * probation-pbp-tasks-db) compare the real owners. */
import {describe,expect,it} from 'vitest';
import {CONTRACT_WORK_SHARED_LIMIT,contractWorkItemCategory,deriveContractWorkPage,type ContractWorkItem} from '../core/contract-shared-tasks';
import {PROBATION_TASK_LIST_SHARED_LIMIT,deriveProbationTaskList,type ProbationTaskItem,type ProbationTaskList} from '../core/probation';
import {inRenderReadScope,perRenderRead} from '../lib/request-memo';
import {withRequestReadScope} from '../lib/request-read-scope';

const actions:ContractWorkItem['action'][]=['approval','review','approve','sign','resend','bindEmployee'];
function contractItems(n:number,seed:number):ContractWorkItem[]{
 return Array.from({length:n},(_,i)=>{const r=(seed*31+i*17)%97;return {id:'item-'+i,kind:r%3===0?'contractApproval':'contractLetter',
  subjectName:'Fictional '+i,createdAt:new Date(Date.UTC(2026,10,1)-i*60000).toISOString(),linkPath:'/x/'+i,action:actions[r%actions.length]};});
}
/** The owner (6373): the category is filtered from one ordered list; per-kind counts over the filtered list; the two
 * category totals over the whole list. */
function contractOwner(all:ContractWorkItem[],category:'all'|'approvals'|'tasks',limit:number,offset:number){
 const filtered=category==='all'?all:all.filter(item=>contractWorkItemCategory(item)===category);
 const countsByKind:Partial<Record<ContractWorkItem['kind'],number>>={};
 for(const item of filtered)countsByKind[item.kind]=(countsByKind[item.kind]??0)+1;
 return {items:filtered.slice(offset,offset+limit),total:filtered.length,countsByKind,
  approvalTotal:all.filter(item=>contractWorkItemCategory(item)==='approvals').length,taskTotal:all.filter(item=>contractWorkItemCategory(item)==='tasks').length};
}

describe('Contract work pages derived from the render\'s shared read',()=>{
 it('equal the owner\'s page whenever derived, and derive whenever the shared page can answer exactly',()=>{
  let derivedCount=0;
  for(const n of [0,1,4,19,20,21,99,100,101,137])for(const seed of [1,2,3]){
   const all=contractItems(n,seed),shared=contractOwner(all,'all',CONTRACT_WORK_SHARED_LIMIT,0);
   for(const category of ['all','approvals','tasks'] as const)for(const limit of [1,5,20,100])for(const offset of [0,1,19,95,120]){
    const derived=deriveContractWorkPage(shared,{category,limit,offset});
    const exact=n<=CONTRACT_WORK_SHARED_LIMIT||(category==='all'&&offset+limit<=CONTRACT_WORK_SHARED_LIMIT);
    if(exact){expect(derived,`${n}/${category}/${limit}/${offset}`).toEqual(contractOwner(all,category,limit,offset));derivedCount++;}
    else expect(derived,`${n}/${category}/${limit}/${offset}`).toBeNull();
   }
  }
  expect(derivedCount).toBeGreaterThan(1000);
 });
 it('never derives a company-filtered page',()=>{
  const all=contractItems(3,1);
  expect(deriveContractWorkPage(contractOwner(all,'all',100,0),{category:'all',limit:20,offset:0,companyIds:['00000000-0000-4000-8000-000000000001']})).toBeNull();
 });
});

function probationItems(n:number,seed:number):ProbationTaskItem[]{
 return Array.from({length:n},(_,i)=>({caseId:'c'+String(i).padStart(4,'0'),partId:'p'+i,companyId:'co'+((seed+i)%3),employeeName:'Fictional '+i,kind:'k'+i,
  category:(seed*7+i*5)%4===0?'approval':'task',href:'/p/'+i,dueOn:null,updatedAt:'2026-11-01T00:00:00Z',partType:null}));
}
/** The owner (6687): every category filtered from one ordered task set; `count` all its tasks; `capped` independent of it. */
function probationOwner(all:ProbationTaskItem[],category:'approval'|'task'|null,limit:number,capped:boolean):ProbationTaskList{
 const filtered=category===null?all:all.filter(item=>item.category===category);
 return {count:filtered.length,capped,items:filtered.slice(0,limit)};
}

describe('Probation task lists derived from the render\'s shared read',()=>{
 it('equal the owner\'s list whenever the shared read holds every task, and are not derived otherwise',()=>{
  for(const n of [0,1,7,199,200,201,350])for(const capped of [false,true]){
   const all=probationItems(n,n),shared=probationOwner(all,null,PROBATION_TASK_LIST_SHARED_LIMIT,capped);
   for(const category of [null,'approval','task'] as const)for(const limit of [1,5,200]){
    const derived=deriveProbationTaskList(shared,category,limit);
    if(n<=PROBATION_TASK_LIST_SHARED_LIMIT)expect(derived,`${n}/${category}/${limit}`).toEqual(probationOwner(all,category,limit,capped));
    else expect(derived).toBeNull();
   }
  }
 });
});

describe('perRenderRead',()=>{
 it('reads every call outside a render',async()=>{
  let reads=0;const session={};
  expect(inRenderReadScope()).toBe(false);
  await perRenderRead(session,'k',async()=>++reads);await perRenderRead(session,'k',async()=>++reads);
  expect(reads).toBe(2);
 });
 it('shares one read per render, session object and key, and never across renders or sessions',async()=>{
  let reads=0;const read=async()=>++reads;const one={},other={};
  const first=await withRequestReadScope({},async()=>{
   expect(inRenderReadScope()).toBe(true);
   return Promise.all([perRenderRead(one,'k',read),perRenderRead(one,'k',read),perRenderRead(one,'j',read),perRenderRead(other,'k',read)]);
  });
  expect(first).toEqual([1,1,2,3]);
  expect(await withRequestReadScope({},()=>perRenderRead(one,'k',read))).toBe(4);
 });
 it('drops a failed read so the next caller reads again',async()=>{
  let calls=0;const session={};
  await withRequestReadScope({},async()=>{
   await expect(perRenderRead(session,'k',async()=>{calls++;throw new Error('Fictional failure');})).rejects.toThrow('Fictional failure');
   await Promise.resolve();
   expect(await perRenderRead(session,'k',async()=>{calls++;return 'ok';})).toBe('ok');
  });
  expect(calls).toBe(2);
 });
});
