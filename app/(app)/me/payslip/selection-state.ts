import {resolvePayslipSelection,type PayslipRun,type PayslipSelection} from '@/app/(app)/payroll/individual-payslip/period-options';

export type PersonalPayslipRequest={companyId?:string;year?:string;month?:string;payslipId?:string};

/** Mine never relaxes a stale requested period into a different employee document. */
export function resolvePersonalPayslipSelection(runs:readonly PayslipRun[],request:PersonalPayslipRequest):PayslipSelection {
 const year=request.year===undefined?undefined:/^\d{4}$/.test(request.year)?Number(request.year):NaN;
 const month=request.month===undefined?undefined:/^(0?[1-9]|1[0-2])$/.test(request.month)?Number(request.month):NaN;
 if(Number.isNaN(year)||Number.isNaN(month)||request.companyId===''||request.payslipId==='')return{payslipId:null};
 const matching=runs.filter(run=>(year===undefined||Number(run.payPeriod.slice(0,4))===year)
  &&(month===undefined||Number(run.payPeriod.slice(5,7))===month));
 return resolvePayslipSelection(matching,{companyId:request.companyId,payslipId:request.payslipId,year,month});
}
