import { describe, expect, it } from 'vitest';
import { evidenceFieldsSchema, patchEvidenceFields, standingResponses, upsertEvidenceResponse } from '../packs/performance/onehr/evidence-model';
import { todayInKualaLumpur } from '../lib/hr-date';
const original=evidenceFieldsSchema.parse({kind:'delivery',body:'Completed the programme.',occurredOn:todayInKualaLumpur(),title:'Programme',impact:'Reduced handling time',who:'Operations team',precision:'month',metricValue:25,metricUnit:'hours'});
describe('Source evidence slot and standing-verdict rules',()=>{
 it('preserves every absent slot during a partial draft edit',()=>{
  expect(patchEvidenceFields(original,{body:'Completed the revised programme.'})).toEqual({...original,body:'Completed the revised programme.'});
  expect(patchEvidenceFields(original,{})).toEqual(original);
 });
 it('clears only explicitly empty optional slots and preserves a stated calendar date',()=>{
  expect(patchEvidenceFields(original,{impact:'',metricValue:null})).toEqual({...original,impact:'',metricValue:null});
  expect(()=>patchEvidenceFields(original,{body:''})).toThrow();expect(()=>patchEvidenceFields(original,{occurredOn:'not-a-date'})).toThrow();
  expect(()=>patchEvidenceFields(original,{authorUserId:'forged'})).toThrow();
 });
 it('keeps one current verdict per reviewer without rewriting another reviewer’s stored response',()=>{
  const responses=[{userId:'a',stance:'endorse'},{userId:'b',stance:'endorse'},{userId:'a',stance:'dispute'}];
  expect(standingResponses(responses)).toEqual([{userId:'a',stance:'dispute'},{userId:'b',stance:'endorse'}]);
  expect(upsertEvidenceResponse(responses,{userId:'a',stance:'endorse'})).toEqual([{userId:'a',stance:'endorse'},{userId:'b',stance:'endorse'}]);
  expect(upsertEvidenceResponse(responses,{userId:'b',stance:'dispute'})).toEqual([{userId:'a',stance:'endorse'},{userId:'b',stance:'dispute'},{userId:'a',stance:'dispute'}]);
 });
});
