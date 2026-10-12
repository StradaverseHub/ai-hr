import { describe, expect, it } from 'vitest';
import { creditRegisterFigures, projectCreditUsage } from '../lib/leave-credit-register';
const lot={earned:1,taken:0,state:'active',expiresOn:'2026-10-20',today:'2026-10-12'};
describe('earned credit register facts',()=>{
  it('distinguishes available, partial and fully used without turning old fully used credits into expired',()=>{
    expect(creditRegisterFigures(lot)).toMatchObject({status:'available',available:1,reversible:true});
    expect(creditRegisterFigures({...lot,taken:.5})).toMatchObject({status:'partially_used',available:.5,reversible:false});
    expect(creditRegisterFigures({...lot,taken:1,state:'taken',today:'2026-11-01'})).toMatchObject({status:'fully_used',expired:0,available:0});
  });
  it('expires only the unused remainder and preserves reversed/paid-out explanations',()=>{
    expect(creditRegisterFigures({...lot,taken:.5,today:'2026-11-01'})).toMatchObject({status:'expired',expired:.5,used:.5,available:0,reversible:false});
    expect(creditRegisterFigures({...lot,state:'reversed'})).toMatchObject({status:'reversed',available:0});
    expect(creditRegisterFigures({...lot,state:'converted_to_pay'})).toMatchObject({status:'paid_out',available:0});
  });
  it('splits approved dates using the request-to-credit allocation, including a half day across two credits',()=>{
    const out=projectCreditUsage([{accrualId:'a',days:.75},{accrualId:'b',days:.75}],[{requestId:'request',date:'2026-10-20',days:1},{requestId:'request',date:'2026-10-21',days:.5}]);
    expect(out.get('a')).toEqual([{requestId:'request',date:'2026-10-20',days:.75}]);
    expect(out.get('b')).toEqual([{requestId:'request',date:'2026-10-20',days:.25},{requestId:'request',date:'2026-10-21',days:.5}]);
  });
  it('uses remaining net allocations after cancellation and never invents missing legacy dates',()=>{
    const out=projectCreditUsage([{accrualId:'original',days:.5},{accrualId:'restored',days:0}],[{requestId:'survivor',date:'2026-10-21',days:.5}]);
    expect(out.get('original')).toEqual([{requestId:'survivor',date:'2026-10-21',days:.5}]);expect(out.get('restored')).toEqual([]);
    expect(projectCreditUsage([{accrualId:'legacy',days:1}],[]).get('legacy')).toEqual([]);
  });
});
