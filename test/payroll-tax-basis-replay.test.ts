import {describe,it,expect} from 'vitest';
import {replayMyTaxBasis,type TaxBasisReplayInput,type TaxBasisItemSetting} from '../localization/my/tax-basis-replay';
import {statutory,foldPriorSlipIntoAccumulators,openingAccumulatorsFromTp3} from '../localization/my/payroll';
import {DEFAULT_MY_STATUTORY} from '../localization/my/statutory-tables';
const basic:TaxBasisItemSetting={id:'basic',code:'BASIC',name:'Basic salary',kind:'earning',includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:null,isNonPayable:false,epfBonus2012:false};
const travel:TaxBasisItemSetting={...basic,id:'travel',code:'TRAVEL',name:'Travel allowance'};
function input():TaxBasisReplayInput{return{year:2026,upToMonth:3,settings:[basic,travel],openingExemptionUsed:{},rulesByPeriod:Object.fromEntries(['01','02','03'].map(m=>[`2026-${m}`,{rules:DEFAULT_MY_STATUTORY,hash:`verified-${m}`} ])),slips:['01','02','03'].map(m=>({id:`slip-${m}`,period:`2026-${m}`,runOrder:1,sourceLines:[{code:'BASIC',amount:5000,direction:'earning' as const},{code:'TRAVEL',amount:500,direction:'earning' as const}],statutory:{pcb:10,epfEmployee:550,lp:0,zakat:0},expectedGross:5500,expectedOtherDeductions:0}))};}
describe('explicit historical tax basis replay',()=>{
 it('replays the reported RM500 January–March amounts without changing actual transactions or tax paid',()=>{const p=input(),original=structuredClone(p);const rows=replayMyTaxBasis(p);expect(rows.map(r=>r.basis.pcb)).toEqual([5500,5500,5500]);expect(rows.reduce((n,r)=>n+r.basis.pcb,0)-15000).toBe(1500);expect(rows[0].basis.items[1].previousTreatment).toBeNull();expect(p).toEqual(original);expect(p.slips.map(s=>s.statutory.pcb)).toEqual([10,10,10]);});
 it('honors a latest non-taxable flag without borrowing other statutory flags',()=>{const p=input();p.settings[1]={...travel,includedInPcb:false};expect(replayMyTaxBasis(p).map(r=>[r.basis.pcb,r.basis.exempt])).toEqual([[5000,500],[5000,500],[5000,500]]);});
 it('consumes annual exemption headroom after TP3 exactly once in stable chronological order',()=>{const p=input();p.settings[1]={...travel,pcbExemptionCode:'PCB_TRA_BUSINESS'};p.openingExemptionUsed={PCB_TRA_BUSINESS:5250};p.slips.reverse();const rows=replayMyTaxBasis(p);expect(rows.map(r=>r.payslipId)).toEqual(['slip-01','slip-02','slip-03']);expect(rows.map(r=>r.basis.pcb)).toEqual([5000,5250,5500]);expect(rows.map(r=>r.basis.exemptionUsed)).toEqual([{PCB_TRA_BUSINESS:500},{PCB_TRA_BUSINESS:250},{}]);expect(replayMyTaxBasis(p)).toEqual(rows);expect(p.openingExemptionUsed.PCB_TRA_BUSINESS).toBe(5250);});
 it('keeps additional remuneration separate while sharing one annual ledger',()=>{const p=input();p.settings[1]={...travel,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TRA_BUSINESS'};p.openingExemptionUsed={PCB_TRA_BUSINESS:5750};const rows=replayMyTaxBasis(p);expect(rows.map(r=>[r.basis.normal,r.basis.additional])).toEqual([[5000,250],[5000,500],[5000,500]]);});
 it('computes optional deduction once and preserves explicitly saved TP1 relief',()=>{const p=input();p.slips=p.slips.slice(0,1);p.settings.push({...travel,id:'lp',code:'LP',kind:'deduction',pcbRemunerationType:'optional_deduction',pcbExemptionCode:'LP_SPORT_EQUIPMENT'});p.slips[0].sourceLines.push({code:'LP',amount:100,direction:'deduction'});p.slips[0].expectedOtherDeductions=100;p.slips[0].statutory={lp:125,lpDetail:{tp1:25,declaredComponents:100},pcb:10};const row=replayMyTaxBasis(p)[0];expect(row.basis.lp).toBe(125);expect(row.basis.pcb).toBe(5500);expect(row.basis.exemptionUsed).toEqual({LP_SPORT_EQUIPMENT:100});});
 it('refuses an ambiguous saved LP split rather than double-counting it',()=>{const p=input();p.slips[0].statutory.lp=100;expect(()=>replayMyTaxBasis(p)).toThrow(/split is unavailable/);});
 it('refuses incomplete lines, unmapped codes, unsupported years and noncash provenance',()=>{let p=input();p.slips[0].sourceLines.pop();expect(()=>replayMyTaxBasis(p)).toThrow(/reconcile/);p=input();p.settings.pop();expect(()=>replayMyTaxBasis(p)).toThrow(/missing, archived/);p=input();p.year=2025;p.slips[0].period='2025-01';p.rulesByPeriod['2025-01']=p.rulesByPeriod['2026-01'];expect(()=>replayMyTaxBasis(p)).toThrow(/different assessment year/);p=input();p.slips[0].statutory.pcbNonCash={owned:{bik:100,vola:0}};expect(()=>replayMyTaxBasis(p)).toThrow(/noncash/);});
 it('refuses out-of-cutoff records, duplicate identities and ambiguous run order',()=>{let p=input();p.upToMonth=2;expect(()=>replayMyTaxBasis(p)).toThrow(/outside/);p=input();p.slips[1].id=p.slips[0].id;expect(()=>replayMyTaxBasis(p)).toThrow(/more than once/);p=input();p.slips[1].period=p.slips[0].period;expect(()=>replayMyTaxBasis(p)).toThrow(/run order/);});
 it('reduces only the tax base for a taxable payroll deduction',()=>{const p=input();p.slips=p.slips.slice(0,1);p.settings.push({...basic,id:'unpaid',code:'UNPAID',kind:'deduction'});p.slips[0].sourceLines.push({code:'UNPAID',amount:100,direction:'deduction'});p.slips[0].expectedOtherDeductions=100;expect(replayMyTaxBasis(p)[0].basis.pcb).toBe(5400);expect(p.slips[0].expectedGross).toBe(5500);});
 it('requires known year-specific exemption codes and unambiguous latest classifications',()=>{let p=input();p.settings[1]={...travel,pcbExemptionCode:'PCB_UNKNOWN'};expect(()=>replayMyTaxBasis(p)).toThrow(/unsupported/);p=input();p.settings[1]={...travel,pcbRemunerationType:null};expect(()=>replayMyTaxBasis(p)).toThrow(/explicit supported/);p=input();p.settings.push({...travel});expect(()=>replayMyTaxBasis(p)).toThrow(/ambiguous/);});
});

describe('corrected PCB input seam',()=>{
 it('changes only PCB when an earlier same-month income basis changes',()=>{
  const original=statutory(5000,undefined,1000,100,{month:1},{resident:false});
  const corrected=statutory(5000,undefined,1000,100,{month:1},{resident:false,pcbCashNormalOverride:5500,pcbAdditionalOverride:0});
  expect(corrected.pcb).toBe(1650);expect(original.pcb).toBe(1830);
  for(const key of ['epfEmployee','epfEmployer','socsoEmployee','socsoEmployer','socsoSkbbk','eisEmployee','eisEmployer'] as const)expect(corrected[key]).toBe(original[key]);
 });
 it('folds a corrected basis while preserving the actual PCB and EPF paid',()=>{
  const acc=openingAccumulatorsFromTp3(null,4000);
  foldPriorSlipIntoAccumulators(acc,{gross:5500,statutory:{bases:{pcb:5400},epfEmployee:550,pcb:35,lp:0,zakat:0}},4000);
  expect(acc.grossRemuneration).toBe(5400);expect(acc.netRemuneration).toBe(4850);expect(acc.epfClaimed).toBe(550);expect(acc.pcbPaid).toBe(35);
 });
 it('rejects negative or nonfinite reviewed inputs',()=>{
  expect(()=>statutory(5000,undefined,0,0,undefined,{pcbCashNormalOverride:-1})).toThrow(/Invalid reviewed/);
  expect(()=>statutory(5000,undefined,0,0,undefined,{pcbAdditionalOverride:NaN})).toThrow(/Invalid reviewed/);
 });
});
