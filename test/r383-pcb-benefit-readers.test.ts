import {describe, expect, it} from 'vitest';
import {explainPcb, pcbSlipSections, pcbAccumulatedRemunerationSection} from '../core/pcb-explain';
import {pcbMonth} from '../localization/my/payroll';
import {type PcbNonCashSnapshot} from '../localization/noncash-benefits';
const sides = {profile:null,catalogue:[],rebateCatalogue:[],currentDeduction:null,accumulatedDeduction:null,previousDeduction:null,currentRebate:null,accumulatedRebate:null};
function facts(): PcbNonCashSnapshot {
  const bik={entered:600,exempt:200,taxable:400},vola={entered:600,exempt:0,taxable:600};
  const entries=[{kind:'bik' as const,code:'CAR',source:'recurring' as const,...bik,exemptionCode:'SAVED'}, {kind:'vola' as const,code:'HOME',source:'one_off' as const,sourceId:'synthetic-transaction',...vola}];
  return {version:1,current:{bik,vola},ownedCurrent:{bik,vola},owned:{bik:400,vola:600},cumulative:{bik:400,vola:600},before:{bik:0,vola:0},accumulated:{bik:800,vola:1200,complete:true},cashNormal:5000,entries,ownedEntries:entries};
}
function stored(benefits:unknown=facts()) {
  const run=pcbMonth({monthlyWage:6000,epfMonthly:550,month:7,profile:{category:3}});
  return {pcb:run.total,pcbBonus:run.additional,epfEmployee:550,zakat:0,pcbMeta:run.snapshot,pcbNonCash:benefits};
}
const row=(sections:ReturnType<typeof pcbSlipSections>,caption:string)=>sections.flatMap(s=>s.rows).find(r=>r.caption===caption)?.first;
describe('r383 saved taxable noncash explanation',()=>{
  it('shows saved entered, exempt and taxable benefits without adding them again to Y1',()=>{
    const x=explainPcb(stored(),null); expect(x.kind).toBe('mtd'); if(x.kind!=='mtd')throw Error('Expected saved resident trace');
    const sections=pcbSlipSections(x,sides);
    expect(row(sections,'slipCurrentTotal')).toEqual({kind:'money',amount:6000});
    expect(row(sections,'slipCompBenefitsInKind')).toEqual({kind:'money',amount:400});
    expect(row(sections,'slipBikEntered')).toEqual({kind:'money',amount:600});
    expect(row(sections,'slipBikExempt')).toEqual({kind:'money',amount:200});
    expect(row(sections,'slipCompLivingAccommodation')).toEqual({kind:'money',amount:600});
    const accumulated=pcbAccumulatedRemunerationSection(x,null);
    expect(accumulated.rows.find(r=>r.caption==='slipAccBik')?.first).toEqual({kind:'money',amount:800});
    expect(accumulated.rows.find(r=>r.caption==='slipAccVola')?.first).toEqual({kind:'money',amount:1200});
  });
  it.each([undefined,null,{version:2}])('legacy or unsupported benefit facts %s never print invented zero',value=>{
    const st=stored(value);if(value===undefined)Reflect.deleteProperty(st,'pcbNonCash');
    const x=explainPcb(st,null);if(x.kind!=='mtd')throw Error('Existing calculation must remain readable');
    expect(row(pcbSlipSections(x,sides),'slipCompBenefitsInKind')).toEqual({kind:'notRecorded'});
    expect(pcbAccumulatedRemunerationSection(x,null).rows.find(r=>r.caption==='slipAccBik')?.first).toEqual({kind:'notRecorded'});
  });
  it('recorded zero is distinct from incomplete accumulated history',()=>{
    const st=stored(); const b=facts();b.accumulated={bik:0,vola:0,complete:true};st.pcbNonCash=b;
    let x=explainPcb(st,null);if(x.kind!=='mtd')throw Error('Expected resident');
    expect(pcbAccumulatedRemunerationSection(x,null).rows.find(r=>r.caption==='slipAccBik')?.first).toEqual({kind:'money',amount:0});
    b.accumulated.complete=false;x=explainPcb(st,null);if(x.kind!=='mtd')throw Error('Expected resident');
    expect(pcbAccumulatedRemunerationSection(x,null).rows.find(r=>r.caption==='slipAccBik')?.first).toEqual({kind:'notRecorded'});
  });
  it('valid-looking benefits cannot be displayed beside another saved normal tax base',()=>{
    const st=stored();const b=facts();b.cashNormal+=1;st.pcbNonCash=b;
    const x=explainPcb(st,null);if(x.kind!=='mtd')throw Error('Saved calculation remains readable');
    expect(x.trace?.Y1).toBe(6000);expect(x.nonCash).toBeNull();
    expect(row(pcbSlipSections(x,sides),'slipCompBenefitsInKind')).toEqual({kind:'notRecorded'});
  });
});

import {computeMonthlyRuns} from '../localization/my/multicycle';
import {statutory} from '../localization/my/payroll';
describe('r383 noncash month replay model',()=>{
  it('applies saved owned taxable contributions once and leaves cash statutory bases alone',()=>{
    const profile={category:3 as const},opts={resident:true};
    const replay=computeMonthlyRuns({month:7,profile,opts,runs:[{runType:'regular',payment:5000,pcbNonCashNormal:{bik:400,vola:0}},{runType:'bonus',payment:1000,pcbNonCashNormal:{bik:0,vola:600}}]});
    const expected=statutory(5000,profile,1000,0,{month:7},{...opts,pcbNonCashNormal:{bik:400,vola:600}});
    const cashOnly=statutory(5000,profile,1000,0,{month:7},opts);
    expect(replay.monthly.pcb).toBe(expected.pcb);
    expect(replay.runs[0].pcb+replay.runs[1].pcb).toBeCloseTo(expected.pcb,8);
    expect(replay.monthly.pcb).toBeGreaterThan(cashOnly.pcb);
    for(const key of ['epfEmployee','epfEmployer','socsoEmployee','socsoEmployer','eisEmployee','eisEmployer'] as const)expect(replay.monthly[key]).toBe(cashOnly[key]);
  });
  it('refuses negative or overflowing saved contributions rather than clamping invented money',()=>{
    expect(()=>computeMonthlyRuns({month:7,runs:[{runType:'regular',payment:5000,pcbNonCashNormal:{bik:-1,vola:0}}]})).toThrow('Invalid saved non-cash contribution');
    expect(()=>computeMonthlyRuns({month:7,runs:[{runType:'regular',payment:5000,pcbNonCashNormal:{bik:1e308,vola:0}}]})).toThrow('Invalid saved non-cash contribution');
  });
});
