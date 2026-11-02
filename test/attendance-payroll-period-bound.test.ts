import {expect,it} from 'vitest';
import {cleanPayrollPolicyConfig,cutOffWindowFor} from '../core/payroll-policy-config';

/** The native lock bound is only a conservative candidate filter; this owner decides exact coverage. */
it('keeps every canonical Attendance cutoff date in the statutory month or its preceding calendar month',()=>{
 for(const period of ['2023-01','2023-02','2024-02','2024-03','2024-12','2025-01']){
  const [year,month]=period.split('-').map(Number);
  const earliest=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,10);
  const latest=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  const check=(config:ReturnType<typeof cleanPayrollPolicyConfig>,company:number|null)=>{
   const window=cutOffWindowFor('attendance',config,{attendanceCutOffDay:company},period);
   expect(window.start>=earliest && window.end<=latest && window.start<=window.end,JSON.stringify({period,window,config,company})).toBe(true);
  };
  check(null,null);
  for(let anchor=1;anchor<=28;anchor++){
   check(null,anchor);
   for(const frequency of ['monthly','weekly','biweekly']){
    for(const override of [1,14,28]){
     check(cleanPayrollPolicyConfig({frequency,cutOff:{mode:'custom',anchorDay:anchor}}),null);
     check(cleanPayrollPolicyConfig({frequency,cutOff:{mode:'custom',anchorDay:anchor,perType:{attendance:override}}}),null);
     check(cleanPayrollPolicyConfig({frequency,cutOff:{mode:'custom',anchorDay:anchor,perFrequency:{[frequency]:{anchorDay:override,perType:{attendance:29-override}}}}}),null);
    }
   }
  }
 }
});
