/** ADR-0169 phase B — what leave and attendance configuration this company already has, minimized.
 *
 * Answers a new administrator's "which leave types do we have, and what is missing?" from the same owners the
 * admin pages read: the kernel leave-type listing (core/read.ts listLeaveTypes, active types only) and the
 * attendance pack's schedule-group library (packs/attendance/service listAttendanceRules; the admin calls these Schedule Groups). Returns configuration names
 * and flags only — no employee, balance or ledger data. Whether a leave type can grant days is NOT judged here:
 * setup readiness reports it from the Balance Health derivation, the one owner of that verdict (a second
 * "accrual configured" flag here contradicted it in run 41284048653). Administrators only, like setup readiness; the
 * attendance part is omitted when the module is off. Not imported by the production Assistant.
 *
 * After spec v20's scored run 41641279562 (grp-zh-1, "我们集团有哪些公司？": a group administrator was told only her own
 * employment's company, from her own work profile, and sent to the org chart): no read named the companies an
 * administrator administers. They are listed here, names only, by the Organization listing's own scope
 * (core/read.ts listCompanies adminOnly: the database's app.is_admin_for, every company for a group-wide grant, a
 * company-scoped administrator's company and its subtree otherwise), active companies only, with that listing's page. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {listCompanies,listLeaveTypes} from '../read';
import {listAttendanceRules} from '../../packs/attendance/service';

export class CompanySetupRefused extends Error{constructor(){super('Company setup is available to administrators only.');this.name='CompanySetupRefused';}}
export type CompanySetup=Readonly<{
 /** The active companies this administrator administers, by name (the Organization listing's scope). */
 companies:readonly Readonly<{name:string}>[];
 leaveTypes:readonly Readonly<{code:string;name:string;paid:boolean}>[];
 attendance:Readonly<{scheduleGroups:readonly Readonly<{name:string;isDefault:boolean}>[]}>|null;
 pages:Readonly<{companies:string;leaveTypes:string;scheduleGroups:string|null}>;
}>;
/** The Organization listing (app/admin/organization/page.tsx): the companies this administrator administers. */
export const COMPANIES_PAGE='/admin/organization';

export async function companySetup(ctx:SessionContext):Promise<CompanySetup>{
 if(!isAdmin(ctx))throw new CompanySetupRefused();
 const attendanceOn=isModuleEnabled(ctx,'attendance');
 const [companies,types,rules]=await Promise.all([listCompanies(ctx,{adminOnly:true}),listLeaveTypes(ctx,{}),attendanceOn?listAttendanceRules(ctx):Promise.resolve(null)]);
 return Object.freeze({
  companies:Object.freeze(companies.map(row=>Object.freeze({name:row.name}))),
  leaveTypes:Object.freeze(types.map(type=>Object.freeze({code:type.code,name:type.name,paid:type.paid}))),
  attendance:rules?Object.freeze({scheduleGroups:Object.freeze(rules.map(rule=>Object.freeze({name:rule.name,isDefault:rule.isDefault})))}):null,
  pages:Object.freeze({companies:COMPANIES_PAGE,leaveTypes:'/admin/leave-config/types',scheduleGroups:attendanceOn?'/admin/attendance/schedule':null}),
 });
}
