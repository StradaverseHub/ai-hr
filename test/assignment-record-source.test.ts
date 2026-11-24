/**
 * Board eb01800b — which record starts each dated assignment version (core/assignment-record-source.ts), and the
 * translated refusal that names it (lib/assignment-blocked-message.ts). Pure: fictional versions and ledger events;
 * the database owners are proven in movement-record-change.test.ts.
 */
import {describe,expect,it} from 'vitest';
import {createTranslator,type AbstractIntlMessages} from 'next-intl';
import {resolveAssignmentRecordSources,type AssignmentRecordEvent,type AssignmentRecordVersion} from '../core/assignment-record-source';
import {assignmentBlockedMessage,movementRecordAnchor,splitMovementRecordMarker,withMovementRecordMarker} from '../lib/assignment-blocked-message';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const base={companyId:'co-a',employmentType:'full_time',businessUnitId:'bu-a',departmentId:'dept-a',positionId:'pos-a'};
const v=(id:string,validFrom:string,validTo:string|null,over:Partial<AssignmentRecordVersion>={}):AssignmentRecordVersion=>({id,validFrom,validTo,...base,...over});
let seq=0;
const ev=(eventType:string,aggregateId:string,payload:unknown,actorId:string|null='user-1'):AssignmentRecordEvent=>({id:`ev-${++seq}`,eventType,aggregateId,payload,sequence:seq,occurredAt:new Date('2026-11-12T02:00:00Z'),actorId});

describe('resolveAssignmentRecordSources',()=>{
 it('names a dated Information-Only Correction of Department and Position, with its recorded labels',()=>{
  const versions=[v('hire','2023-03-09','2026-11-12'),v('c1','2026-11-12',null,{departmentId:'dept-b',positionId:'pos-b'})];
  const events=[ev('employment.information.corrected','emp',{effectiveOn:'2026-11-12',inserted:['c1'],fields:['departmentId','positionId','gradeId'],
   beforeLabels:{departmentId:'DP0007',positionId:'J0854'},afterLabels:{departmentId:'DP0009',positionId:'J0860'}})];
  const sources=resolveAssignmentRecordSources(versions,events);
  expect(sources.has('hire')).toBe(false);
  expect(sources.get('c1')).toMatchObject({kind:'correction',effectiveDate:'2026-11-12',fields:['departmentId','positionId'],changesValues:true,actorId:'user-1',
   values:[{field:'departmentId',before:'DP0007',after:'DP0009'},{field:'positionId',before:'J0854',after:'J0860'}]});
 });
 it('names a correction saved before the dated-corrections ADR by its assignmentVersionId',()=>{
  const versions=[v('hire','2023-03-09','2026-11-12'),v('legacy','2026-11-12',null,{departmentId:'dept-b'})];
  const sources=resolveAssignmentRecordSources(versions,[ev('employment.information.corrected','emp',{effectiveOn:'2026-11-12',assignmentVersionId:'legacy',previousAssignmentId:'hire',fields:['departmentId']})]);
  expect(sources.get('legacy')).toMatchObject({kind:'correction',fields:['departmentId']});
 });
 it('follows the replacement chain and a boundary re-application to the live row',()=>{
  // c1 created by a correction, carried (superseded and replaced) by a later correction, then lifted and re-applied.
  const versions=[v('hire','2023-03-09','2026-11-12'),v('c1-reapplied','2026-11-12',null,{departmentId:'dept-b'})];
  const events=[
   ev('employment.information.corrected','emp',{effectiveOn:'2026-11-12',inserted:['c1'],fields:['departmentId']}),
   ev('employment.information.corrected','emp',{effectiveOn:'2026-03-01',inserted:['c2'],assignment:[{supersededId:'c1',replacementId:'c1-carried'}],fields:['positionId']}),
   ev('employment.information.boundary.reapplied','emp',{movementDate:'2026-05-01',boundaries:[{date:'2026-11-12',liftedId:'c1-carried',insertedId:'c1-reapplied'}],lifted:['c1-carried']}),
  ];
  expect(resolveAssignmentRecordSources(versions,events).get('c1-reapplied')).toMatchObject({kind:'correction',effectiveDate:'2026-11-12',fields:['departmentId']});
 });
 it('names an organisation-structure (mapping) split, and keeps the piece that keeps the source start with its creator',()=>{
  const versions=[v('hire-piece','2023-03-09','2026-10-01'),v('mapped','2026-10-01',null,{businessUnitId:'bu-b'})];
  const events=[ev('employment.organisation.projected','hire',{sourceAssignmentId:'hire',effectiveOn:'2026-10-01',projection:{source:{id:'hire',validFrom:'2023-03-09'},
   replacements:[{id:'hire-piece',validFrom:'2023-03-09',validTo:'2026-10-01'},{id:'mapped',validFrom:'2026-10-01',validTo:null}]}})];
  const sources=resolveAssignmentRecordSources(versions,events);
  expect(sources.has('hire-piece')).toBe(false);
  expect(sources.get('mapped')).toMatchObject({kind:'mapping',fields:['businessUnitId'],effectiveDate:'2026-10-01'});
 });
 it('tells an untagged assignment write from a tagged movement leg, and a rolled-back movement owns nothing',()=>{
  const versions=[v('hire','2023-03-09','2026-04-01'),v('untagged','2026-04-01','2026-06-01',{departmentId:'dept-b'}),v('moved','2026-06-01',null,{departmentId:'dept-c'})];
  const events=[
   ev('employment.assignment.changed','untagged',{effectiveDate:'2026-04-01'}),
   ev('employment.assignment.changed','moved',{effectiveDate:'2026-06-01',movement:{type:'transfer',groupId:'g1'}}),
  ];
  const sources=resolveAssignmentRecordSources(versions,events);
  expect(sources.get('untagged')).toMatchObject({kind:'untagged',fields:['departmentId']});
  expect(sources.get('moved')).toMatchObject({kind:'movement',movementType:'transfer'});
  const reversed=resolveAssignmentRecordSources(versions,[...events,ev('employment.movement.reversed','emp',{movementId:events[1].id})]);
  expect(reversed.get('moved')?.kind).toBe('untagged');
 });
 it('marks a correction boundary that repeats the earlier values as changing nothing',()=>{
  const versions=[v('hire','2023-03-09','2026-01-01'),v('c2','2026-01-01','2026-03-01',{departmentId:'dept-b'}),v('c1','2026-03-01',null,{departmentId:'dept-b'})];
  const events=[ev('employment.information.corrected','emp',{effectiveOn:'2026-03-01',inserted:['c1'],fields:['departmentId']}),ev('employment.information.corrected','emp',{effectiveOn:'2026-01-01',inserted:['c2'],fields:['departmentId']})];
  const sources=resolveAssignmentRecordSources(versions,events);
  expect(sources.get('c1')).toMatchObject({kind:'correction',changesValues:false,fields:['departmentId']});
  expect(sources.get('c2')?.changesValues).toBe(true);
 });
});

type Translate=(key:string,values?:Record<string,string>)=>string;
const translator=(locale:string,messages:unknown,namespace:string)=>createTranslator({locale,messages:messages as AbstractIntlMessages,namespace} as Parameters<typeof createTranslator>[0]) as unknown as Translate;
describe('the named refusal',()=>{
 const record={versionId:'0b7c6f2e-8d3a-4c51-9a8e-1f2d3c4b5a69',kind:'correction' as const,effectiveDate:'2026-11-12',fields:['departmentId','positionId']};
 const dmy=(d:string)=>({'2026-11-12':'12-Nov-2026','2026-11-02':'02-Nov-2026'} as Record<string,string>)[d]??d;
 it('names what the record is, its date and what it changed, in every locale',()=>{
  for(const [locale,messages] of Object.entries({en,ms,ta,th,vi,zh})){
   const t=translator(locale,messages,'people.detail'),fields=translator(locale,messages,'people.informationCorrection.fields');
   for(const kind of ['correction','mapping','movement','untagged'] as const){
    const text=assignmentBlockedMessage({...record,kind},'2026-11-02',t,fields,dmy);
    expect(text,`${locale} ${kind}`).toContain('12-Nov-2026');
    expect(text,`${locale} ${kind}`).toContain('02-Nov-2026');
    if(kind!=='movement')expect(text,`${locale} ${kind}`).toContain(messages.people.informationCorrection.fields.departmentId);
   }
  }
  const t=translator('en',en,'people.detail');
  expect(assignmentBlockedMessage(record,'2026-11-02',t,f=>({departmentId:'Department',positionId:'Position'} as Record<string,string>)[f],dmy))
   .toBe('An Information-Only Correction (Department, Position) dated 12-Nov-2026 starts after 02-Nov-2026. Move its Effective Date to on or before 02-Nov-2026, or check what it changed, then record this event again.');
 });
 it('carries the record id to the New Event screen and back out, never shown as text',()=>{
  const marked=withMovementRecordMarker('Named refusal.',record.versionId);
  expect(splitMovementRecordMarker(marked)).toEqual({text:'Named refusal.',versionId:record.versionId});
  expect(splitMovementRecordMarker('Plain refusal [[not-a-marker]]')).toEqual({text:'Plain refusal [[not-a-marker]]',versionId:null});
  expect(movementRecordAnchor(record.versionId)).toBe('movement-record-'+record.versionId);
 });
});
