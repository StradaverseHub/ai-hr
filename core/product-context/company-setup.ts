/** ADR-0169 phase B — what leave and attendance configuration this company already has, minimized.
 *
 * Answers a new administrator's "which leave types do we have, and what is missing?" from the same owners the
 * admin pages read: the kernel leave-type listing (core/read.ts listLeaveTypes, active types only) and the
 * attendance pack's schedule-group library (packs/attendance/service listAttendanceRules; the admin calls these Schedule Groups). Returns configuration names
 * and flags only — no employee, balance or ledger data. Whether a leave type can grant days is NOT judged here:
 * setup readiness reports it from the Balance Health derivation, the one owner of that verdict (a second
 * "accrual configured" flag here contradicted it in run 41284048653). Administrators only, like setup readiness; the
 * attendance part is omitted when the module is off. Not imported by the production Assistant. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {listLeaveTypes} from '../read';
import {listAttendanceRules} from '../../packs/attendance/service';

export class CompanySetupRefused extends Error{constructor(){super('Company setup is available to administrators only.');this.name='CompanySetupRefused';}}
export type CompanySetup=Readonly<{
 leaveTypes:readonly Readonly<{code:string;name:string;paid:boolean}>[];
 attendance:Readonly<{scheduleGroups:readonly Readonly<{name:string;isDefault:boolean}>[]}>|null;
 pages:Readonly<{leaveTypes:string;scheduleGroups:string|null}>;
}>;

export async function companySetup(ctx:SessionContext):Promise<CompanySetup>{
 if(!isAdmin(ctx))throw new CompanySetupRefused();
 const attendanceOn=isModuleEnabled(ctx,'attendance');
 const [types,rules]=await Promise.all([listLeaveTypes(ctx,{}),attendanceOn?listAttendanceRules(ctx):Promise.resolve(null)]);
 return Object.freeze({
  leaveTypes:Object.freeze(types.map(type=>Object.freeze({code:type.code,name:type.name,paid:type.paid}))),
  attendance:rules?Object.freeze({scheduleGroups:Object.freeze(rules.map(rule=>Object.freeze({name:rule.name,isDefault:rule.isDefault})))}):null,
  pages:Object.freeze({leaveTypes:'/admin/leave-config/types',scheduleGroups:attendanceOn?'/admin/attendance/schedule':null}),
 });
}
