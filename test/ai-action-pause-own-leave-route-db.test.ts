/** WP12 review F2: the per-action pause key through a REAL request to handleConfiguredOwnLeaveBrowserCommand (the real
 *  route composition, HTTP transport and pause scope) against the migrated database. The own-leave store is
 *  substituted by a source that runs exactly the check every own-leave source runs inside its transaction
 *  (assertAiActionUnpausedTx(tx, ctx, 'hr_assistant')), because a real own-leave prepare needs a full leave fixture;
 *  the claim route test exercises real sources. Fictional fixtures only. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
const fixture=vi.hoisted(()=>({ctx:undefined as unknown}));
vi.mock('server-only',()=>({}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
vi.mock('../core/assistant-actions/own-leave-server',()=>({authenticateOwnLeaveBrowserSession:async()=>({ctx:fixture.ctx,locale:'en'})}));
vi.mock('../core/assistant-actions/own-leave-browser',async()=>{
 const {createOwnLeaveBrowserHandler}=await import('../lib/assistant-actions/own-leave-http');
 const {assertAiActionUnpausedTx}=await import('../core/ai-governance');
 const {withTenant}=await import('../db/client');
 const source=async(session:{ctx:never})=>{await withTenant(session.ctx,tx=>assertAiActionUnpausedTx(tx,session.ctx,'hr_assistant'));return{kind:'review_index',reviews:[]};};
 return{createOwnLeaveBrowserCommandHandler:(authenticate:()=>Promise<unknown>,policy?:{publicOrigin:string|undefined})=>
  createOwnLeaveBrowserHandler({authenticate,list:source,prepare:source,reopen:source,confirm:source,discard:source} as never,policy)};
});
import {handleConfiguredOwnLeaveBrowserCommand} from '../core/assistant-actions/own-leave-runtime';
import {setAgentActionPause} from '../core/ai-inventory';
import {assertAiActionUnpausedTx} from '../core/ai-governance';
let b:Base,group:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};fixture.ctx=group;});
const list=async()=>{const r=await handleConfiguredOwnLeaveBrowserCommand(new Request('https://fixture.test/api/assistant/own-leave',{method:'POST',headers:{origin:'https://fixture.test',host:'fixture.test','x-forwarded-host':'fixture.test','content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify({operation:'list'})}));return{status:r.status,body:await r.json()};};

describe('hr_assistant:leave.apply through the own-leave route',()=>{
 it('refuses while leave.apply is paused, ignores a sibling pause, and resumes',async()=>{
  expect(await list()).toEqual({status:200,body:{kind:'review_index',reviews:[]}});
  // A sibling action's pause does not stop own leave.
  await setAgentActionPause(group,'leave.cancel',true);
  expect((await list()).status).toBe(200);
  await setAgentActionPause(group,'leave.apply',true);
  const refused=await list();
  expect(refused.status).not.toBe(200);expect(refused.body).toEqual({error:'unavailable'});
  // Outside the route (a native page or chat read) the module pause alone applies.
  await expect(withTenant(group,tx=>assertAiActionUnpausedTx(tx,group,'hr_assistant'))).resolves.toBeUndefined();
  await setAgentActionPause(group,'leave.apply',false);
  expect((await list()).status).toBe(200);
 });
});
