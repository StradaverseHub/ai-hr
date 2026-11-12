/** The queue reads Today's new panels make, at their owner boundary (core/approvals-inbox.ts pendingTaskSummary):
 *  - Manager Today's Decide excludes notice acknowledgements (the manager's own, never a team decision) and reads the
 *    company switcher's scope;
 *  - Employee Today's "Waiting for your decision" reads exactly what the Tasks page reads (app/tasks/page.tsx: no
 *    company filter, notices included), so the count it shows is the count its "See all" link opens. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({summary:[] as unknown[][]}));
vi.mock('@/db/client',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),withSharedReadSnapshot:async(_s:unknown,work:()=>unknown)=>work(),withBackgroundReadWork:async(_t:string,run:()=>unknown)=>run()}));
vi.mock('@/core/entitlements',()=>{
 class EntitlementsResolutionFailedError extends Error{}
 return {EntitlementsResolutionFailedError,isModuleEnabled:(_s:unknown,code:string)=>code!=='rewards'};
});
vi.mock('@/core/approvals-inbox',()=>({pendingTaskSummary:async(...args:unknown[])=>{calls.summary.push(args.slice(1));
 return {items:[{id:'l1',kind:'leave',subjectName:null,createdAt:'2026-11-01T00:00:00Z',linkPath:'/approvals?category=leave&requestId=l1'}],total:3,claimTotal:2,approvalCount:3};}}));
import {readManagerQueue} from '../components/today/admin/reads';
import {readWaitingForYou} from '../components/today/employee/reads';

const session={tenantId:'fictional-tenant',userId:'fictional-login',roles:['manager']} as never;
beforeEach(()=>{calls.summary=[];});

describe('Today queue reads',()=>{
 it('Manager Today reads the scoped queue without notice acknowledgements',async()=>{
  const queue=await readManagerQueue(session,'co-a,co-b');
  expect(calls.summary).toEqual([[['co-a','co-b'],{attendance:true,claims:true,performance:true,rewards:false},{noticeAcknowledgements:false}]]);
  expect(queue).toMatchObject({approvalTotal:3,failed:false});
  expect(queue.decisions.map(task=>task.id)).toEqual(['l1']);
 });
 it('Employee Today reads the queue exactly as the Tasks page does',async()=>{
  const waiting=await readWaitingForYou(session);
  expect(calls.summary).toEqual([[undefined,{attendance:true,claims:true,performance:true,rewards:false}]]);
  expect(waiting.total).toBe(3);
 });
});
