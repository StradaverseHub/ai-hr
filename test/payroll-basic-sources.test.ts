import {expect,it} from 'vitest';
import {eligibleWorkingDays,payrollIncrementBasic,payrollRateBasic} from '../lib/payroll-basic';
import {payrollProrationRatio,payrollProrationFactor} from '../lib/payroll-proration';
it('counts the paid entity segment and excludes holidays across a leap-day month',()=>{
 expect(eligibleWorkingDays('2024-02','2024-02-26','2024-02-29',new Set(['2024-02-28']))).toBe(3);
 expect(payrollRateBasic(100,3)).toBe(300);
 expect(eligibleWorkingDays('2024-02','2024-03-01',null,new Set())).toBe(0);
});
it('retains the native calendar increment blend and declines non-straddling increments',()=>{
 expect(payrollIncrementBasic([{basic:3100,validFrom:'2026-01-01',validTo:'2026-05-16'},{basic:6200,validFrom:'2026-05-16',validTo:null}],'2026-05-01','2026-05-31',31)).toBe(4700);
 expect(payrollIncrementBasic([{basic:3100,validFrom:'2026-05-01',validTo:null}],'2026-05-01','2026-05-31',31)).toBeUndefined();
});
it('keeps exact proration counts and the legacy quotient identical for cutoff and working-day windows',()=>{
 const options={window:{start:'2024-02-26',end:'2024-03-25'},workingDayBasis:{roster:[1,2,3,4,5],holidays:new Set(['2024-03-01'])}};
 const ratio=payrollProrationRatio('2024-03','2024-03-04','2024-03-08',options);expect(ratio).toEqual({numerator:5,denominator:20});
 expect(payrollProrationFactor('2024-03','2024-03-04','2024-03-08',options)).toBe(0.25);
});
