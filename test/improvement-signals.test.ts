/** ADR-0170 §3.12, step 5c — signal triage and draft improvement items, over fictional outcome records and a
 * real harness trace from a scripted model. No database, no provider, no board. */
import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {CLASSIFICATIONS,signalRecordFromTrace,triageSignals,type SignalRecord} from '../core/improvement/signals';
import {draftImprovements} from '../core/improvement/proposals';
import {fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel} from './harness-ratchet/scripted-model';

/** Things that must never leave the tenant, planted wherever a record can hold a string. */
const QUESTION='Why did Siti Fictional get a bigger bonus than me in March?';
const NAME='Siti Fictional',RECORD_ID=randomUUID(),TENANT=randomUUID(),REPLY='Your colleague Siti Fictional earns more because';
const people=Array.from({length:6},()=>randomUUID());
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Partial_={who?:number;roles?:string[];mode?:string|null;calls?:{tool:string;status:string;refusal?:string}[];gate?:string|null;retries?:string[];
 outcomeKind?:SignalRecord['outcomeKind'];suggestion?:string|null;decision?:SignalRecord['decision'];fallback?:boolean;budget?:string|null;mandateJob?:string};
function record(p:Partial_):SignalRecord{
 const who=people[p.who??0],mandate=p.mandateJob!==undefined;
 return{runKind:mandate?'mandate_run':'turn',outcomeKind:p.outcomeKind??(p.suggestion?'suggested':p.fallback?'fallback':'answered'),
  askedByUserId:mandate?null:who,grantorUserId:mandate?who:null,
  outcome:mandate?{jobType:p.mandateJob,peopleCovered:3,note:QUESTION}:{mode:p.mode??'answer',slot:null,suggestion:p.suggestion??null,openProposals:0,fallback:p.fallback??false,budgetExhausted:p.budget??null,
   // Planted: an outcome field a careless writer filled with text and a record id.
   question:QUESTION,subject:RECORD_ID},
  checks:[{check:'turn_gate',owner:'lib/product-context/request-gate.ts#gateTurn',ruleVersion:'harness_spec:v5',result:p.gate?'needs_review':'pass'}],
  reads:(p.calls??[]).map(call=>({tool:call.tool,status:call.status,refs:[RECORD_ID]})),
  trace:{kind:'teras.turn-trace',turnId:RECORD_ID,conversationId:RECORD_ID,caller:{tenantId:TENANT,userId:who,personId:randomUUID(),roles:p.roles??['employee'],authorityKey:NAME},
   gate:{privateReads:!p.gate,actions:true,reason:p.gate??null},calls:(p.calls??[]).map((call,index)=>({step:index+1,argumentsDigest:'0'.repeat(64),...call})),
   retries:(p.retries??[]).map((reason,index)=>({step:index+1,reason})),question:QUESTION,reply:REPLY,outcome:{mode:p.mode??'answer'}},
  decision:p.decision??null};
}
const RECORDS:readonly SignalRecord[]=[
 // Payslip questions nobody can answer yet: four people, two roles.
 ...[0,1,2,3].map(who=>record({who,roles:who===3?['manager']:['employee'],mode:'honest_gap',calls:[{tool:'my_payslip_summary',status:'ok'}]})),
 // A how-to with no guide: honest gap after guidance only.
 record({who:4,mode:'honest_gap',calls:[{tool:'product_guidance',status:'ok'}]}),record({who:4,mode:'honest_gap',calls:[{tool:'product_guidance',status:'ok'}]}),
 // An honest gap with no call at all.
 record({who:5,mode:'honest_gap'}),
 // Guard blocks: another person (two people), and a file.
 record({who:0,gate:'other_person',mode:'refuse'}),record({who:1,gate:'other_person',mode:'refuse'}),record({who:2,gate:'attachment',mode:'refuse'}),
 // Fallbacks and retries.
 record({who:3,fallback:true,retries:['overclaim','overclaim']}),record({who:2,fallback:true,budget:'steps'}),
 // Tool misuse and a refusal on permission.
 record({who:1,calls:[{tool:'employee_profile',status:'unknown_handle'},{tool:'team_leave_summary',status:'refused',refusal:'not_permitted'}]}),
 // An unknown tool name and a smuggled refusal string are closed to `other`.
 record({who:1,calls:[{tool:NAME,status:'refused',refusal:QUESTION}]}),
 // Suggestions: accepted, rejected, undone, open; a mandate run prepared.
 record({who:0,suggestion:'leave.apply',decision:'accepted'}),record({who:1,suggestion:'leave.apply',decision:'rejected'}),
 record({who:2,suggestion:'leave.cancel',decision:'undone'}),record({who:3,suggestion:'leave.apply'}),record({who:5,suggestion:QUESTION,decision:'rejected'}),
 {...record({who:4,mandateJob:'team_absence_weekly_summary'}),outcomeKind:'prepared',decision:null},
];

describe('signal triage',()=>{
 const report=triageSignals(RECORDS);
 it('aggregates every signal kind by its category',()=>{
  expect(report.records).toEqual({total:RECORDS.length,turns:RECORDS.length-1,mandateRuns:1,people:6});
  expect(report.suggestions).toEqual({'leave.apply':{accepted:1,rejected:1,reversed:0,open:1},'leave.cancel':{accepted:0,rejected:0,reversed:1,open:0},
   other:{accepted:0,rejected:1,reversed:0,open:0},team_absence_weekly_summary:{accepted:0,rejected:0,reversed:0,open:1}});
  expect(report.replies).toEqual({noToolOrAction:{payroll:4,none:1},noGuideFound:{product_context:2}});
  expect(report.guardBlocks).toEqual({other_person:2,attachment:1,tool_not_permitted:1});
  expect(report.fallbacks).toEqual({budget_steps:1,reply_check:1});
  expect(report.replyCheckRetries).toEqual({overclaim:2});
  expect(report.toolCallFailures).toEqual({employee_profile:1,other:1});
 });
 it('classifies each cluster and ranks by people, then roles, then count',()=>{
  const top=report.clusters[0];
  expect(top).toMatchObject({key:'no_tool_or_action:payroll',classification:'missing_capability',count:4,people:4,roles:['employee','manager'],rank:1});
  expect(report.clusters.map(row=>row.rank)).toEqual(report.clusters.map((_,index)=>index+1));
  for(const [a,b] of report.clusters.slice(1).map((row,index)=>[report.clusters[index],row] as const))
   expect(a.people>b.people||(a.people===b.people&&(a.roles.length>b.roles.length||(a.roles.length===b.roles.length&&a.count>=b.count)))).toBe(true);
  const by=(key:string)=>report.clusters.find(row=>row.key===key)?.classification;
  expect([by('no_guide_found:product_context'),by('guard_block:other_person'),by('guard_block:attachment'),by('reply_check_retry:overclaim'),
   by('suggestion_rejected:leave.apply'),by('suggestion_reversed:leave.cancel'),by('tool_call_failure:employee_profile')])
   .toEqual(['missing_context','guard_gap','interface_gap','harness_defect','interface_gap','harness_defect','harness_defect']);
  expect(new Set(report.clusters.map(row=>row.classification))).toEqual(new Set(CLASSIFICATIONS));
 });
 it('carries counts, categories, tool and role names only: no question, name, reply or id',()=>{
  const text=JSON.stringify(report);
  for(const secret of [QUESTION,NAME,REPLY,RECORD_ID,TENANT,...people,'Siti','bonus'])expect(text,secret).not.toContain(secret);
  expect(UUID.test(text)).toBe(false);
  const strings:string[]=[];JSON.stringify(report,(key,value)=>{strings.push(key);if(typeof value==='string')strings.push(value);return value;});
  for(const value of strings)expect(value,value).toMatch(/^[a-z0-9_.:-]*$/i);
 });
 it('reads an empty or malformed history as an empty report',()=>{
  expect(triageSignals([]).clusters).toEqual([]);
  expect(triageSignals([{...record({}),trace:'not a trace',outcome:{}}]).clusters).toEqual([]);
 });
});

describe('a real harness trace',()=>{
 const ctx:SessionContext={tenantId:TENANT,userId:people[0],personId:randomUUID(),roles:['employee'],grants:[{role:'employee',companyId:null}]};
 it('reads a scripted honest-gap turn as a no-guide signal, without the question',async()=>{
  const {provider}=fakeTools();
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:'c-1',question:'How do I set up a fictional bonus scheme for Siti Fictional?',scope:{companyId:randomUUID(),locale:'en'},
   model:scriptedModel([{calls:[{name:'product_guidance',args:{query:'bonus scheme'}}]},{final:{reply:'There is no guide for that yet.',mode:'honest_gap'}}]),memory:new InMemoryTaskMemoryStore(),tools:provider});
  const report=triageSignals([signalRecordFromTrace(result.trace)]);
  expect(report.replies.noGuideFound).toEqual({product_context:1});
  expect(JSON.stringify(report)).not.toMatch(/bonus|Siti|guide for that/);
 });
});

describe('draft improvement items',()=>{
 const drafts=draftImprovements(triageSignals(RECORDS),{top:4});
 it('drafts the top clusters as local-only items in the improve loop format',()=>{
  expect(drafts).toHaveLength(4);
  expect(drafts[0]).toMatchObject({kind:'teras.improvement-draft',status:'draft_local_only',draftKey:'teras:no_tool_or_action:payroll',
   raise:{category:'new_function'},evidence:{count:4,people:4,classification:'missing_capability'}});
  for(const draft of drafts){
   expect(Object.keys(draft).sort()).toEqual(['draftKey','evidence','kind','model','plan','raise','status','version']);
   expect(draft.raise.title.trim().length).toBeGreaterThan(10);expect(draft.raise.description.trim().length).toBeGreaterThan(10);
   expect(draft.plan).toMatch(/^VERDICT: (Not built yet|Partly there already|Already works)\s+·\s+SIZE: (Quick|Moderate|Large)\n\nTHE SITUATION TODAY\n\n/);
   for(const heading of ['WHAT WE\'LL CHANGE','WHAT YOU\'LL GET','GOOD TO KNOW','BUILD NOTES (technical - skip this if you are reviewing the request)'])expect(draft.plan).toContain('\n\n'+heading+'\n\n');
  }
 });
 it('keeps the reviewer\'s part plain: no Markdown, no developer words, no file paths (feedback-plan skill)',()=>{
  const BANNED=/\b(migration|schema|jsonb|RLS|tri-state|enum|endpoint|API|component|prop|boolean|null|backend|refactor|commit|repo|cron|service|substrate|idempotent)\b/i;
  for(const draft of drafts){
   expect(draft.plan).not.toMatch(/\*|#|`|\||^>/m);
   const business=draft.plan.split('------------------------------------------------------------')[0];
   expect(business,draft.draftKey).not.toMatch(BANNED);expect(business).not.toMatch(/\w+\/\w+\.ts|\.tsx?\b/);
   expect(`${draft.raise.title} ${draft.raise.description} ${draft.raise.expectedBehavior}`).not.toMatch(BANNED);
  }
 });
 it('carries no question, name, reply, id or board field, and says no rule changes without a person',()=>{
  const text=JSON.stringify(drafts);
  for(const secret of [QUESTION,NAME,REPLY,RECORD_ID,TENANT,...people])expect(text,secret).not.toContain(secret);
  expect(UUID.test(text)).toBe(false);
  expect(text).not.toMatch(/tenantId|reporterEmploymentId|reporterUserId|"id"/);
  for(const draft of drafts)expect(draft.plan).toMatch(/A person approves every change|never changes a protection/);
  const guard=draftImprovements(triageSignals(RECORDS),{top:50}).find(draft=>draft.evidence.signal==='guard_block')!;
  expect(guard.plan).toContain('The improvement engine never changes a protection.');
 });
});
