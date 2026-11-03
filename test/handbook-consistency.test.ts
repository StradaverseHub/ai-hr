/** AI v2 Phase 2 hardening — what a policy's text states about enforceable settings, read deterministically, and
 * whether it agrees with what the system enforces (core/handbook/consistency.ts; pure, no database, no model).
 *
 * The review's case: the published text says RM1.00/km while the claims service enforces RM0.60. Every expected
 * statement, span and disagreement below is written out by hand from the fictional texts. */
import {describe,expect,it} from 'vitest';
import {disagreements,mentionedSettings,policyStatements,readStatedFigures,type StatedValue} from '../core/handbook/consistency';
import type {SettingBody,SettingTarget} from '../core/handbook/types';

const CLAIMS=['claims.mileage_rates','claims.submit_within_days'] as const;
const TYPES=[{code:'MILEAGE',name:'Mileage'},{code:'MEDICAL',name:'Medical'}];
const SIXTY:SettingBody={bands:[{fromKm:0,toKm:null,ratePerKm:0.6}]};
const owner=(table:Record<string,SettingBody|null>)=>(setting:string,target:SettingTarget)=>table[`${setting}|${target.claimType??''}`]??null;

describe('the deterministic read',()=>{
 it('finds each mileage rate and claim submission window, with its exact words',()=>{
  const text='Mileage is reimbursed at RM1.00/km. Long trips are paid RM 0.45 per km. Medical claims must be submitted within 14 days. '
   +'Parking costs RM 20 a day.\nAll claims are filed within 60 days. Leave must be taken within 30 days of approval.';
  const found=readStatedFigures(text,CLAIMS,TYPES);
  expect(found.map(s=>[s.setting,s.target,s.figures,s.quote,text.slice(s.start,s.end)])).toEqual([
   ['claims.mileage_rates',{},[1],'RM1.00/km','RM1.00/km'],
   ['claims.mileage_rates',{},[0.45],'RM 0.45 per km','RM 0.45 per km'],
   ['claims.submit_within_days',{claimType:'MEDICAL'},[14],'within 14 days','within 14 days'],
   // Names no claim type, so it holds for every claim type. The leave sentence is not about claims, and RM 20 a day is not per km.
   ['claims.submit_within_days',null,[60],'within 60 days','within 60 days']]);
  // A setting the owners do not hold is not read.
  expect(readStatedFigures(text,['claims.submit_within_days'],TYPES).map(s=>s.setting)).toEqual(['claims.submit_within_days','claims.submit_within_days']);
 });
});

describe('statements against what the system enforces',()=>{
 const TEXT='Mileage is reimbursed at RM1.00/km.';
 const value=(decision:'confirmed'|'rejected'|null,rate=1):StatedValue=>({id:'00000000-0000-4000-8000-0000000000f1',setting:'claims.mileage_rates',target:{},
  value:{bands:[{fromKm:0,toKm:null,ratePerKm:rate}]},spans:[{start:25,end:34,quote:'RM1.00/km',part:'band.0.rate'}],decision});
 it('RM1.00 in the text against RM0.60 in the claims service disagrees, read or not, rejected or not',()=>{
  for(const values of [[],[value('rejected')],[value(null)]]){
   const statements=policyStatements(TEXT,CLAIMS,TYPES,values);
   // The deterministic read covers the value's words, so the figure is reported once, from the text.
   expect(statements.map(s=>[s.source,s.figures,s.quote])).toEqual([['text',[1],'RM1.00/km']]);
   expect(disagreements(statements,owner({'claims.mileage_rates|':SIXTY}),['MILEAGE']).map(d=>[d.statement.quote,d.enforced])).toEqual([['RM1.00/km',SIXTY]]);
   expect(mentionedSettings(statements,values)).toEqual(['claims.mileage_rates']);
  }
  // No table at all is a disagreement too: the text states a rate the system does not apply.
  expect(disagreements(policyStatements(TEXT,CLAIMS,TYPES,[]),owner({}),[]).length).toBe(1);
 });
 it('agrees when the figure is one the system enforces, or the value the version would apply once approved',()=>{
  const statements=policyStatements(TEXT,CLAIMS,TYPES,[value('confirmed')]);
  expect(statements.map(s=>[s.source,s.confirmedWords])).toEqual([['text',true]]);
  expect(disagreements(statements,owner({'claims.mileage_rates|':{bands:[{fromKm:0,toKm:500,ratePerKm:0.6},{fromKm:500,toKm:null,ratePerKm:1}]}}),[])).toEqual([]);
 });
 it('a window naming no claim type is held against every claim type; one inherits the claim type of a value read from its words',()=>{
  const text='Claims must be submitted within 30 days.';
  const generic=policyStatements(text,CLAIMS,TYPES,[]);
  const found=disagreements(generic,owner({'claims.submit_within_days|MILEAGE':{days:30},'claims.submit_within_days|MEDICAL':{days:45}}),['MILEAGE','MEDICAL']);
  expect(found.map(d=>[d.target,d.enforced])).toEqual([[{claimType:'MEDICAL'},{days:45}]]);
  const read:StatedValue={id:'00000000-0000-4000-8000-0000000000f2',setting:'claims.submit_within_days',target:{claimType:'MILEAGE'},value:{days:30},
   spans:[{start:25,end:39,quote:'within 30 days',part:'days'}],decision:'rejected'};
  const targeted=policyStatements(text,CLAIMS,TYPES,[read]);
  expect(targeted.map(s=>[s.source,s.target])).toEqual([['text',{claimType:'MILEAGE'}]]);
  expect(disagreements(targeted,owner({'claims.submit_within_days|MILEAGE':{days:30},'claims.submit_within_days|MEDICAL':{days:45}}),['MILEAGE','MEDICAL'])).toEqual([]);
 });
 it('a leave value that is not confirmed is compared by its own figures, as there is no deterministic read for leave',()=>{
  const text='Annual leave is 14 days a year.';
  const leave:StatedValue={id:'00000000-0000-4000-8000-0000000000f3',setting:'leave.entitlement_days',target:{leaveType:'ANNUAL'},value:{bands:[{fromYears:0,toYears:null,days:14}]},
   spans:[{start:16,end:23,quote:'14 days',part:'band.0.days'}],decision:'rejected'};
  const statements=policyStatements(text,[...CLAIMS,'leave.entitlement_days'],TYPES,[leave]);
  expect(statements.map(s=>[s.source,s.setting,s.figures,s.quote])).toEqual([['value','leave.entitlement_days',[14],'14 days']]);
  const table:SettingBody={bands:[{fromYears:0,toYears:2,days:12},{fromYears:2,toYears:null,days:16}]};
  expect(disagreements(statements,(_s,t)=>t.leaveType==='ANNUAL'?table:null,[]).map(d=>d.enforced)).toEqual([table]);
 });
});
