/** Spec v23 (AI v2 Phase 2 hardening, coordinator decision of 4 November 2026): topic tools and the queued Phase 2 lines.
 *
 * Phase 2's seven reads put an HR or group administrator's biggest turn at 39 tools against the provider's 32. v23 serves
 * two families of reads as topic tools (core/semantic-model/topic-tools.ts): operations_status (the loops overview and the
 * five Phase 2 administrator reads) and explain_why (the five "Why?" explainers). The deterministic parts here: the version
 * and its digest, every earlier digest kept, and the v22-shaped spec (v23's changes reverted, test/harness-spec-shapes.ts)
 * hashing to v22's digest; the topics are exactly the declared reads, each with its capability, kit entry, corpus turn and
 * linkable page; the topic tool specs are generated from those reads; and each new line is there once, word for word, with
 * nothing left of the text it replaced. The worst case per role is test/harness-tool-ceiling.test.ts, the gate and disclosure
 * per topic test/harness-topic-tools.test.ts. Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {FOLDED_READS,TOPIC_TOOLS,topicRead,topicToolSpecs} from '../core/semantic-model/topic-tools';
import {TERAS_READS,terasEntities,terasEntity,terasToolSpecs} from '../core/semantic-model/generate';
import {PAYROLL_CHECK_ACKNOWLEDGEMENT_ENTITY} from '../core/semantic-model/entities-payroll-loops';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {registeredWorker} from '../core/agent-registry/workers';
import {ANSWERED_BY} from './assistant-behaviour-score';
import {V22_OVERCLAIM_NOTE,V22_PAY_VIEW_NONE,V23_ADDED,V23_OVERCLAIM_NOTE,V23_PAY_VIEW_NONE,V23_REPLACED,v22ShapedSpec} from './harness-spec-shapes';

const instructions=HARNESS_SPEC.instructions as readonly string[];
const OPERATIONS={loops:'loops_overview',payroll_cycle:'payroll_cycle_status',salary_payroll:'salary_payroll_checks',payroll_loop_settings:'payroll_loop_settings',
 payroll_audit:'payroll_audit_status',ai_quality:'ai_quality_summary'};
const WHY={pay_difference:'explain_pay_difference',payslip_statutory:'explain_payslip_statutory',claim_limit:'explain_claim_limit',
 leave_entitlement:'explain_leave_entitlement',attendance_day:'explain_attendance_day'};

describe('spec v23',()=>{
 it('is version 23 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(23);expect(HARNESS_SPEC_DIGESTS[23]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[23]).toBe('0052cefe8d066154db37c62bc213dfb26eabcbe0cc861577103212d6e4e5f0c5');
  expect(HARNESS_SPEC_DIGESTS[22]).toBe('23c7a0b27b5d0029510b44935af4b07dd27d25aa34f1ff2607d0075f075e85d3');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual(Array.from({length:23},(_,index)=>index+1));
 });
 it('is v22 with only its own changes: the v22-shaped spec hashes to v22\'s recorded digest',()=>{
  expect(harnessSpecDigest(v22ShapedSpec())).toBe(HARNESS_SPEC_DIGESTS[22]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:22})).not.toBe(HARNESS_SPEC_DIGESTS[22]);
  // v23 changes four lines, adds six, adds offer.topicTools, and rewords the pay-view note and the overclaim retry note.
  expect(V23_REPLACED).toHaveLength(4);expect(V23_ADDED).toHaveLength(6);expect(instructions).toHaveLength(30);
  expect(HARNESS_SPEC.payView.none).toBe(V23_PAY_VIEW_NONE);expect(HARNESS_SPEC.retryNotes.overclaim).toBe(V23_OVERCLAIM_NOTE);
  expect(V22_PAY_VIEW_NONE).not.toBe(V23_PAY_VIEW_NONE);expect(V22_OVERCLAIM_NOTE).not.toBe(V23_OVERCLAIM_NOTE);
  expect(Object.keys(HARNESS_SPEC.offer)).toContain('topicTools');expect(Object.keys(v22ShapedSpec().offer)).not.toContain('topicTools');
 });
});

describe('the topic tools',()=>{
 it('are the spec\'s topic tools, each topic one declared read, in order',()=>{
  expect(HARNESS_SPEC.offer.topicTools).toEqual({operations_status:Object.keys(OPERATIONS),explain_why:Object.keys(WHY)});
  expect(Object.fromEntries(TOPIC_TOOLS.map(tool=>[tool.name,tool.topics.map(row=>row.topic)]))).toEqual(HARNESS_SPEC.offer.topicTools);
  expect(Object.fromEntries(TOPIC_TOOLS.find(tool=>tool.name==='operations_status')!.topics.map(row=>[row.topic,row.read]))).toEqual(OPERATIONS);
  expect(Object.fromEntries(TOPIC_TOOLS.find(tool=>tool.name==='explain_why')!.topics.map(row=>[row.topic,row.read]))).toEqual(WHY);
  expect([...FOLDED_READS.keys()].sort()).toEqual([...Object.values(OPERATIONS),...Object.values(WHY)].sort());
  for(const [topic,read] of Object.entries(OPERATIONS))expect(topicRead('operations_status',topic)?.name).toBe(read);
  expect(topicRead('operations_status','pay_difference')).toBeNull();expect(topicRead('explain_why','loops')).toBeNull();expect(topicRead('unknown_tool','loops')).toBeNull();
 });
 it('keep every topic\'s capability, gate, entity, kit entry, corpus turn and page',()=>{
  for(const [read,{tool,topic}] of FOLDED_READS){
   const declared=TERAS_READS.find(row=>row.name===read)!,capability=TERAS_CAPABILITIES.find(row=>row.name===read)!;
   expect(declared,read).toBeDefined();expect(capability,read).toBeDefined();
   // A folded read is never a product_guidance topic too.
   expect(capability.topic,read).toBeUndefined();
   const kit=KIT_CAPABILITIES.find(row=>row.read.name===read);
   expect(kit,read+' kit entry').toBeDefined();
   // The kit's own corpus turn still names the read itself as its ideal.
   expect(kit!.corpus.some(turn=>turn.contract==='answers_own'&&turn.ideal.mode==='answer'&&turn.ideal.reads.includes(read)),read+' corpus turn').toBe(true);
   expect(LINKABLE_PAGES.some(([path])=>path===terasEntity(declared.entity).page),read+' page').toBe(true);
   // The probes score a turn that reads the topic tool as reading the read.
   expect(ANSWERED_BY[read],read).toContain(tool);
   expect(topicRead(tool,topic)).toBe(declared);
  }
  // The operations topics are administrators' only; the explainers are everyone's own, under the explainers worker.
  for(const read of Object.values(OPERATIONS))expect(TERAS_CAPABILITIES.find(row=>row.name===read)).toMatchObject({admin:true,worker:null});
  for(const read of Object.values(WHY))expect(TERAS_CAPABILITIES.find(row=>row.name===read)).toMatchObject({admin:false,worker:'explainers'});
  // The explainers worker's switch withholds explain_why itself (core/teras-wiring/turn.ts conversationTools), and its
  // records attribute it.
  const record=registeredWorker('explainers')!.record;
  expect(record.kind==='outcome_record'&&record.tools).toEqual(expect.arrayContaining(['explain_why',...Object.values(WHY)]));
 });
 it('are generated from those reads: a required topic from the closed list, each read\'s own inputs, and each read\'s own description',()=>{
  const specs=topicToolSpecs();
  expect(specs.map(spec=>spec.name)).toEqual(['operations_status','explain_why']);
  for(const spec of specs){
   const tool=TOPIC_TOOLS.find(row=>row.name===spec.name)!,schema=spec.inputSchema as unknown as {properties:Record<string,{enum?:string[];type:string}>;required:string[];additionalProperties:boolean};
   expect(schema.required).toEqual(['topic']);expect(schema.additionalProperties).toBe(false);
   expect(schema.properties.topic.enum).toEqual(tool.topics.map(row=>row.topic));
   expect(spec.description.startsWith(tool.purpose)).toBe(true);
   for(const row of tool.topics){
    const own=terasToolSpecs().find(item=>item.name===row.read)!;
    // The read's own generated description, word for word, under its topic.
    expect(spec.description).toContain(`[${row.topic}] ${own.description}`);
    for(const input of Object.keys((own.inputSchema as unknown as {properties:Record<string,unknown>}).properties))expect(Object.keys(schema.properties),row.read).toContain(input);
   }
   expect(spec.description.length).toBeLessThanOrEqual(16_384);
  }
  // Inputs several topics take with different rules become a plain string, checked again against the topic's own read.
  const operations=specs[0].inputSchema as unknown as {properties:Record<string,{type:string;pattern?:string;enum?:string[]}>};
  expect(Object.keys(operations.properties)).toEqual(['topic','period']);
  expect(operations.properties.period).toMatchObject({type:'string'});expect(operations.properties.period.pattern).toBeUndefined();expect(operations.properties.period.enum).toBeUndefined();
  const why=specs[1].inputSchema as unknown as {properties:Record<string,{type:string;pattern?:string;description:string}>};
  expect(Object.keys(why.properties)).toEqual(['topic','period','compare_to','item','claim_type','leave_type','as_of','date']);
  expect(why.properties.period.pattern).toBe('^\\d{4}-\\d{2}$');
  expect(why.properties.leave_type.description).toMatch(/^leave_entitlement \(required\): /);
 });
});

describe('the loops hardening branch\'s declarations (coordinator, text only until merged)',()=>{
 it('declares the payroll check acknowledgement with no pay figure and the typed reason never, offered by no read or topic yet',()=>{
  const entity=PAYROLL_CHECK_ACKNOWLEDGEMENT_ENTITY;
  expect(entity.fields.map(field=>[field.name,field.type,field.disclosure])).toEqual([['checkId','label','full'],['scope','enum','full'],['reason','text','never'],
   ['reviewOn','date','full'],['provenance','object','full']]);
  expect(entity).toMatchObject({module:'payroll',audience:'admin',rls:'administered_scope',sensitivity:'ordinary'});
  expect(terasEntities().some(row=>row.id==='payroll_check_acknowledgement')).toBe(false);
  expect(TERAS_READS.some(read=>read.entity==='payroll_check_acknowledgement')).toBe(false);
  expect(Object.values(HARNESS_SPEC.offer.topicTools).flat()).not.toContain('payroll_check_acknowledgements');
 });
 it('declares the audit\'s data-aware required flag on each statutory form, and the bank check\'s match and not_available meanings',()=>{
  const companies=terasEntity('payroll_audit_status').fields.find(field=>field.name==='companies')!;
  const statutory=companies.of!.find(field=>field.name==='statutory')!;
  expect(statutory.of!.find(field=>field.name==='required')).toMatchObject({type:'boolean',disclosure:'full'});
  expect(statutory.of!.find(field=>field.name==='required')!.meaning).toMatch(/not required this month, never missing/);
  const salary=terasEntity('salary_payroll_run').fields.find(field=>field.name==='companies')!.of!.find(field=>field.name==='runs')!.of!.find(field=>field.name==='bank')!;
  expect(salary.meaning).toMatch(/match \(it matches, including a run where nobody is paid by bank\)/);expect(salary.meaning).toMatch(/not_available \(no bank file format to compare: never done\)/);
 });
});

describe('the lines v23 folds in, one each',()=>{
 const line=(start:string)=>{const found=instructions.filter(row=>row.startsWith(start));expect(found,start).toHaveLength(1);return found[0];};
 it('names the topic tools: explain_why for the five "Why?" topics, operations_status for an administrator\'s six',()=>{
  expect(line('Why the person')).toBe('Why the person\'s own pay changed, a payslip deduction, a claim limit, a leave entitlement or an attendance day: call explain_why with that topic (pay_difference, payslip_statutory, claim_limit, leave_entitlement or attendance_day), quote its figures exactly and name only the causes it lists.');
  expect(line('An administrator\'s question')).toBe('An administrator\'s question about AI Centre\'s loops, the payroll cycle, the salary payroll checks, the payroll loop settings, the payroll audit or AI quality: call operations_status with that topic (loops, payroll_cycle, salary_payroll, payroll_loop_settings, payroll_audit or ai_quality), one topic per call. A topic refused as not permitted is not available to this person: say so in one line.');
  // No folded read is named as a tool of its own anywhere in the text (payroll_loop_settings is also its own topic's name).
  for(const [read,{topic}] of FOLDED_READS)if(read!==topic)expect(instructions.join(' '),read).not.toContain(read);
 });
 it('loop autonomy: above Prepare only through owner services, attributed, with notice, undo and auto-demotion; the five areas stay at Prepare',()=>{
  expect(line('A loop above Prepare')).toBe('A loop above Prepare acts only through its owner services, attributed to the agent, with notice to the person, an undo and an automatic return to Prepare when people correct it too often; pay, employment status, access, discipline and statutory filing always stay at Prepare.');
 });
 it('AI quality: administrators only, counts and percentages with their period, never examples, names, ratios or a share worked out',()=>{
  expect(line('AI quality')).toBe('AI quality (topic ai_quality) is for administrators only: give its counts and percentages with their period, as returned; never examples, names or ratios, and never work out a share.');
 });
 it('payroll loops: a bank "match" includes runs nobody is paid by bank, "not available" is never done; a form not required is never missing',()=>{
  expect(line('In the salary payroll checks')).toBe('In the salary payroll checks, a bank check "match" includes runs where nobody is paid by bank, and "not available" is never "done". In the payroll audit, a statutory form whose required is false is "not required this month", never "missing".');
 });
 it('before payroll: to-do items first with their pages, the cut-off only when set, nothing added',()=>{
  expect(line('Before payroll')).toBe('Before payroll (my_payroll_readiness): give the person\'s to-do items first, each with its page; give the cut-off only when one is set; never add items or dates.');
 });
 it('company policy: approved paragraphs only, figures as written, cited; never a draft, memory or an amount worked out; the [current setting: …] marker',()=>{
  expect(line('Company policy')).toBe('Company policy (my_policy_handbook): answer only from the approved paragraphs it returns, quote figures exactly as written, and cite the policy title, version and paragraph; never answer from a draft or from memory, and never work out an amount. Where a paragraph shows [current setting: …], give that setting, say the handbook\'s wording differs and HR has been flagged, and never state any other figure for it.');
 });
 it('leave balances: notShown in place of withheld:true',()=>{
  expect(line('In leave balances')).toBe('In leave balances, notShown names the parts of a row the company hides; every figure present is real. Never write \'withheld\' or \'not shown\' beside a figure, and never show a hidden part as 0. Leave out leave types with nothing available and no entitlement unless asked.');
  expect(instructions.join(' ')).not.toMatch(/withheld:true/);
 });
 it('a prepared card is "ready for you to review and confirm", never "I\'ve prepared …" (eval 41679463324, mgr-queue-2)',()=>{
  const change=line('To help with a change');
  expect(change).toContain('Only when its result says a review item is ready or a form is filled in, say it is ready for them to review and confirm (for a decision: "a decision card is ready for you to review and confirm"); never write "I\'ve prepared …".');
  expect(instructions.join(' ')).not.toMatch(/write "I've prepared … for you to review and confirm"/);
  expect(HARNESS_SPEC.retryNotes.overclaim).toContain('say a card "is ready for you to review and confirm" only for a card this turn prepared.');
 });
 it('another person\'s pay with no page to open is never sent to HR or the payroll team (pay-net-1)',()=>{
  expect(HARNESS_SPEC.payView.none).toBe('If they ask about this person\'s pay: no page they can open here shows it. Say in one line that pay is not shown in chat and that no page they can open shows it; never send them to HR or the payroll team.');
  expect(line('Individual pay never reaches you')).toContain('Only when their own pay has no such page, say who to ask; for someone else\'s pay, follow the note.');
 });
});
