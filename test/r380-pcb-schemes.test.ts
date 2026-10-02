import {describe,it,expect} from 'vitest';
import {pcbMonth, statutory, resolvePcbCalculationScheme} from '../localization/my/payroll';
import {DEFAULT_MY_STATUTORY, MY_PCB_INCENTIVE} from '../localization/my/statutory-tables';

describe('LHDN 2026 approved resident incentive formulas',()=>{
  it('pins Tables 2/3 independently to printed pages 15 and 17',()=>{
    expect(MY_PCB_INCENTIVE).toEqual({rate:0.15,rebateThreshold:35000,rebateCat13:400,rebateCat2:800});
  });
  it.each(['rep','knowledge_worker'] as const)('%s uses annual P and category rebate rather than monthly gross ×15%%',calculationScheme=>{
    const one=pcbMonth({calculationScheme,monthlyWage:3000,epfMonthly:330,month:1,profile:{category:1}});
    // 36,000 -3,960 -9,000 =23,040; (23,040×.15 -400)/12 =254.666... →254.70.
    expect(one.snapshot.P1).toBe(23040);expect(one.snapshot.trace?.T).toBe(400);
    expect(one.total).toBe(254.7);
    const two=pcbMonth({calculationScheme,monthlyWage:3000,epfMonthly:330,month:1,profile:{category:2}});
    expect(two.snapshot.P1).toBe(19040);expect(two.snapshot.trace?.T).toBe(800);expect(two.total).toBe(171.35);
    const three=pcbMonth({calculationScheme,monthlyWage:3000,epfMonthly:330,month:1,profile:{category:3}});
    expect(three.total).toBe(one.total);
  });
  it('includes the rebate at exactly35,000, removes it above, and does not invent a C-Suite rebate',()=>{
    const input={monthlyWage:1000,epfMonthly:0,month:12,acc:{netRemuneration:43000,epfClaimed:4000,pcbPaid:0}};
    const at=pcbMonth({...input,calculationScheme:'rep'});
    expect(at.snapshot.P1).toBe(35000);expect(at.total).toBe(4850);expect(at.snapshot.trace?.T).toBe(400);
    const above=pcbMonth({...input,calculationScheme:'rep',acc:{...input.acc,netRemuneration:43000.01}});
    expect(above.snapshot.trace?.T).toBe(0);expect(above.total).toBe(5250);
    const cs=pcbMonth({...input,calculationScheme:'c_suite'});
    expect(cs.total).toBe(5250);expect(cs.snapshot.trace).not.toHaveProperty('T');
  });
  it('reconciles prior payroll, TP1, EPF cap and separately offsets current zakat',()=>{
    const result=pcbMonth({calculationScheme:'rep',monthlyWage:10500,epfMonthly:1100,month:10,profile:{category:3,children:1},acc:{netRemuneration:20000,epfClaimed:2200,pcbPaid:3000,zakatPaid:200,lpAccumulated:1000},lpCurrent:100,zakatCurrent:50});
    expect(result.snapshot.P1).toBe(37600);expect(result.snapshot.trace).toMatchObject({K1:1100,K2:350,Z:200,lpAccumulated:1000,lpCurrent:100,zakatCurrent:50,mtdNormalCalc:813.35});
    expect(result.normal).toBe(763.35);expect(result.additional).toBe(0);
  });
  it('retains the five-step additional method and saves the changed rebate at each P',()=>{
    const result=pcbMonth({calculationScheme:'knowledge_worker',monthlyWage:3000,epfMonthly:330,month:1,additional:15000,epfOnAdditional:0});
    expect(result.snapshot.P1).toBe(23040);expect(result.snapshot.P2).toBe(38040);
    expect(result.snapshot.trace).toMatchObject({T:400,T2:0,totalTaxYear:5706,totalMtdYear:3056.4,mtdAdditionalCalc:2649.6});
    expect(result.total).toBe(2904.3);
  });
  it('keeps nonresident30%, normal legacy arithmetic and explicit scheme authority',()=>{
    const args=[3000,{category:1 as const},0,0,{month:1}] as const;
    expect(statutory(...args,{calculationScheme:'non_resident'}).pcb).toBe(900);
    expect(statutory(...args,{calculationScheme:'resident'})).toEqual(statutory(...args,{resident:true}));
    expect(statutory(...args,{calculationScheme:'rep',resident:false}).pcb).toBe(254.7);
    expect(()=>statutory(...args,{flatTaxRate:0.15})).toThrow('explicit approved PCB scheme');
    expect(()=>resolvePcbCalculationScheme('unknown')).toThrow('Unknown PCB');
  });
  it('rejects an invalid incentive tax category before returning money',()=>{
    expect(()=>pcbMonth({calculationScheme:'rep',monthlyWage:3000,epfMonthly:330,month:1,profile:{category:4 as 1}})).toThrow('Invalid incentive PCB tax category');
  });
  it('rejects a partial or nonfinite incentive ruleset before returning payroll money',()=>{
    for(const incentive of [{rate:0.15},{...MY_PCB_INCENTIVE,rate:NaN},{...MY_PCB_INCENTIVE,rate:1.1}]){
      expect(()=>pcbMonth({calculationScheme:'rep',monthlyWage:3000,epfMonthly:330,month:1,pcb:{...DEFAULT_MY_STATUTORY.pcb,incentive:incentive as typeof MY_PCB_INCENTIVE}})).toThrow('Invalid incentive PCB table');
    }
  });
});
