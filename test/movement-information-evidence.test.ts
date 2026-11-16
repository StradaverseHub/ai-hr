import {describe,expect,it} from 'vitest';
import {movementInformationEvidence} from '../lib/movement-information-evidence';
const hire={id:'hired',eventType:'employment.hired',sequence:1,occurredAt:new Date('2026-01-02T01:00:00Z'),payload:{hiredOn:'2026-01-01',employmentInformation:{joinDate:'2026-01-01',orgDivision:'Original',confirmationDate:null,probationValue:3,probationUnit:'month'}}};
const change={id:'later',eventType:'employment.info.updated',sequence:2,occurredAt:new Date('2026-03-02T01:00:00Z'),payload:{before:{orgDivision:'Original'},after:{orgDivision:'Later'},movement:{effectiveDate:'2026-03-01'}}};
describe('recorded full employment information',()=>{
 it('keeps an immutable hire assertion and selects later facts by Effective Date',()=>{
  expect(movementInformationEvidence([hire,change],'2026-01-01',2).orgDivision).toEqual({known:true,value:'Original',eventId:'hired'});
  expect(movementInformationEvidence([hire,change],'2026-03-01',2).orgDivision.value).toBe('Later');
  expect(movementInformationEvidence([hire,change],'2026-03-01',1).orgDivision.value).toBe('Original');
 });
 it('distinguishes a recorded blank from an unrecorded legacy fact',()=>{
  const facts=movementInformationEvidence([hire],'2026-01-01',1);
  expect(facts.confirmationDate).toEqual({known:true,value:null,eventId:'hired'});
  expect(facts.resignationDate).toEqual({known:false,value:null,eventId:null});
  expect(facts.probationValue.value).toBe('3');
 });
 it('applies only the bounded original-hire correction and retains later decisions',()=>{
  const correction={id:'correction',eventType:'employment.information.corrected',sequence:3,occurredAt:new Date('2026-05-01T00:00:00Z'),payload:{effectiveOn:'2026-01-01',fields:['orgDivision'],after:{orgDivision:'Corrected'},until:{orgDivision:'2026-03-01'}}};
  expect(movementInformationEvidence([hire,change,correction],'2026-02-01',3).orgDivision.value).toBe('Corrected');
  expect(movementInformationEvidence([hire,change,correction],'2026-04-01',3).orgDivision.value).toBe('Later');
 });
 it('retains initialization in the hire transaction and carries its facts across a corrected earlier start',()=>{
  const initialization={...change,id:'initial',occurredAt:hire.occurredAt,payload:{after:{noticeAfterConfirmationValue:2,noticeAfterConfirmationUnit:'month'}}};
  const correction={id:'corrected-start',eventType:'employment.information.corrected',sequence:3,occurredAt:new Date('2026-05-01T00:00:00Z'),payload:{source:'original-hire',effectiveOn:'2025-12-15',fields:['hiredOn'],after:{hiredOn:'2025-12-15'}}};
  const facts=movementInformationEvidence([hire,initialization,correction],'2025-12-15',3);
  expect(facts.orgDivision.value).toBe('Original');expect(facts.hiredOn.value).toBe('2025-12-15');expect(facts.noticeAfterConfirmationValue.value).toBe('2');expect(facts.noticeAfterConfirmationUnit.value).toBe('month');
 });
 it('never treats pending targets as applied employment facts',()=>{
  const pending={...change,eventType:'employment.movement.scheduled'};
  expect(movementInformationEvidence([hire,pending],'2026-04-01',2).orgDivision.value).toBe('Original');
 });
});
