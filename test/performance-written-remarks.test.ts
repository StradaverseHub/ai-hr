import {describe,it,expect} from 'vitest';
import {plainWrittenRemarks,writtenRemarksSource,potentialWrittenRemarks,tidyWrittenRemarks,writtenRemarksError,type WrittenRemark} from '../packs/performance/onehr/written-remarks-model';
import golden from './fixtures/onehr/written-remarks-golden.json';
describe('Attributed written remarks source parity',()=>{
 it('matches the original source attribution, fencing and fallback in every golden case',()=>{expect(golden.length).toBe(34);for(const c of golden){const entries=c.entries as WrittenRemark[];expect(plainWrittenRemarks(entries)).toBe(c.plain);expect(writtenRemarksSource(entries)).toBe(c.source);}});
 it('never treats pending manager text as submitted or exposes anonymous feedback in the written stream',()=>{
 const s={name:'Nadia',tier:'hod',status:'submitted',selfRemark:'My submitted words.',managerRemark:'PRIVATE',managerName:'Marcus',competencies:[{title:'Service',future:false,selfRemark:'Own item note.',managerRemark:'PRIVATE ITEM'}],trail:[]};
 expect(potentialWrittenRemarks(s)).toHaveLength(2);expect(JSON.stringify(potentialWrittenRemarks(s))).not.toContain('PRIVATE');expect(potentialWrittenRemarks({...s,status:'reviewed'})).toHaveLength(4);expect(potentialWrittenRemarks({...s,status:'pending'})).toEqual([]);
 });
 it('removes missing-author commentary, refuses rating advice and fabricated figures while accepting equivalent figure words',()=>{
 const entries:WrittenRemark[]=[{role:'self',who:'Their own remark',on:null,move:null,text:'I completed 5 units worth RM 14.3 mil.'}];
 expect(tidyWrittenRemarks('They completed the work. No HOD remark is provided.')).toBe('They completed the work.');
 expect(writtenRemarksError(entries,'Nadia','pm','They completed five units worth RM 14.3 million.')).toBeNull();
 expect(writtenRemarksError(entries,'Nadia','pm','They completed 8 units.')).toBeTruthy();expect(writtenRemarksError(entries,'Nadia','pot','They deserve a High rating.')).toBeTruthy();
 });
});
