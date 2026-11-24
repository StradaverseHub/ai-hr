/** Board item 0af23331, owner decision 23 November 2026 (ADR-0167). Pure resolution of the accepted-TP3 opening. */
import {describe,expect,it} from 'vitest';
import {positiveOpening,resolveTp3Opening,summarizeExemptionLedger,taxOpeningDigestRow,type TaxOpeningRow} from '../lib/payroll-tax-opening-tp3';
import type {TaxBasisLedgerEntry} from '../lib/payroll-tax-basis';

const base:TaxOpeningRow={id:'employment-a',access:true,tp3Id:null,tp3Revision:null,tp3Payload:null,projection:false,projectionUsed:null,projectionRevision:null,declared:null,answerId:null};
const form=(payload:unknown)=>payload&&typeof payload==='object'&&'fixtureUse' in payload?(payload as {fixtureUse:Record<string,number>}).fixtureUse:null;

describe('accepted TP3 opening resolution',()=>{
 it('prefers the canonical accepted form over the statutory projection',()=>{
  const row={...base,tp3Id:'tp3-a',tp3Revision:'11:2026-04-02',tp3Payload:{fixtureUse:{PCB_TRA_BUSINESS:5500}},projection:true,projectionUsed:{PCB_TRA_BUSINESS:1},projectionRevision:'9'};
  expect(resolveTp3Opening(row,form)).toEqual({state:'resolved',opening:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:5500},tp3:{kind:'form',id:'tp3-a',revision:'11:2026-04-02'}}});
 });
 it('falls back to the projection for the year with the live payroll filter',()=>{
  const row={...base,projection:true,projectionUsed:{PCB_TRA_HOLIDAY:'250.25',PCB_TRA_BUSINESS:1200,PCB_CHILD_CARE:0,PCB_PERQUISITE:-5,BAD:'x'},projectionRevision:'42'};
  expect(resolveTp3Opening(row,form)).toEqual({state:'resolved',opening:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:1200,PCB_TRA_HOLIDAY:250.25},tp3:{kind:'statutory_projection',id:null,revision:'42'}}});
 });
 it('treats an accepted form without Section C as no exemption use, never a guess',()=>{
  expect(resolveTp3Opening({...base,tp3Id:'tp3-b',tp3Revision:'1'},form)).toMatchObject({state:'resolved',opening:{source:'accepted_tp3',used:{}}});
  expect(resolveTp3Opening({...base,tp3Id:'tp3-c',tp3Revision:'1',tp3Payload:{form:'unknown'}},form)).toMatchObject({state:'unreadable'});
 });
 it('uses RM0 without an accepted TP3, even when a previous employer was declared, and says so',()=>{
  expect(resolveTp3Opening({...base,declared:true,answerId:'answer-a'},form)).toEqual({state:'resolved',opening:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:true}});
  expect(resolveTp3Opening({...base,declared:false},form)).toEqual({state:'resolved',opening:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:false}});
  expect(resolveTp3Opening(base,form)).toMatchObject({opening:{previousEmployerDeclared:false}});
 });
 it('never turns hidden or missing access into a zero',()=>{
  expect(resolveTp3Opening({...base,access:false},form)).toEqual({state:'access_insufficient'});
  expect(resolveTp3Opening(undefined,form)).toEqual({state:'access_insufficient'});
 });
 it('changes the digest descriptor when a TP3 appears, changes revision, the projection changes or a new answer is given',()=>{
  const digest=(row:TaxOpeningRow)=>JSON.stringify(taxOpeningDigestRow(row));
  const before=digest(base);
  for(const changed of [{...base,tp3Id:'tp3-a',tp3Revision:'1'},{...base,projection:true,projectionRevision:'2',projectionUsed:{}},{...base,declared:true,answerId:'a'},{...base,access:false}])expect(digest(changed)).not.toBe(before);
  expect(digest({...base,tp3Id:'tp3-a',tp3Revision:'1'})).not.toBe(digest({...base,tp3Id:'tp3-a',tp3Revision:'2'}));
 });
 it('keeps positive amounts only, sorted by code',()=>{expect(Object.keys(positiveOpening({Z:1,A:2,C:0}))).toEqual(['A','Z']);expect(positiveOpening(null)).toEqual({});});
});

describe('exemption ledger summary',()=>{
 const entry=(period:string,usedBefore:number,eligible:number,exempt:number,code='PCB_TRA_BUSINESS',cap=6000):TaxBasisLedgerEntry=>({payslipId:'slip-'+period,period,itemCode:'A0080',itemName:'Travel Allowance',code,cap,usedBefore,remainingBefore:Math.max(0,cap-usedBefore),eligible,exempt,excess:eligible-exempt,usedAfter:usedBefore+exempt,remainingAfter:Math.max(0,cap-usedBefore-exempt)});
 it('reports limit, opening and source, this company, remaining and taxable excess per code',()=>{
  // Mock-up figures: RM1,200 from an accepted TP3, then RM800 a month April to November.
  const rows=Array.from({length:8},(_,i)=>{const before=1200+800*i;const exempt=Math.max(0,Math.min(800,6000-before));return entry(`2026-${String(i+4).padStart(2,'0')}`,Math.min(before,6000),800,exempt);});
  expect(summarizeExemptionLedger(rows,{PCB_TRA_BUSINESS:1200},'accepted_tp3')).toEqual([{code:'PCB_TRA_BUSINESS',cap:6000,openingUsed:1200,openingSource:'accepted_tp3',eligible:6400,exempt:4800,excess:1600,usedAfter:6000,remaining:0,items:[{code:'A0080',name:'Travel Allowance'}]}]);
 });
 it('keeps codes independent and ordered',()=>{
  const summary=summarizeExemptionLedger([entry('2026-01',0,500,500,'PCB_TRA_HOLIDAY',3000),entry('2026-01',0,800,800)],{},'no_accepted_tp3');
  expect(summary.map(code=>[code.code,code.openingUsed,code.remaining])).toEqual([['PCB_TRA_BUSINESS',0,5200],['PCB_TRA_HOLIDAY',0,2500]]);
 });
});
