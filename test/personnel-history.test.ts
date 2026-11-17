import {describe,it,expect} from 'vitest';
import {latestPersonnelHistory,personnelInformationCorrections} from '../lib/personnel-history';
import {movementHistoryHref,movementPageHref} from '../lib/personnel-movement-navigation';
const row=(id:string,sequence:number,kind='promotion',groupId:string|null=null)=>({id,sequence,kind,groupId,reversed:null,scheduled:false,appliedAt:null});
const event=(id:string,sequence:number,eventType:string,payload:unknown)=>({id,sequence,eventType,payload});
const correction=(sequence:number,fields:Record<string,string|null>)=>event('correction-'+sequence,sequence,'employment.information.corrected',{fields:Object.keys(fields),after:fields});

describe('personnel display chronology and correction ownership',()=>{
 it('sorts latest first using full capture time, sequence and stable ID without mutating canonical order',()=>{
  const rows=[{id:'hired',effectiveDate:'2020-01-01'}, {id:'earlier-time',effectiveDate:'2026-04-01',recordedAt:'2026-04-04T01:00:00Z',sortSequence:8},{id:'b',effectiveDate:'2026-04-01',recordedAt:'2026-04-04T02:00:00Z',sortSequence:9},{id:'a',effectiveDate:'2026-04-01',recordedAt:'2026-04-04T02:00:00Z',sortSequence:9},{id:'future',effectiveDate:'2027-01-01'}];
  expect(latestPersonnelHistory(rows).map(r=>r.id)).toEqual(['future','a','b','earlier-time','hired']);
  expect(rows.map(r=>r.id)).toEqual(['hired','earlier-time','b','a','future']);
 });
 it('amends all five fields on the existing hire with repeat/import-equivalent corrections, without a new row',()=>{
  const rows=[row('hired-event',1,'hired'),row('promotion',3)];
  const events=[event('hired-event',1,'employment.hired',{}),event('promotion',3,'compensation.set',{}),correction(5,{companyId:'new-company',hiredOn:'2020-01-02',joinDate:'2020-01-03',gradeId:'grade',employmentType:'part_time'}),correction(6,{companyId:'latest-company'})];
  const overlay=personnelInformationCorrections(events,rows);
  expect([...overlay.keys()]).toEqual(['hired-event','promotion']);
  expect(overlay.get('hired-event')).toEqual([{eventId:'correction-5',fields:['companyId','hiredOn','joinDate','gradeId','employmentType'],values:{companyId:'new-company',hiredOn:'2020-01-02',joinDate:'2020-01-03',gradeId:'grade',employmentType:'part_time'},needsReview:false},{eventId:'correction-6',fields:['companyId'],values:{companyId:'latest-company'},needsReview:false}]);
  expect(rows).toHaveLength(2);
 });
 it('bounds corrected company at a genuine transfer and resolves its group-owned source separately',()=>{
  const rows=[row('hire',1,'hired'),row('promotion',3),row('transfer-primary',8,'entityTransfer','transfer')];
  const events=[event('hire',1,'employment.hired',{}),correction(4,{companyId:'corrected-original'}),event('company-leg',9,'employment.company.transferred',{movement:{groupId:'transfer'},before:{companyId:'corrected-original'},after:{companyId:'destination'}}),correction(10,{companyId:'corrected-destination'})];
  const result=personnelInformationCorrections(events,rows);
  expect(result.get('hire')?.map(c=>c.values.companyId)).toEqual(['corrected-original']);
  expect(result.get('promotion')?.map(c=>c.values.companyId)).toEqual(['corrected-original']);
  expect(result.get('transfer-primary')?.map(c=>c.values.companyId)).toEqual(['corrected-destination']);
 });
 it('does not move genuine earlier grades, invent a source for untagged changes, or change pending/reversed rows',()=>{
  const rows=[row('hire',1,'hired'),row('grade',3,'promotion'),{...row('pending',8),scheduled:true}, {...row('reversed',9),reversed:{reason:'undo'}}];
  const events=[event('hire',1,'employment.hired',{}),event('grade',3,'employment.grade.changed',{before:'old',after:'new'}),correction(5,{gradeId:'corrected'})];
  expect(personnelInformationCorrections(events,rows).get('hire')).toBeUndefined();
  expect(personnelInformationCorrections(events,rows).get('grade')?.[0].values.gradeId).toBe('corrected');
  expect(personnelInformationCorrections(events,rows).has('pending')).toBe(false);
  expect(personnelInformationCorrections(events,rows).has('reversed')).toBe(false);
  const ambiguous=personnelInformationCorrections([...events,event('untagged',6,'employment.grade.changed',{before:'corrected',after:'other'}),correction(7,{gradeId:'latest'})],rows);
  expect(ambiguous.get('hire')?.[0]).toMatchObject({needsReview:true,fields:['gradeId'],values:{}});
 });
 it('supports a synthetic hire and ignores malformed correction values',()=>{
  const result=personnelInformationCorrections([correction(2,{companyId:'co'}),event('bad',3,'employment.information.corrected',{fields:['gradeId'],after:{gradeId:{fake:true}}})],[row('hired',0,'hired')]);
  expect(result.get('hired')).toEqual([{eventId:'correction-2',fields:['companyId'],values:{companyId:'co'},needsReview:false}]);
 });
 it('allowlists list context and never accepts an external return URL',()=>{
  expect(movementHistoryHref('employee',{showCorrected:'1',from:'org'})).toBe('/admin/personnel/employee?tab=careerMovement&showCorrected=1&from=org#section-assignment-history');
  expect(movementPageHref('employee','view','event',{from:'https://evil.example',showCorrected:'yes'})).toBe('/admin/personnel/employee/movement/view/event');
  expect(movementPageHref('employee','history',undefined,{showCorrected:'1',from:'org'})).toBe('/admin/personnel/employee/movement/history?showCorrected=1&from=org');
 });
});


describe('original-hire correction lineage',()=>{
 it.each(['hiredOn','joinDate','gradeId','employmentType','contractEndDate','internshipEndDate'] as const)('keeps %s attached to Hired despite its own secondary writer',field=>{
  const rows=[{...row('hire',1,'hired'),effectiveDate:'2020-01-01'},{...row('later',3),effectiveDate:'2026-01-01'}];
  const writer=field==='gradeId'?'employment.grade.changed':field==='employmentType'?'employment.assignment.changed':'employment.info.updated';
  const events=[event('hire',1,'employment.hired',{}),event('secondary',5,writer,{fields:[field],before:{[field]:'old'},after:{[field]:'corrected'},movement:{groupId:'private-correction',secondary:true}}),event('correction',6,'employment.information.corrected',{source:'original-hire',hiredEventId:'hire',dated:true,effectiveOn:'2020-02-01',fields:[field],after:{[field]:'corrected'},until:{}})];
  const result=personnelInformationCorrections(events,rows);
  expect(result.get('hire')).toEqual([{eventId:'correction',fields:[field],values:{[field]:'corrected'},needsReview:false}]);
  expect(result.get('later')?.[0].values[field]).toBe('corrected');
 });
 it('retains a later deliberate grade and its Before value at the date boundary',()=>{
  const rows=[{...row('hire',1,'hired'),effectiveDate:'2020-01-01'},{...row('promotion',8,'promotion','promotion'),effectiveDate:'2026-03-01'},{...row('promotion:before',7.5),effectiveDate:'2026-03-01'}];
  const events=[event('hire',1,'employment.hired',{}),event('correction',5,'employment.information.corrected',{source:'original-hire',hiredEventId:'hire',dated:true,effectiveOn:'2020-01-01',fields:['gradeId'],after:{gradeId:'corrected'},until:{}}),event('later-grade',9,'employment.grade.changed',{before:'corrected',after:'later',movement:{groupId:'promotion'}})];
  const result=personnelInformationCorrections(events,rows);
  expect(result.get('hire')?.[0].values.gradeId).toBe('corrected');
  expect(result.has('promotion')).toBe(false);
 });
 it('respects each saved boundary and preserves explicit clears on repeat corrections',()=>{
  const rows=[{...row('hire',1,'hired'),effectiveDate:'2020-01-01'},{...row('later',3),effectiveDate:'2026-03-01'}];
  const events=[event('hire',1,'employment.hired',{}),event('first',5,'employment.information.corrected',{source:'original-hire',dated:true,effectiveOn:'2020-01-01',fields:['gradeId','employmentType'],after:{gradeId:'first',employmentType:'contract'},until:{employmentType:'2026-03-01'}}),event('second',6,'employment.information.corrected',{source:'original-hire',dated:true,effectiveOn:'2020-01-01',fields:['gradeId'],after:{gradeId:null},until:{gradeId:'2026-03-01'}})];
  const result=personnelInformationCorrections(events,rows);
  expect(result.get('hire')?.at(-1)?.values.gradeId).toBeNull();
  expect(result.get('later')).toEqual([{eventId:'first',fields:['gradeId'],values:{gradeId:'first'},needsReview:false}]);
 });
});
