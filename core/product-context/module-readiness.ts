/** ADR-0169 phase B — leave, holiday, attendance and onboarding setup readiness, minimized for the Assistant.
 *
 * Answers a new administrator's "is leave / attendance / onboarding ready, and what is missing?" from the
 * owners the admin screens already read, never a second derivation:
 * - leave: the Balance Health derivation (lib/leave-config-health.ts `leaveConfigHealthAll`) over the same
 *   inputs, projected through the one shared projection (core/leave-config-health-input.ts);
 * - public holidays: the s.60D completeness count (core/holidays.ts `loadedHolidayCount`) for the company's
 *   country, this year, and next year from November;
 * - attendance: the schedule-group library and how many current employments in the company have no group
 *   (employment.attendance_rule_id, the column the time engine resolves first);
 * - onboarding: the onboarding configuration's own counts (packs/lifecycle/service `onboardingContext`).
 * Configuration names, statuses, finding keys and counts only — no employee, joiner, balance or ledger data,
 * and no tenant-wide joiner count (a company-scoped administrator must not learn other companies' volumes).
 * Administrators only, through setup readiness. A part whose module is off, or whose owner refuses, is null.
 * Not imported by the production Assistant (outside the provider privacy closure until ADR-0169 §5.1). */
import {and,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import * as schema from '../../db/schema';
import {isModuleEnabled} from '../entitlements';
import {listJobGrades,listLeaveTypes} from '../read';
import {EA_S60D_MINIMUM_HOLIDAYS,loadedHolidayCount} from '../holidays';
import {healthLeaveType} from '../leave-config-health-input';
import {leaveConfigHealthAll,type LeaveConfigFinding} from '../../lib/leave-config-health';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {listEligibilityRules,listEntitlementTemplates} from '../../packs/leave/service';
import {listAttendanceRules} from '../../packs/attendance/service';
import {onboardingContext} from '../../packs/lifecycle/service';

export type LeaveReadiness=Readonly<{
 types:readonly Readonly<{name:string;status:'ready'|'warning'|'blocked';findings:readonly LeaveConfigFinding[];configuredDays:Readonly<{min:number;max:number}>|null}>[];
 blocked:number;warning:number;ready:number;
 publicHolidays:readonly Readonly<{country:string;year:number;loaded:number;required:number}>[];
 pages:Readonly<{balanceHealth:string;holidays:string}>;
}>;
export type AttendanceReadiness=Readonly<{scheduleGroups:number;hasDefaultGroup:boolean;currentEmployments:number;employmentsWithoutGroup:number;page:string}>;
export type OnboardingReadiness=Readonly<{initialized:boolean;checklists:number;checklistsWithoutTasks:number;workflows:number;activeCatalogueItems:number;onboardingAccessHolders:number;page:string}>;
export type ModuleReadiness=Readonly<{leave:LeaveReadiness|null;attendance:AttendanceReadiness|null;onboarding:OnboardingReadiness|null}>;

/** Which gazette years to check on `today`: this year, plus next year from November (when HR loads it). */
export function holidayYears(today:string):number[]{const year=Number(today.slice(0,4));return Number(today.slice(5,7))>=11?[year,year+1]:[year];}

async function leaveReadiness(ctx:SessionContext,companyId:string,today:string):Promise<LeaveReadiness>{
 const [types,templates,rules,grades]=await Promise.all([listLeaveTypes(ctx,{includeArchived:true}),listEntitlementTemplates(ctx),listEligibilityRules(ctx),listJobGrades(ctx,{includeArchived:true})]);
 const leaveCreditLive=isModuleEnabled(ctx,'toil');
 const health=leaveConfigHealthAll({leaveTypes:types.map(type=>healthLeaveType(type,leaveCreditLive)),templates,rules,
  grades:grades.filter(grade=>grade.archivedAt==null).map(grade=>({id:grade.id,name:grade.name})),today});
 const publicHolidays=await withTenant(ctx,async tx=>{
  const [row]=await tx.select({country:schema.company.country}).from(schema.company).where(eq(schema.company.id,companyId)).limit(1);
  if(!row?.country)return [];
  const country=row.country;
  return Promise.all(holidayYears(today).map(async year=>Object.freeze({country,year,loaded:await loadedHolidayCount(tx,country,null,year),required:EA_S60D_MINIMUM_HOLIDAYS})));
 });
 const count=(status:string)=>health.filter(row=>row.status===status).length;
 return Object.freeze({
  types:Object.freeze(health.map(row=>Object.freeze({name:row.leaveTypeName,status:row.status,findings:Object.freeze([...row.findings]),
   configuredDays:row.configuredDaysMin==null||row.configuredDaysMax==null?null:Object.freeze({min:row.configuredDaysMin,max:row.configuredDaysMax})}))),
  blocked:count('blocked'),warning:count('warning'),ready:count('ready'),
  publicHolidays:Object.freeze(publicHolidays),
  pages:Object.freeze({balanceHealth:'/admin/leave-config/balance-health',holidays:'/admin/holidays'}),
 });
}

async function attendanceReadiness(ctx:SessionContext,companyId:string):Promise<AttendanceReadiness>{
 const [groups,counts]=await Promise.all([listAttendanceRules(ctx),withTenant(ctx,async tx=>{
  const [row]=await tx.select({current:sql<number>`count(*)::int`,withoutGroup:sql<number>`count(*) filter (where ${schema.employment.attendanceRuleId} is null)::int`})
   .from(schema.employment).where(and(eq(schema.employment.companyId,companyId),isNull(schema.employment.terminatedOn)));
  return row??{current:0,withoutGroup:0};
 })]);
 return Object.freeze({scheduleGroups:groups.length,hasDefaultGroup:groups.some(group=>group.isDefault),currentEmployments:counts.current,employmentsWithoutGroup:counts.withoutGroup,page:'/admin/attendance/schedule'});
}

async function onboardingReadiness(ctx:SessionContext):Promise<OnboardingReadiness>{
 const {config,revision}=await onboardingContext(ctx);
 return Object.freeze({initialized:!!revision,checklists:config.checklists.length,checklistsWithoutTasks:config.checklists.filter(list=>!list.tasks.length).length,
  workflows:config.workflows.length,activeCatalogueItems:config.catalogue.filter(item=>item.active).length,onboardingAccessHolders:config.access.onboarding.length,page:'/admin/lifecycle/onboarding'});
}

/** The caller is checked by setup readiness; each part is null when its module is off or its owner refuses. */
export async function moduleReadiness(ctx:SessionContext,companyId:string):Promise<ModuleReadiness>{
 const today=todayInKualaLumpur();
 const [leave,attendance,onboarding]=await Promise.all([
  isModuleEnabled(ctx,'leave')?leaveReadiness(ctx,companyId,today).catch(()=>null):null,
  isModuleEnabled(ctx,'attendance')?attendanceReadiness(ctx,companyId).catch(()=>null):null,
  isModuleEnabled(ctx,'lifecycle')?onboardingReadiness(ctx).catch(()=>null):null,
 ]);
 return Object.freeze({leave,attendance,onboarding});
}
