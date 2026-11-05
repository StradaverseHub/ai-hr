/** ADR-0170 §11.3 change 4 — runs every ratchet case through the product turn runner (core/harness/runner.ts)
 * with a scripted model and fictional tools. No database and no provider. */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {HARNESS_SPEC} from '../../core/harness/spec';
import {HARNESS_TEST_ONLY,runTurn} from '../../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../../core/harness/memory';
import {RATCHET_CASES,RATCHET_FLOORS,type RatchetCase,type RatchetSource} from './cases';
import {fakeTools} from './fake-tools';
import {scriptedModel} from './scripted-model';

const caller=(persona:RatchetCase['persona']):SessionContext=>({tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',
 personId:'00000000-0000-4000-8000-0000000000cc',roles:[persona==='admin'?'hr_admin':'employee'],grants:[{role:persona==='admin'?'hr_admin':'employee',companyId:null}]});
const PRIVATE_CONTEXT=new Set(['approval_queue','setup_readiness','company_setup']);

describe('harness ratchet',()=>{
 it('keeps every source at or above its floor, with unique ids',()=>{
  expect(new Set(RATCHET_CASES.map(row=>row.id)).size).toBe(RATCHET_CASES.length);
  for(const [source,floor] of Object.entries(RATCHET_FLOORS) as [RatchetSource,number][])
   expect(RATCHET_CASES.filter(row=>row.source===source).length,source).toBeGreaterThanOrEqual(floor);
 });
 for(const item of RATCHET_CASES)it(item.id,async()=>{
  const {provider,dispatched}=fakeTools({admin:item.persona==='admin',poisonLeaveType:item.poisonLeaveType}),model=scriptedModel(item.script);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:caller(item.persona),conversationId:item.id,question:item.question,scope:{companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'},
   model,memory:new InMemoryTaskMemoryStore(),tools:provider,clock:()=>new Date('2026-11-02T04:00:00Z')});
  const {expect:want,id}=item,trace=result.trace;
  // Always: never blank, and the offer is identical on every request (nothing a tool returned widened it).
  expect(result.reply.trim(),id).not.toBe('');
  const offers=model.requests.filter(request=>request.tools.length>1).map(request=>request.tools.map(tool=>tool.name).join(','));
  expect(new Set(offers).size,id).toBeLessThanOrEqual(1);
  if(want.gate)expect(trace.gate.privateReads?'open':trace.gate.reason,id).toBe(want.gate);
  if(want.noPrivateReads)expect(result.reads.filter(read=>!HARNESS_SPEC.offer.publicContextTools.includes(read as never)||PRIVATE_CONTEXT.has(read)),id).toEqual([]);
  if(want.noSuggestion)expect(result.suggestion,id).toBeNull();
  for(const never of want.neverDispatched??[])expect(dispatched.filter(row=>row.tool===never.tool&&(!never.keys||never.keys.some(key=>key in row.input))),id+' '+never.tool).toEqual([]);
  if(want.fenced){
   for(const request of model.requests)for(const message of request.messages){
    if(message.role==='tool')continue;
    expect(String(message.content??'').includes(want.fenced),id+' outside a fence').toBe(false);
   }
   const tools=model.requests.flatMap(request=>request.messages).filter(message=>message.role==='tool').map(message=>message.content);
   const carrying=tools.filter(content=>content.includes(JSON.stringify(want.fenced).slice(1,-1)));
   expect(carrying.length,id+' poisoned record reached the model').toBeGreaterThan(0);
   for(const content of carrying)expect(content,id).toMatch(/^<<untrusted-data tool="[a-z_]+" nonce="([\w-]+)"[^>]*>>\n[\s\S]*\n<<end-untrusted-data nonce="\1">>$/);
  }
  if(want.fallback){expect(trace.outcome.fallback,id).toBe(true);expect(result.reply,id).toBe(HARNESS_SPEC.replyChecks.fallbackReply);}
  for(const figure of want.neverSent??[])for(const request of model.requests)expect(JSON.stringify(request.messages).includes(figure),id+' sent '+figure).toBe(false);
 });
});
