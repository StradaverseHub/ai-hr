/** AI v2 W5 — the reads behind the "Why?" panels on the person's own screens.
 *
 * These are the screen's path, not the Assistant's: they show the person the owner service's figures exactly, so
 * they need no Assistant grant and send nothing to a model. Each reads only the caller's own records, through the
 * same owners the screen beside it uses:
 *  - pay difference: core/read.ts myEmploymentIdsAll + myOwnPayslips (the own-only fence the payslip document's
 *    year-to-date uses), released payslips only, one company (the one whose payslip is open);
 *  - leave balance: the own Home subject (core/employee-home.ts requireOwnHomeSubject, re-checked against the
 *    current own employments exactly as Today's balances are) and its leave dashboard card (core/my-leave.ts);
 * The claim limit panel reads nothing new: the claims page already holds the claims owner's balance.
 * The figures are explained by the pure owners (core/pay-difference.ts, core/leave-balance-explain.ts). */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {myEmploymentIdsAll,myOwnEmploymentSubjects,myOwnPayslips} from '../read';
import {requireOwnHomeSubject,HomeAccessError} from '../employee-home';
import {myLeaveDashboard} from '../../packs/leave/service';
import {comparePayPeriods,type PayDifference,type PayDifferenceRefusal} from '../pay-difference';
import {leaveBalanceExplanation,type LeaveBalanceExplanation} from '../leave-balance-explain';
import {storedPayslipRow} from './pay-difference';

/** The open payslip's month against the person's previous released month at the same company. */
export async function ownPayDifference(ctx:SessionContext,input:Readonly<{companyId:string;period:string}>):Promise<PayDifference|PayDifferenceRefusal>{
 const ids=(await myEmploymentIdsAll(ctx)).map(row=>row.employmentId);
 if(!ids.length)return{ok:false,reason:'no_data',availablePeriods:[]};
 const rows=(await myOwnPayslips(ctx,ids)).filter(row=>row.released).map(storedPayslipRow);
 return comparePayPeriods(rows,{period:input.period,companyId:input.companyId});
}

/** One of the person's own leave types, explained from the dashboard card its figure came from. Null when the
 * person holds no such card (another person's type, a hidden type, or a stale link). */
export async function ownLeaveBalanceWhy(ctx:SessionContext,input:Readonly<{leaveTypeId:string;employmentId?:string;locale?:string}>,today=todayInKualaLumpur()):Promise<LeaveBalanceExplanation|null>{
 const subject=await requireOwnHomeSubject(ctx,input.employmentId);
 const active=await myOwnEmploymentSubjects(ctx,{profileEdit:true});
 if(!active.some(row=>row.employmentId===subject.employmentId))throw new HomeAccessError('employmentUnavailable');
 const dashboard=await myLeaveDashboard(ctx,subject.employmentId,{today,locale:input.locale});
 const card=dashboard.cards.find(row=>row.leaveTypeId===input.leaveTypeId);
 return card?leaveBalanceExplanation(card):null;
}
