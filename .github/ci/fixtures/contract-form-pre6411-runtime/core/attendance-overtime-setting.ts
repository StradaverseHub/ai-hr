/** 2f803985 — Schedule Group › Overtime › Overtime Setting: the reader and the one writer.
 *
 * The setting is the dated group policy (core/attendance-group-policy.ts, ADR-0134). Saving appends ONE
 * future-dated revision per in-scope company, in one transaction, with set-based statements only: one
 * scope read, one history read, one pattern check, one multi-row insert and one batch of audit events,
 * however many companies "All companies" covers (70+ in a real group). Nothing earlier than the start
 * date is recalculated; no clocking, lateness or payroll record changes. Payroll receives the figures
 * through the existing policy execution and financial replay owners; no figure here is money. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withAttendanceTenant} from './module-gate';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {attendanceGroupPolicyRevision,attendanceRule,company,overtimePattern,overtimePatternVersion,overtimePatternVersionCompany} from '../db/schema';
import {actorOf,appendEvents} from '../db/events';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ATTENDANCE_POLICY_DAY_CLASSES,attendanceGroupPolicyActivationDate,validateAttendanceGroupPolicy,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {scheduleOvertimeSettingFromPolicy,scheduleOvertimeSettingPolicy,type ScheduleOvertimeSetting} from '../lib/schedule-overtime-setting';
import {overtimeUuid} from '../lib/overtime-pattern-schema';

const MAX_COMPANIES=500;
export type ScheduleOvertimeSettingScope={kind:'all'}|{kind:'companies';companyIds:string[]};
export type ScheduleOvertimePatternChoice={versionId:string;patternId:string;name:string;code:string|null;companyIds:string[]};
export type ScheduleOvertimeSettingView={
 companies:{id:string;name:string}[];
 /** The most recently saved revision among the administrator's companies, reopened exactly as saved. */
 saved:{setting:ScheduleOvertimeSetting;effectiveFrom:string;companyIds:string[];unsupportedRounding:boolean;
  /** Companies whose latest saved setting differs from the one shown, or that have none. */
  differingCompanyIds:string[]}|null;
 patterns:ScheduleOvertimePatternChoice[];
 /** The earliest start date every company accepts (after each company's latest saved start). */
 minimumDate:string;
 /** Optimistic concurrency over every company's latest ordinal for this group. */
 token:string;
};
const nextDay=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')+86_400_000).toISOString().slice(0,10);
function historyToken(rows:readonly {companyId:string;ordinal:number}[],companyIds:readonly string[]){
 const latest=new Map(rows.map(row=>[row.companyId,row.ordinal]));
 return createHash('sha256').update([...companyIds].sort().map(id=>`${id}:${latest.get(id)??0}`).join('|')).digest('hex');
}
async function adminCompaniesTx(tx:Tx,ctx:SessionContext){
 const rows=await tx.select({id:company.id,name:company.legalName}).from(company)
  .where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.attendance_policy_principal_current() AND app.is_admin_for(${company.id})`))
  .orderBy(asc(company.legalName),asc(company.id)).limit(MAX_COMPANIES+1);
 if(rows.length>MAX_COMPANIES)throw new Error('Your administrator scope exceeds the supported company count for one save.');
 return rows;
}
/** The latest revision of this group for each listed company, in ONE statement. */
async function latestRevisionsTx(tx:Tx,ctx:SessionContext,ruleId:string,companyIds:readonly string[]){
 if(!companyIds.length)return [];
 const rows=await tx.selectDistinctOn([attendanceGroupPolicyRevision.companyId],{companyId:attendanceGroupPolicyRevision.companyId,
  ordinal:attendanceGroupPolicyRevision.ordinal,effectiveFrom:attendanceGroupPolicyRevision.effectiveFrom,
  policy:attendanceGroupPolicyRevision.policy,createdAt:attendanceGroupPolicyRevision.createdAt})
  .from(attendanceGroupPolicyRevision).where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),
   eq(attendanceGroupPolicyRevision.ruleId,ruleId),inArray(attendanceGroupPolicyRevision.companyId,[...companyIds])))
  .orderBy(attendanceGroupPolicyRevision.companyId,desc(attendanceGroupPolicyRevision.ordinal));
 return rows.map(row=>({...row,policy:validateAttendanceGroupPolicy(row.policy,4320)}));
}
/** Activated formula versions, still active, with the in-scope companies each is bound to. One statement. */
async function patternChoicesTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],versionIds?:readonly string[]):Promise<ScheduleOvertimePatternChoice[]>{
 if(!companyIds.length)return [];
 const rows=await tx.select({versionId:overtimePatternVersion.id,patternId:overtimePatternVersion.patternId,name:overtimePatternVersion.name,
  code:overtimePattern.code,companyIds:sql<string[]>`array_agg(${overtimePatternVersionCompany.companyId}::text order by ${overtimePatternVersionCompany.companyId})`})
  .from(overtimePatternVersion)
  .innerJoin(overtimePattern,and(eq(overtimePattern.id,overtimePatternVersion.patternId),eq(overtimePattern.tenantId,ctx.tenantId),isNull(overtimePattern.archivedAt)))
  .innerJoin(overtimePatternVersionCompany,and(eq(overtimePatternVersionCompany.versionId,overtimePatternVersion.id),
   eq(overtimePatternVersionCompany.tenantId,ctx.tenantId),inArray(overtimePatternVersionCompany.companyId,[...companyIds])))
  .where(and(eq(overtimePatternVersion.tenantId,ctx.tenantId),eq(overtimePatternVersion.kind,'formula'),sql`${overtimePatternVersion.activatedAt} is not null`,
   ...(versionIds?[inArray(overtimePatternVersion.id,[...versionIds])]:[]),
   // The newest dated state decides; a stopped or archived version cannot price new overtime.
   sql`(select st.state from overtime_pattern_version_state st where st.version_id=${overtimePatternVersion.id} and st.tenant_id=${ctx.tenantId}::uuid
     order by st.effective_from desc,st.sequence desc limit 1)='active'`))
  .groupBy(overtimePatternVersion.id,overtimePatternVersion.patternId,overtimePatternVersion.name,overtimePattern.code)
  .orderBy(asc(overtimePatternVersion.name),asc(overtimePatternVersion.id)).limit(201);
 return rows.slice(0,200).map(row=>({...row,companyIds:[...row.companyIds]}));
}

export async function scheduleGroupOvertimeSettingTx(tx:Tx,ctx:SessionContext,p:{ruleId:string|null}):Promise<ScheduleOvertimeSettingView>{
 const ruleId=p.ruleId===null?null:overtimeUuid(p.ruleId,'ruleId').toLowerCase();
 const companies=await adminCompaniesTx(tx,ctx),ids=companies.map(row=>row.id);
 const [latest,patterns]=[ruleId?await latestRevisionsTx(tx,ctx,ruleId,ids):[],await patternChoicesTx(tx,ctx,ids)];
 const tomorrow=nextDay(todayInKualaLumpur());
 const after=latest.reduce((max,row)=>row.effectiveFrom>max?row.effectiveFrom:max,'');
 const minimumDate=after&&nextDay(after)>tomorrow?nextDay(after):tomorrow;
 const shown=latest.reduce<typeof latest[number]|null>((a,b)=>!a||b.createdAt>a.createdAt?b:a,null);
 const same=(a:AttendanceGroupPolicy,b:AttendanceGroupPolicy)=>JSON.stringify(a.overtime)===JSON.stringify(b.overtime);
 const saved=shown?(()=>{const reopened=scheduleOvertimeSettingFromPolicy(shown.policy);
  const matching=latest.filter(row=>same(row.policy,shown.policy)).map(row=>row.companyId);
  return {...reopened,effectiveFrom:shown.effectiveFrom,companyIds:matching,differingCompanyIds:ids.filter(id=>!matching.includes(id))};})():null;
 return {companies,saved,patterns,minimumDate,token:historyToken(latest,ids)};
}
export function scheduleGroupOvertimeSetting(ctx:SessionContext,p:{ruleId:string|null}):Promise<ScheduleOvertimeSettingView>{
 return withAttendanceTenant(ctx,tx=>scheduleGroupOvertimeSettingTx(tx,ctx,p));
}

export type ScheduleOvertimeSettingSaveResult={effectiveFrom:string;revisions:{companyId:string;id:string;ordinal:number}[]};
/** Writes the Overtime Setting for one Schedule Group to every in-scope company, from one start date.
 * A caller-owned transaction (Add Schedule Group) composes this after creating the group. */
export async function saveScheduleGroupOvertimeSetting(ctx:SessionContext,p:{ruleId:string;scope:ScheduleOvertimeSettingScope;
 effectiveFrom:string;setting:ScheduleOvertimeSetting;expectedToken:string;reason:string},existingTx?:Tx):Promise<ScheduleOvertimeSettingSaveResult>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!ctx.userId)throw new Error('Sign in again before saving the Overtime Setting.');
 const ruleId=overtimeUuid(p.ruleId,'ruleId').toLowerCase();
 const reason=typeof p.reason==='string'?p.reason.trim():'';
 if(!reason||reason.length>500)throw new Error('Provide a reason for the Overtime Setting change.');
 const effectiveFrom=attendanceGroupPolicyActivationDate(p.effectiveFrom,todayInKualaLumpur());
 const requested=p.scope.kind==='all'?null:[...new Set(p.scope.companyIds.map(id=>overtimeUuid(id,'companyId').toLowerCase()))];
 if(requested&&!requested.length)throw new Error('Choose All companies or at least one company for the Overtime Setting.');
 if(requested&&requested.length>MAX_COMPANIES)throw new Error('Choose at most 500 companies at once.');
 const write=async(tx:Tx):Promise<ScheduleOvertimeSettingSaveResult>=>{
  // Same ordering as the single-company policy writer: Access/profile barrier, scope recheck after
  // waiting, then the central overtime configuration and leave-dependency locks.
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
  const administered=await adminCompaniesTx(tx,ctx),adminIds=administered.map(row=>row.id);
  const companyIds=requested??adminIds;
  if(!companyIds.length)throw new Error('No company is in your administrator scope.');
  if(requested&&requested.some(id=>!adminIds.includes(id)))throw new Error('A chosen company is outside your administrator scope.');
  await tx.execute(sql`select app.lock_overtime_configuration(${ctx.tenantId}::uuid)`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const [rule]=await tx.select({id:attendanceRule.id,late:attendanceRule.lateGracePeriodMinutes,early:attendanceRule.earlyGracePeriodMinutes})
   .from(attendanceRule).where(and(eq(attendanceRule.id,ruleId),eq(attendanceRule.tenantId,ctx.tenantId))).limit(1);
  if(!rule)throw new Error('This Schedule Group is unavailable.');
  const latest=await latestRevisionsTx(tx,ctx,ruleId,adminIds);
  if(historyToken(latest,adminIds)!==p.expectedToken)throw new Error('The Overtime Setting changed since this page opened. Reload the Schedule Group and save again.');
  const byCompany=new Map(latest.map(row=>[row.companyId,row]));
  const blocked=companyIds.filter(id=>{const row=byCompany.get(id);return row&&row.effectiveFrom>=effectiveFrom;});
  if(blocked.length)throw new Error(`Choose a start date after ${[...new Set(blocked.map(id=>byCompany.get(id)!.effectiveFrom))].sort().at(-1)}, the latest saved Overtime Setting start for a chosen company.`);
  if(p.setting.approval==='auto'){
   const versionIds=[...new Set(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>p.setting.patternVersionIds[key]).filter((id):id is string=>!!id))];
   if(versionIds.length!==new Set(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>p.setting.patternVersionIds[key])).size)
    throw new Error('Auto overtime needs an active Overtime Pattern for each day type. Choose one, or use Manual.');
   const available=await patternChoicesTx(tx,ctx,companyIds,versionIds);
   const missing=versionIds.filter(id=>{const row=available.find(choice=>choice.versionId===id);return !row||companyIds.some(company=>!row.companyIds.includes(company));});
   if(missing.length)throw new Error('A chosen Overtime Pattern is not active for every chosen company. Activate it for those companies in Overtime Patterns, or choose fewer companies.');
  }
  const rows=companyIds.map(companyId=>{const previous=byCompany.get(companyId)??null;
   return {tenantId:ctx.tenantId,companyId,ruleId,ordinal:(previous?.ordinal??0)+1,effectiveFrom,reason,createdByUserId:ctx.userId!,
    policy:scheduleOvertimeSettingPolicy(p.setting,{previous:previous?.policy??null,lateGraceMinutes:rule.late,earlyGraceMinutes:rule.early})};});
  // One statement for every company. The activation-epoch trigger stamps each row in the same insert.
  const saved=await tx.insert(attendanceGroupPolicyRevision).values(rows).returning({id:attendanceGroupPolicyRevision.id,
   companyId:attendanceGroupPolicyRevision.companyId,ordinal:attendanceGroupPolicyRevision.ordinal});
  if(saved.length!==rows.length)throw new Error('The Overtime Setting was not saved for every chosen company.');
  const byId=new Map(rows.map(row=>[row.companyId,row]));
  await appendEvents(tx,saved.map(row=>({tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:ruleId,
   eventType:'attendance-rule.policy.scheduled',actor:actorOf(ctx),payload:{versionId:row.id,companyId:row.companyId,
    previousOrdinal:row.ordinal-1,ordinal:row.ordinal,effectiveFrom,reason,policy:byId.get(row.companyId)!.policy,source:'scheduleGroupOvertimeSetting'}})));
  return {effectiveFrom,revisions:saved.map(row=>({...row})).sort((a,b)=>a.companyId.localeCompare(b.companyId))};
 };
 return existingTx?write(existingTx):withAttendanceTenant(ctx,write);
}
