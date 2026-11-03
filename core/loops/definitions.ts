/** AI v2 W8 — the five loops, as the runner and the screens see them. The registry declaration of each (family,
 * trigger, scope, effect, authority, switch, stop, record, metrics, sponsor) is in core/agent-registry/workers.ts;
 * this adds what only a loop has: its detector, its version, who its card is for and what "done" means.
 * AI v2 P2-2a adds the Salary payroll loop, and the Phase 1 payroll inputs loop becomes the Pre-salary loop (same id). */
import type {Tx} from '../../db/client';
import type {LoopDetector} from './detect';
import type {LoopId,LoopRecipient} from './types';
import {PROBATION_LOOP_VERSION,detectProbationEnding} from './probation-ending';
import {PAYROLL_INPUTS_LOOP_VERSION,detectPayrollInputs} from './payroll-inputs';
import {MISSING_DATA_LOOP_VERSION,detectMissingEmployeeData} from './missing-employee-data';
import {CLOCK_OUT_LOOP_VERSION,detectMissedClockOuts} from './missed-clock-outs';
import {DOCUMENT_EXPIRY_LOOP_VERSION,detectDocumentExpiry} from './document-expiry';
import {SALARY_PAYROLL_LOOP_VERSION,detectSalaryPayroll} from './salary-payroll';
import {payrollLoopDueTx} from './payroll-loop-settings';

export type LoopDueCheck=(tx:Tx,input:Readonly<{tenantId:string;workerId:LoopId;companies:readonly string[];now:Date}>)=>Promise<string[]>;
export type LoopDefinition=Readonly<{id:LoopId;version:string;detect:LoopDetector;
 /** Who the loop's card is for. A passport card goes to the employee; HR sees them together on Today. */
 recipient:LoopRecipient;
 /** Whether the card proposes a value of its own that a person may change (only the clock-out time does). */
 proposesValue:boolean;
 /** At most this many new cards per company in one run; the rest wait for the next run, and the run says so. */
 openCap:number;
 /** AI v2 P2-2a: the companies due now, for a loop that checks each company at its own interval (read as the agent). */
 due?:LoopDueCheck;
 /** AI v2 P2-2a: a loop about pay stays at Prepare in every company (owner hard rule): no level may ever let it act. */
 prepareOnly?:true}>;

export const LOOP_DEFINITIONS:Readonly<Record<LoopId,LoopDefinition>>=Object.freeze({
 loop_probation_ending:{id:'loop_probation_ending',version:PROBATION_LOOP_VERSION,detect:detectProbationEnding,recipient:'hr',proposesValue:false,openCap:200},
 loop_payroll_inputs:{id:'loop_payroll_inputs',version:PAYROLL_INPUTS_LOOP_VERSION,detect:detectPayrollInputs,recipient:'payroll',proposesValue:false,openCap:200,
  due:payrollLoopDueTx,prepareOnly:true},
 loop_missing_employee_data:{id:'loop_missing_employee_data',version:MISSING_DATA_LOOP_VERSION,detect:detectMissingEmployeeData,recipient:'employee',proposesValue:false,openCap:200},
 loop_missed_clock_outs:{id:'loop_missed_clock_outs',version:CLOCK_OUT_LOOP_VERSION,detect:detectMissedClockOuts,recipient:'employee',proposesValue:true,openCap:200},
 loop_document_expiry:{id:'loop_document_expiry',version:DOCUMENT_EXPIRY_LOOP_VERSION,detect:detectDocumentExpiry,recipient:'employee',proposesValue:false,openCap:200},
 loop_salary_payroll:{id:'loop_salary_payroll',version:SALARY_PAYROLL_LOOP_VERSION,detect:detectSalaryPayroll,recipient:'payroll',proposesValue:false,openCap:200,
  prepareOnly:true},
});
