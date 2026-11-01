/** ADR-0170 §3.4 step 4 — the further readiness reads ADR-0170 lists, from their existing owners.
 *
 * - entitlement coverage: employees no entitlement table reaches (core/entitlement-template.ts
 *   `listEmploymentsWithoutEntitlementTable`, through packs/leave/service), the engine's own matcher;
 * - logins pending: people with no login yet (core/employee-user-activation.ts
 *   `listEmployeeActivationCandidates`), which only a group administrator may read;
 * - letter settings: public origin, notifications and email transport (core/letters.ts
 *   `readLetterSettingsReadiness`), for a holder of the company's letter settings permission;
 * - leave generation: whether a generation run exists for this leave year and whether the latest failed for
 *   anyone (packs/leave/service `listLeaveGenerationRuns`). Years and flags only: run volumes are
 *   tenant-wide and would tell a company-scoped administrator about other companies.
 * Counts only, never names, codes or ids: each owner's rows are reduced here and nothing else is kept. Each
 * part is null when its module is off and `refused` when its owner refuses this caller. Claims setup has no
 * readiness owner; it is reported as a gap by the co-pilot, never derived here. Administrators only, through
 * setup readiness. Not imported by the production Assistant. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isModuleEnabled} from '../entitlements';
import {listEmployeeActivationCandidates} from '../employee-user-activation';
import {readLetterSettingsReadiness} from '../letters';
import {listEmploymentsWithoutEntitlementTable,listLeaveGenerationRuns} from '../../packs/leave/service';

export type Refused=Readonly<{refused:true}>;
export type EntitlementCoverage=Readonly<{activeEmployees:number;withoutTable:number;withoutJobGrade:number;page:string}>;
export type LoginReadiness=Readonly<{withoutLogin:number;withoutLoginWithEmployment:number;page:string}>;
export type LetterReadiness=Readonly<{publicOrigin:boolean;notifications:boolean;email:boolean;page:string}>;
export type LeaveGenerationReadiness=Readonly<{leaveYear:number;runThisYear:boolean;latestRunYear:number|null;latestRunHadFailures:boolean;page:string}>;
export type CoverageReadiness=Readonly<{
 entitlementCoverage:EntitlementCoverage|Refused|null;logins:LoginReadiness|Refused;letters:LetterReadiness|Refused|null;leaveGeneration:LeaveGenerationReadiness|Refused|null;
}>;
export class CoverageReadinessRefused extends Error{constructor(){super('Setup readiness is available to administrators only.');this.name='CoverageReadinessRefused';}}
const REFUSED:Refused=Object.freeze({refused:true});
export const PAGES=Object.freeze({entitlementTables:'/admin/leave-config/entitlement-tables',users:'/admin/users',letterSettings:'/letters/settings/policy',leaveGeneration:'/admin/leave-config/generate'});

export async function coverageReadiness(ctx:SessionContext,companyId:string,today=todayInKualaLumpur()):Promise<CoverageReadiness>{
 if(!isAdmin(ctx))throw new CoverageReadinessRefused();
 const leave=isModuleEnabled(ctx,'leave'),year=Number(today.slice(0,4));
 const refusedOn=<T>(read:Promise<T>):Promise<T|Refused>=>read.catch(()=>REFUSED);
 const [coverage,people,letters,runs]=await Promise.all([
  // limit 0: names are never kept; the owner counts before it caps.
  leave?refusedOn(listEmploymentsWithoutEntitlementTable(ctx,{asOf:today,limit:0})):null,
  refusedOn(listEmployeeActivationCandidates(ctx)),
  isModuleEnabled(ctx,'employees')?refusedOn(readLetterSettingsReadiness(ctx,companyId)):null,
  leave?refusedOn(listLeaveGenerationRuns(ctx,{limit:20})):null,
 ]);
 const refused=(value:unknown):value is Refused=>value===REFUSED;
 return Object.freeze({
  entitlementCoverage:coverage===null||refused(coverage)?coverage:Object.freeze({activeEmployees:coverage.activeTotal,withoutTable:coverage.total,withoutJobGrade:coverage.withoutJobGrade,page:PAGES.entitlementTables}),
  logins:refused(people)?people:Object.freeze({withoutLogin:people.length,withoutLoginWithEmployment:people.filter(row=>row.hasEmployment).length,page:PAGES.users}),
  letters:letters===null||refused(letters)?letters:Object.freeze({publicOrigin:letters.publicOrigin,notifications:letters.notifications,email:letters.email,page:PAGES.letterSettings}),
  leaveGeneration:runs===null||refused(runs)?runs:Object.freeze({leaveYear:year,runThisYear:runs.some(run=>run.leaveYear===year),
   latestRunYear:runs[0]?.leaveYear??null,latestRunHadFailures:(runs[0]?.employeesFailed??0)>0,page:PAGES.leaveGeneration}),
 });
}
