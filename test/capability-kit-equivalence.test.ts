/** ADR-0170 §3.12, step 5c — the capability kit regenerates existing reads exactly.
 *
 * explain_attendance_day is declared here from scratch, the way a new capability would be: its native owner,
 * permission, entity, purpose and inputs, nothing copied from the hand declaration. The kit's read, tool spec,
 * registry row and harness offer must equal the hand-declared ones (core/semantic-model/entities-explain.ts,
 * core/semantic-model/generate.ts, core/explainers/capabilities.ts). Then every kit registry entry is checked
 * the same way. No database. */
import {describe,expect,it} from 'vitest';
import {EXPLAIN_ENTITIES,EXPLAIN_READS} from '../core/semantic-model/entities-explain';
import {TERAS_READS,terasCapabilityRegistry,terasToolSpecs} from '../core/semantic-model/generate';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {KitRefused,kitCapability,type KitDeclaration} from '../core/improvement/kit';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import type {BaselineIdeal} from './assistant-production-baseline-corpus';
import type {BaselineIdeal as KitIdeal} from '../core/improvement/corpus-shape';

const attendanceEntity=EXPLAIN_ENTITIES.find(entity=>entity.id==='attendance_day_explanation')!;
/** Written as a new author would write it. */
const ATTENDANCE_DAY:KitDeclaration={name:'explain_attendance_day',owner:'core/attendance-explain.ts#explainAttendanceDay',
 permission:{module:'attendance',admin:false},entity:attendanceEntity,
 purpose:'Why one of the asking person\'s own attendance days reads as it does (late, early out, overtime), step by step from the day\'s recorded working. Use it for "why was I marked late" questions; ask for the date if it is not clear.',
 input:[{name:'date',identifier:false,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'The attendance day, YYYY-MM-DD.'}}]};

describe('the kit regenerates explain_attendance_day',()=>{
 const generated=kitCapability(ATTENDANCE_DAY);
 it('equals the hand-declared read, tool spec and registry row',()=>{
  expect(generated.read).toEqual(EXPLAIN_READS.find(read=>read.name==='explain_attendance_day'));
  expect(generated.toolSpec).toEqual(terasToolSpecs().find(spec=>spec.name==='explain_attendance_day'));
  expect(generated.registryRow).toEqual(terasCapabilityRegistry().find(row=>row.name==='explain_attendance_day'));
 });
 it('offers it exactly as the harness capability list does',()=>{
  const offered=TERAS_CAPABILITIES.find(row=>row.name==='explain_attendance_day')!;
  expect({name:generated.binding.name,module:generated.binding.module,admin:generated.binding.admin}).toEqual({name:offered.name,module:offered.module,admin:offered.admin});
  expect(attendanceEntity.owners).toContain(generated.binding.owner);
 });
 it('generates the card binding, the review link and three draft corpus turns',()=>{
  expect(generated.card).toMatchObject({renderer:'teras.read-card',title:'Attendance day explanation',page:'/attendance/my-records'});
  expect(generated.card.fields).toEqual(expect.arrayContaining(['date','status','recorded.lateMinutes','lateness.steps','provenance.owner']));
  expect(generated.review).toEqual({route:'/attendance/my-records',label:'Open your attendance day explanation in the product'});
  expect(generated.corpus.map(turn=>[turn.contract,turn.ideal.mode,turn.draft])).toEqual([['answers_own','answer',true],['other_person_refusal','refuse',true],['no_overclaim','honest_gap',true]]);
  // The kit's ideal shape is the probe's: a kit turn can join the corpus once a person reviews it.
  const ideal:BaselineIdeal=generated.corpus[0].ideal,back:KitIdeal=ideal;expect(back).toEqual({mode:'answer',reads:['explain_attendance_day']});
  expect(generated.contracts).toEqual(['acts_as_person','no_identifiers','other_person_refusal','no_overclaim','minimum_fields']);
 });
 it('runs the owner as the caller with only the declared inputs',async()=>{
  const calls:unknown[]=[],ctx={tenantId:'t',userId:'u'} as never;
  const binding=generated.bind(async(caller,args)=>{calls.push([caller,args]);return 'ok';});
  expect(await binding.run(ctx,{date:'2026-07-01',employment_id:'someone-else',extra:1},{companyId:'c'})).toBe('ok');
  expect(calls).toEqual([[ctx,{date:'2026-07-01'}]]);
 });
});

describe('every kit registry entry equals its hand-declared capability',()=>{
 it('covers the four step 4 capabilities',()=>{
  expect(KIT_CAPABILITIES.map(row=>row.read.name).sort()).toEqual(TERAS_READS.map(read=>read.name).sort());
 });
 for(const capability of KIT_CAPABILITIES)it(capability.read.name,()=>{
  expect(capability.toolSpec).toEqual(terasToolSpecs().find(spec=>spec.name===capability.read.name));
  expect(capability.registryRow).toEqual(terasCapabilityRegistry().find(row=>row.name===capability.read.name));
  const offered=TERAS_CAPABILITIES.find(row=>row.name===capability.read.name)!;
  expect([capability.binding.module,capability.binding.admin]).toEqual([offered.module,offered.admin]);
  expect(capability.declaration.entity.owners).toContain(capability.binding.owner);
 });
});

describe('the kit refuses an unsafe declaration',()=>{
 const refused=(change:Partial<KitDeclaration>)=>{try{kitCapability({...ATTENDANCE_DAY,...change});return null;}catch(error){return error instanceof KitRefused?error.reason:'threw '+String(error);}};
 it('names the reason',()=>{
  expect(refused({})).toBeNull();
  expect(refused({owner:'core/read.ts#someOtherOwner'})).toBe('owner_not_declared_by_entity');
  expect(refused({entity:{...attendanceEntity,page:'/not/a/page'}})).toBe('page_not_linkable');
  expect(refused({entity:{...attendanceEntity,rls:'visible_employments'}})).toBe('own_audience_wider_scope');
  expect(refused({permission:{module:'attendance',admin:true}})).toBe('admin_permission_audience_mismatch');
  expect(refused({permission:{module:'leave',admin:false}})).toBe('module_mismatch');
  expect(refused({input:[{name:'employee_id',identifier:false,schema:{type:'string'}}]})).toBe('subject_input_not_a_handle');
  expect(refused({name:'Bad Name'})).toBe('name');
 });
});
