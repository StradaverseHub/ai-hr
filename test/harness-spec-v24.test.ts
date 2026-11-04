/** Spec v24 (the AI Centre restructure with payroll history learning, coordinator decision of 4 November 2026).
 *
 * v24 adds the payroll_learning topic to operations_status (no new tool), names it in the operations line and says what a
 * payroll learning answer may give; points Before payroll at My payroll readiness for the whole list and says payroll
 * exceptions are resolved on Operations › Exceptions only (owner decisions 27 and 28); and, for a change's dates, has the
 * reply state the exact date chosen when the person names a day rather than a date (eval 41824624722, emp-apply-2).
 * The deterministic parts here: the version and its digest, every earlier digest kept, and the v23-shaped spec (v24's
 * changes reverted, test/harness-spec-shapes.ts) hashing to v23's digest; nothing else in the spec moved; each new or
 * replaced line is there once, word for word, with nothing left of the text it replaced; the new topic is the declared
 * read with its own gate; and every page a new line names is a real linkable page for its audience. The worst case per
 * role is test/harness-tool-ceiling.test.ts. Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {FOLDED_READS,TOPIC_TOOLS,topicRead} from '../core/semantic-model/topic-tools';
import {terasEntity} from '../core/semantic-model/generate';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {V24_ADDED,V24_REPLACED,V24_TOPIC,v23ShapedSpec} from './harness-spec-shapes';

const instructions=HARNESS_SPEC.instructions as readonly string[];
const line=(start:string)=>{const found=instructions.filter(row=>row.startsWith(start));expect(found,start).toHaveLength(1);return found[0];};
const audience=(path:string)=>LINKABLE_PAGES.find(([page])=>page===path)?.[1];

describe('spec v24',()=>{
 it('is version 24 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(24);expect(HARNESS_SPEC_DIGESTS[24]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[24]).toBe('ce0ac9b4b80db7aacf2e4d1939819e69099a8416ef64c9cc4d8b38acced1029e');
  expect(HARNESS_SPEC_DIGESTS[23]).toBe('0052cefe8d066154db37c62bc213dfb26eabcbe0cc861577103212d6e4e5f0c5');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual(Array.from({length:24},(_,index)=>index+1));
 });
 it('is v23 with only its own changes: the v23-shaped spec hashes to v23\'s recorded digest',()=>{
  const v23=v23ShapedSpec();
  expect(harnessSpecDigest(v23)).toBe(HARNESS_SPEC_DIGESTS[23]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:23})).not.toBe(HARNESS_SPEC_DIGESTS[23]);
  // v24 replaces three lines, adds two and appends one topic; v23 had 30 lines.
  expect(V24_REPLACED).toHaveLength(3);expect(V24_ADDED).toHaveLength(2);
  expect(v23.instructions).toHaveLength(30);expect(instructions).toHaveLength(32);
  expect(v23.offer.topicTools.operations_status).toEqual(['loops','payroll_cycle','salary_payroll','payroll_loop_settings','payroll_audit','ai_quality']);
  expect(HARNESS_SPEC.offer.topicTools.operations_status).toEqual([...v23.offer.topicTools.operations_status,V24_TOPIC]);
  expect(HARNESS_SPEC.offer.topicTools.explain_why).toEqual(v23.offer.topicTools.explain_why);
  // Nothing outside the instructions and the one topic list differs.
  const {instructions:_now,offer:{topicTools:_nowTopics,...nowOffer},version:_nowVersion,...nowRest}=HARNESS_SPEC;
  const {instructions:_then,offer:{topicTools:_thenTopics,...thenOffer},version:_thenVersion,...thenRest}=v23;
  expect(nowOffer).toEqual(thenOffer);expect(nowRest).toEqual(thenRest);
 });
 it('has each replaced line once, word for word, and nothing left of the line it replaced',()=>{
  for(const [v23,v24] of V24_REPLACED){
   expect(instructions.filter(row=>row===v24),v24.slice(0,40)).toHaveLength(1);
   expect(instructions,v23.slice(0,40)).not.toContain(v23);
   expect(v24).not.toBe(v23);
  }
  for(const added of V24_ADDED)expect(instructions.filter(row=>row===added),added.slice(0,40)).toHaveLength(1);
  // Placed beside the lines they belong to.
  expect(instructions.indexOf(V24_ADDED[0])).toBe(instructions.findIndex(row=>row.startsWith('AI quality (topic ai_quality)'))+1);
  expect(instructions.indexOf(V24_ADDED[1])).toBe(instructions.findIndex(row=>row.startsWith('In the salary payroll checks'))+1);
 });
});

describe('payroll history learning',()=>{
 it('names the payroll_learning topic in the operations line, which lists exactly the spec\'s topics',()=>{
  const operations=line('An administrator\'s question');
  expect(operations).toBe('An administrator\'s question about AI Centre\'s loops, the payroll cycle, the salary payroll checks, the payroll loop settings, the payroll audit, AI quality or payroll learning: call operations_status with that topic (loops, payroll_cycle, salary_payroll, payroll_loop_settings, payroll_audit, ai_quality or payroll_learning), one topic per call. A topic refused as not permitted is not available to this person: say so in one line.');
  const topics=[...HARNESS_SPEC.offer.topicTools.operations_status];
  expect(operations).toContain(`(${topics.slice(0,-1).join(', ')} or ${topics.at(-1)})`);
 });
 it('says what a payroll learning answer may give: counts per company with the month, "fewer than 5" for a null, never a person, an amount or a range',()=>{
  expect(line('Payroll learning')).toBe('Payroll learning (topic payroll_learning) is for payroll administrators only: give its counts per company with the month, as returned; a null count is "fewer than 5", never a number; never name a person or give an amount or a usual range, and never say a usual range changed a figure, a check or a flag.');
  // The entity says the same of every count the model sees (core/semantic-model/entities-payroll-learning.ts).
  const people=terasEntity('payroll_learning').fields.find(field=>field.name==='companies')!.of!.find(field=>field.name==='people')!;
  for(const count of people.of!){expect(count.disclosure,count.name).toBe('bands');expect(count.meaning,count.name).toContain('say "fewer than 5", never a number');}
 });
 it('binds the topic to payroll_learning_status only, a payroll administrators\' read with its kit entry and its page',()=>{
  const operations=TOPIC_TOOLS.find(tool=>tool.name==='operations_status')!;
  expect(operations.topics.at(-1)).toEqual({topic:'payroll_learning',read:'payroll_learning_status'});
  expect(topicRead('operations_status','payroll_learning')?.name).toBe('payroll_learning_status');
  expect(FOLDED_READS.get('payroll_learning_status')).toMatchObject({tool:'operations_status',topic:'payroll_learning'});
  expect(TERAS_CAPABILITIES.find(row=>row.name==='payroll_learning_status')).toMatchObject({admin:true,module:'payroll',worker:null});
  expect(KIT_CAPABILITIES.some(row=>row.read.name==='payroll_learning_status')).toBe(true);
  expect(audience(terasEntity('payroll_learning').page!)).toBe('admin');
  // A topic is never a tool of its own: no instruction names the folded read.
  for(const [read,{topic}] of FOLDED_READS)if(read!==topic)expect(instructions.join(' '),read).not.toContain(read);
 });
});

describe('the restructure\'s single sources',()=>{
 it('Before payroll links My payroll readiness for the whole list, the readiness read\'s own page, open to everyone',()=>{
  expect(line('Before payroll')).toBe('Before payroll (my_payroll_readiness): give the person\'s to-do items first, each with its page; give the cut-off only when one is set; never add items or dates; for the whole list, link My payroll readiness (/me/payroll-readiness).');
  expect(terasEntity('payroll_readiness').page).toBe('/me/payroll-readiness');
  expect(audience('/me/payroll-readiness')).toBe('everyone');
 });
 it('payroll exceptions are resolved on Operations › Exceptions only, an administrator\'s page',()=>{
  expect(line('Payroll exceptions')).toBe('Payroll exceptions are resolved on Operations › Exceptions (/control-tower/exceptions) only.');
  expect(audience('/control-tower/exceptions')).toBe('admin');
  // No other line sends a person to resolve an exception anywhere else.
  expect(instructions.filter(row=>/exception/i.test(row))).toEqual(['Payroll exceptions are resolved on Operations › Exceptions (/control-tower/exceptions) only.']);
 });
});

describe('a change\'s dates',()=>{
 it('states the exact date chosen, with its weekday, when the person names a day rather than a date; today stays the HR date owner\'s',()=>{
  const change=line('To help with a change');
  expect(change.endsWith('Fill details only with what the person said: dates worked out from today, times as 24-hour HH:MM. When they name a day rather than a date (such as "next Friday"), state in the reply the exact date you chose, with its weekday, so they can correct it.')).toBe(true);
  expect(instructions.filter(row=>row.includes('next Friday'))).toHaveLength(1);
  expect(instructions[0]).toBe('You are the HR Assistant inside an HR application. Today is {today} (Asia/Kuala_Lumpur).');
 });
});
