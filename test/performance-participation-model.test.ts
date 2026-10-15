import { describe, expect, it } from 'vitest';
import { assessmentParticipation, serviceBeyondYear } from '../packs/performance/onehr/participation-model';
const openedOn='2026-10-01';
const candidate={left:false,yearsOfService:0.5,confirmationDate:null};
describe('source participation rules',()=>{
 it('excludes unconfirmed staff from their own review without requiring assessor confirmation',()=>{
  expect(assessmentParticipation(candidate,openedOn)).toEqual({takingPart:false,reason:'not_confirmed'});
 });
 it('uses confirmation on or before opening, including the exact boundary',()=>{
  for(const date of ['2026-09-30','2026-10-01'])expect(assessmentParticipation({...candidate,confirmationDate:date},openedOn)).toEqual({takingPart:true,reason:'confirmed'});
  expect(assessmentParticipation({...candidate,confirmationDate:'2026-10-02'},openedOn)).toEqual({takingPart:false,reason:'confirmed_after_open'});
 });
 it('requires strictly more than one year and never treats missing service as confirmation',()=>{
  for(const yearsOfService of [null,0,0.9,1])expect(assessmentParticipation({...candidate,yearsOfService},openedOn).takingPart).toBe(false);
  expect(assessmentParticipation({...candidate,yearsOfService:1.01},openedOn)).toEqual({takingPart:true,reason:'confirmed'});
  expect(assessmentParticipation({...candidate,yearsOfService:2,confirmationDate:'2026-10-02'},openedOn).takingPart).toBe(true);
 });
 it('lets HR add an unconfirmed person or remove a confirmed one; leavers always lose participation',()=>{
  expect(assessmentParticipation({...candidate,override:'add'},openedOn)).toEqual({takingPart:true,reason:'added'});
  expect(assessmentParticipation({...candidate,yearsOfService:2,override:'remove'},openedOn)).toEqual({takingPart:false,reason:'removed'});
  for(const override of ['add','remove',null] as const)expect(assessmentParticipation({...candidate,left:true,yearsOfService:2,override},openedOn)).toEqual({takingPart:false,reason:'left'});
 });
 it('keeps the native service-date adapter strict at an anniversary and across leap years',()=>{
  expect(serviceBeyondYear('2025-10-01','2026-10-01')).toBe(false);
  expect(serviceBeyondYear('2025-10-01','2026-10-02')).toBe(true);
  expect(serviceBeyondYear('2024-02-29','2025-02-28')).toBe(false);
  expect(serviceBeyondYear('2024-02-29','2025-03-01')).toBe(true);
 });
});
