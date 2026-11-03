/** Spec v23 — the topic tools (core/harness/tools.ts topicBindings over core/semantic-model/topic-tools.ts), with the real
 * capability rows whose runners are replaced by recorders, so what reaches a runner is observed exactly.
 *
 *  1. One tool per family, bound only when the caller is permitted at least one of its topics, and never a folded read.
 *  2. A topic the caller is not permitted is refused not_permitted before any runner; a permitted one runs exactly its
 *     capability.
 *  3. Only the inputs the topic's own read declares reach its runner, each checked against that read's own schema.
 *  4. Through a turn, a topic's result is disclosed under its own read's entity: figures banded, the trace naming the entity.
 * The gates themselves, over real capabilities and modules, are test/harness-topic-tools-gates.test.ts. No database. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {topicBindings,type ToolBinding} from '../core/harness/tools';
import {TERAS_CAPABILITIES,type TerasCapability} from '../core/explainers/capabilities';
import {FOLDED_READS,TOPIC_TOOLS,topicToolSpec} from '../core/semantic-model/topic-tools';
import {TERAS_READS} from '../core/semantic-model/generate';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {scriptedModel} from './harness-ratchet/scripted-model';

const admin:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
afterEach(()=>{vi.unstubAllEnvs();});

type Call=readonly [name:string,input:Record<string,unknown>];
/** The real capability rows named, each running a recorder instead of its owner. */
function recorded(names:readonly string[],result:(name:string)=>Record<string,unknown>=()=>({ok:true})){
 const calls:Call[]=[];
 const capabilities=names.map(name=>{const row=TERAS_CAPABILITIES.find(item=>item.name===name);if(!row)throw Error('Unknown capability '+name);
  return{...row,run:async(_ctx:SessionContext,input:Record<string,unknown>)=>{calls.push([name,{...input}]);return result(name) as never;}} satisfies TerasCapability;});
 return{calls,bindings:topicBindings(admin,capabilities,SCOPE)};
}
const tool=(bindings:readonly ToolBinding[],name:string)=>{const found=bindings.find(binding=>binding.name===name);if(!found)throw Error(name+' is not bound');return found;};
const ALL=[...FOLDED_READS.keys()];

describe('binding',()=>{
 it('binds one tool per family when any of its topics is permitted, and never a folded read on its own',()=>{
  expect(recorded(ALL).bindings.map(binding=>binding.name)).toEqual(['operations_status','explain_why']);
  expect(recorded(['explain_claim_limit']).bindings.map(binding=>binding.name)).toEqual(['explain_why']);
  expect(recorded(['ai_quality_summary']).bindings.map(binding=>binding.name)).toEqual(['operations_status']);
  expect(recorded([]).bindings).toEqual([]);
  // A capability that is no topic (the co-pilot, the pay averages) binds no topic tool.
  expect(recorded(['setup_copilot','pay_aggregates','my_policy_handbook']).bindings).toEqual([]);
  for(const binding of recorded(ALL).bindings){
   expect(binding).toMatchObject({kind:'read',entity:null,identifierInputs:[]});
   expect(binding.spec).toBe(topicToolSpec(binding.name));
   for(const read of ALL)expect(binding.name).not.toBe(read);
  }
 });
 it('names, for each topic, its own read\'s entity, and none for anything else',()=>{
  const {bindings}=recorded(ALL);
  for(const family of TOPIC_TOOLS)for(const row of family.topics)
   expect(tool(bindings,family.name).entityOf!({topic:row.topic}),row.topic).toBe(TERAS_READS.find(read=>read.name===row.read)!.entity);
  expect(tool(bindings,'operations_status').entityOf!({topic:'pay_difference'})).toBeNull();
  expect(tool(bindings,'explain_why').entityOf!({topic:'loops'})).toBeNull();
  expect(tool(bindings,'explain_why').entityOf!({})).toBeNull();
 });
});

describe('gating each topic',()=>{
 it('refuses a topic the caller is not permitted before any runner, and runs a permitted one as its capability',async()=>{
  const {calls,bindings}=recorded(['loops_overview','ai_quality_summary'],name=>({ok:true,from:name}));
  const operations=tool(bindings,'operations_status');
  for(const topic of ['payroll_cycle','salary_payroll','payroll_loop_settings','payroll_audit']){
   const run=await operations.run({topic});
   expect(run,topic).toMatchObject({ok:false,refusal:'not_permitted',content:{ok:false,refusal:'not_permitted'}});
   expect(String((run.content as {message:string}).message)).toMatch(/^This topic is not available to this person here\./);
  }
  expect(calls).toEqual([]);
  expect(await operations.run({topic:'loops'})).toEqual({ok:true,content:{ok:true,from:'loops_overview'}});
  expect(await operations.run({topic:'ai_quality'})).toEqual({ok:true,content:{ok:true,from:'ai_quality_summary'}});
  expect(calls).toEqual([['loops_overview',{}],['ai_quality_summary',{}]]);
  // A capability's own refusal passes through as its own.
  const refusing=recorded(['explain_claim_limit'],()=>({ok:false,refusal:'no_data',message:'No such claim type.'}));
  expect(await tool(refusing.bindings,'explain_why').run({topic:'claim_limit',claim_type:'Fictional Sabbatical'}))
   .toEqual({ok:false,refusal:'no_data',content:{ok:false,refusal:'no_data',message:'No such claim type.'}});
  expect(await tool(refusing.bindings,'explain_why').run({topic:'pay_difference'})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(refusing.calls).toEqual([['explain_claim_limit',{claim_type:'Fictional Sabbatical'}]]);
 });
 it('refuses a topic outside its family as invalid, before any runner',async()=>{
  const {calls,bindings}=recorded(ALL);
  expect(await tool(bindings,'explain_why').run({topic:'loops'})).toMatchObject({ok:false,refusal:'invalid_input'});
  expect(await tool(bindings,'operations_status').run({topic:'claim_limit',claim_type:'Travel'})).toMatchObject({ok:false,refusal:'invalid_input'});
  expect(calls).toEqual([]);
 });
});

describe('inputs',()=>{
 it('passes only the inputs the topic\'s own read declares, each checked against that read\'s own schema',async()=>{
  const {calls,bindings}=recorded(ALL);
  const operations=tool(bindings,'operations_status'),why=tool(bindings,'explain_why');
  expect(await operations.run({topic:'payroll_cycle',period:'2026-07'})).toMatchObject({ok:true});
  // The loops overview takes no input: a period given with it never reaches its runner.
  expect(await operations.run({topic:'loops',period:'2026-07'})).toMatchObject({ok:true});
  expect(await operations.run({topic:'ai_quality',period:'quarter'})).toMatchObject({ok:true});
  expect(await why.run({topic:'claim_limit',claim_type:'Travel',period:'2026-07',date:'2026-07-01'})).toMatchObject({ok:true});
  expect(await why.run({topic:'payslip_statutory',period:'2026-08',item:'epf',leave_type:'Annual Leave'})).toMatchObject({ok:true});
  expect(calls).toEqual([['payroll_cycle_status',{period:'2026-07'}],['loops_overview',{}],['ai_quality_summary',{period:'quarter'}],
   ['explain_claim_limit',{claim_type:'Travel'}],['explain_payslip_statutory',{period:'2026-08',item:'epf'}]]);
  // Each topic's own rule: a payroll month is YYYY-MM, AI quality's period is a named one, a claim limit needs its type.
  const refused=async(binding:ToolBinding,input:Record<string,unknown>,problem:string)=>{
   const run=await binding.run(input);expect(run,JSON.stringify(input)).toMatchObject({ok:false,refusal:'invalid_input'});
   expect((run.content as {message:string}).message).toBe(`Invalid arguments for ${String(input.topic)}: ${problem}.`);
  };
  await refused(operations,{topic:'payroll_cycle',period:'quarter'},'period: wrong format');
  await refused(operations,{topic:'ai_quality',period:'2026-07'},'period: not an allowed value');
  await refused(why,{topic:'claim_limit'},'missing claim_type');
  await refused(why,{topic:'leave_entitlement',leave_type:'Annual Leave',as_of:'1 July'},'as_of: wrong format');
  await refused(why,{topic:'attendance_day'},'missing date');
  expect(calls).toHaveLength(5);
 });
});

describe('disclosure through a turn',()=>{
 it('discloses a topic\'s result under its own read\'s entity: the figure banded, the person shown the exact one',async()=>{
  const pay={ok:true,period:'2026-09',previousPeriod:'2026-08',availablePeriods:['2026-09','2026-08'],comparisons:[{period:'2026-09',previousPeriod:'2026-08',totals:{net:4321.5}}]};
  const {bindings,calls}=recorded(['explain_pay_difference','explain_claim_limit'],name=>name==='explain_pay_difference'?pay:{ok:true});
  const model=scriptedModel([{calls:[{name:'explain_why',args:{topic:'pay_difference'}}]},{calls:[{name:'explain_why',args:{topic:'loops'}}]},
   {final:{reply:'Your net pay was {{F1}}.'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:admin,conversationId:'conversation-topic',question:'Why is my pay different from last month?',scope:SCOPE,model,
   memory:new InMemoryTaskMemoryStore(),tools:async()=>Object.freeze({bindings:Object.freeze(bindings),reviewRoutes:[],destinations:[]})});
  expect(result.trace.offered).toContain('explain_why');
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['explain_why','ok'],['explain_why','invalid_input']]);
  expect(result.trace.disclosure).toHaveLength(1);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'explain_why',entity:'pay_difference_explanation',undeclared:[],removed:[],banded:['comparisons[0].totals.net']});
  // The model saw a placeholder and a band, never the figure; the person sees the figure.
  const toModel=JSON.stringify(model.requests[1].messages);
  expect(toModel).not.toContain('4321.5');expect(toModel).toMatch(/\{\{F1\}\} \(between 2000 and 5000\)/);
  expect(result.reply).toBe('Your net pay was 4321.5.');
  expect(calls).toEqual([['explain_pay_difference',{}]]);
 });
});
