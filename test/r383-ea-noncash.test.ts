import { describe, expect, it } from 'vitest';
import { accumulatedEaNonCash, eaNonCashExemption } from '../localization/my/ea-noncash';

const recurringId='11111111-1111-4111-8111-111111111111';
const transactionId='22222222-2222-4222-8222-222222222222';
const benefit={kind:'bik',code:'CAR',source:'recurring',sourceId:recurringId,entered:200,exempt:50,taxable:150,exemptionCode:'PCB_TRAVEL'};
const eaBenefit={kind:'bik',code:'CAR',source:'recurring',sourceId:recurringId,entered:200,reportableAmount:150,exemptAmount:50,exemptionCode:'PCB_TRAVEL',eaFormLine:'EA_B3',subjectPCB:true};
const zero={entered:0,exempt:0,taxable:0};
const regular=()=>({pcbNonCash:{version:1,current:{bik:{entered:200,exempt:50,taxable:150},vola:{...zero}},ownedCurrent:{bik:{entered:200,exempt:50,taxable:150},vola:{...zero}},owned:{bik:150,vola:0},cumulative:{bik:150,vola:0},before:{bik:0,vola:0},accumulated:{bik:0,vola:0,complete:true},cashNormal:1000,entries:[{...benefit}],ownedEntries:[{...benefit}],eaEntries:[{...eaBenefit}],ownedEaEntries:[{...eaBenefit}]},exemptionUsed:{PCB_TRAVEL:50}});
const additional=()=>({pcbNonCash:{version:1,current:{bik:{entered:200,exempt:50,taxable:150},vola:{...zero}},ownedCurrent:{bik:{...zero},vola:{...zero}},owned:{bik:0,vola:0},cumulative:{bik:150,vola:0},before:{bik:150,vola:0},accumulated:{bik:0,vola:0,complete:true},cashNormal:1000,entries:[{...benefit}],ownedEntries:[],eaEntries:[{...eaBenefit},{kind:'vola',code:'HOUSE',source:'one_off',sourceId:transactionId,entered:80,reportableAmount:80,exemptAmount:0,eaFormLine:'EA_B4',subjectPCB:false}],ownedEaEntries:[{kind:'vola',code:'HOUSE',source:'one_off',sourceId:transactionId,entered:80,reportableAmount:80,exemptAmount:0,eaFormLine:'EA_B4',subjectPCB:false}]},exemptionUsed:{PCB_TRAVEL:20}});

describe('r383 saved annual noncash reporting',()=>{
 it('counts run-owned B3/B4 once rather than repeating cumulative monthly benefits',()=>{
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:regular()},{payPeriod:'2026-07',statutory:additional()}])).toEqual({complete:true,benefitsInKind:150,livingAccommodation:80,unmapped:[]});
 });
 it('does not treat PCB inclusion as the independent frozen EA reporting decision',()=>{
  const s=additional();s.pcbNonCash.ownedEaEntries[0].subjectPCB=false;
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:s}]).livingAccommodation).toBe(80);
  s.pcbNonCash.ownedEaEntries[0].eaFormLine='';
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:s}])).toMatchObject({livingAccommodation:0,unmapped:['HOUSE']});
 });
 it('does not label partial new evidence as a full annual figure',()=>{
  expect(accumulatedEaNonCash([{payPeriod:'2026-06',statutory:{}},{payPeriod:'2026-07',statutory:regular()}])).toMatchObject({complete:false,benefitsInKind:0,livingAccommodation:0});
  expect(accumulatedEaNonCash([]).complete).toBe(false);
 });
 it('refuses repeated recurring ownership and one-off transaction ownership',()=>{
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:regular()},{payPeriod:'2026-07',statutory:regular()}]).complete).toBe(false);
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:additional()},{payPeriod:'2026-08',statutory:additional()}]).complete).toBe(false);
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:regular()},{payPeriod:'2026-08',statutory:regular()}]).benefitsInKind).toBe(300);
 });
 it('keeps noncash exemptions out of the cash allowance subtraction and counts the ledger once',()=>{
  const s=regular();s.exemptionUsed.PCB_TRAVEL=70;
  const noncash=eaNonCashExemption(s);
  expect(noncash).toBe(50);
  expect(250-(s.exemptionUsed.PCB_TRAVEL-noncash)).toBe(230);
  expect(s.exemptionUsed.PCB_TRAVEL).toBe(70);
  expect(eaNonCashExemption(additional())).toBe(0);
  expect(eaNonCashExemption({exemptionUsed:{PCB_TRAVEL:30}})).toBe(0);
 });
 it('refuses invented or unrecorded noncash exemptions before figures are produced',()=>{
  const s=regular();s.exemptionUsed.PCB_TRAVEL=49;
  expect(()=>eaNonCashExemption(s)).toThrow();
  const t=regular();t.pcbNonCash.ownedEaEntries[0].subjectPCB=false;
  expect(()=>eaNonCashExemption(t)).toThrow();
  const u=regular();u.pcbNonCash.ownedEaEntries[0].reportableAmount=999;
  expect(()=>eaNonCashExemption(u)).toThrow();
 });
 it('refuses wrong benefit mapping without rerouting it to cash gross',()=>{
  const s=regular();s.pcbNonCash.ownedEaEntries[0].eaFormLine='EA_B4';
  expect(accumulatedEaNonCash([{payPeriod:'2026-07',statutory:s}])).toMatchObject({complete:false,benefitsInKind:0,livingAccommodation:0});
 });
});
