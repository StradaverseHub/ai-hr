/** Batched canonical import routing. File labels do not establish physical work or approval. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceCorrection,attendancePolicyRequestContract,employment} from '../../db/schema';
import {assertModuleGate} from '../../core/module-gate';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {validateAttendanceGroupPolicy} from '../../lib/attendance-group-policy';
import {legacyAttendancePolicyAdmissionSql} from './policy-selection';

/** Called before creating the ScheduleMemo or reading policy inputs. The checked DB barrier
 * validates the entire actual subject/date set and rechecks it after any epoch writer retires. */
export async function lockAttendancePolicyImportTx(tx:Tx,ctx:SessionContext,points:readonly {employmentId:string;date:string}[]):Promise<boolean>{
 assertModuleGate(ctx,'attendance');
 if(!points.length)return false;
 const [row]=await tx.execute(sql`select app.lock_attendance_policy_import_context(${JSON.stringify(points)}::jsonb) as configured`) as unknown as {configured:boolean}[];
 if(typeof row?.configured!=='boolean')throw Error('Canonical import policy context is unavailable.');
 return row.configured;
}
type ImportPoint={employmentId:string;date:string;ruleId:string|null;scheduleSource:string};
type ImportRoute='legacy'|'policy'|'unavailable';
/** Schedules come from the canonical memo AFTER the epoch barrier, never from the imported file.
 * Dated Personnel employer and frozen application admission retain their existing owners. The
 * result only routes raw labels; a policy route has no captured work, approval or payment output. */
export async function attendancePolicyImportRoutesTx(tx:Tx,ctx:SessionContext,points:readonly ImportPoint[]):Promise<Map<string,ImportRoute>>{
 assertModuleGate(ctx,'attendance');
 const out=new Map<string,ImportRoute>();
 const current=async()=>{
  const [row]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  if(!row?.allowed)throw Error('Current Attendance principal required.');
 };
 await current();
 for(let offset=0;offset<points.length;offset+=1000){
  const part=points.slice(offset,offset+1000),proof=await provenCompanyDatesTx(tx,part);
  const subjects=await tx.select({id:employment.id,companyId:employment.companyId}).from(employment)
   .where(and(eq(employment.tenantId,ctx.tenantId),inArray(employment.id,[...new Set(part.map(p=>p.employmentId))])));
  const bySubject=new Map(subjects.map(row=>[row.id,row.companyId]));
  const requested:{employmentId:string;date:string;ruleId:string;companyId:string}[]=[];
  for(const p of part){
   const key=p.employmentId+'|'+p.date,company=proof.get(key);
   if(!bySubject.has(p.employmentId)||!company?.companyId||company.reason
    ||p.scheduleSource==='policy'&&company.companyId!==bySubject.get(p.employmentId)){out.set(key,'unavailable');continue;}
   if(!p.ruleId){out.set(key,'legacy');continue;}
   requested.push({employmentId:p.employmentId,date:p.date,ruleId:p.ruleId,companyId:company.companyId});
  }
  if(!requested.length)continue;
  const rows=await tx.execute(sql`select point."employmentId",point.date::text as date,chosen.id as "policyId",
   chosen.policy,coalesce(application."predatesPolicy",false) as "legacyApplication"
   from jsonb_to_recordset(${JSON.stringify(requested)}::jsonb) as point("employmentId" uuid,date date,"ruleId" uuid,"companyId" uuid)
   left join lateral(select id,policy from public.attendance_group_policy_revision revision
    where revision.tenant_id=${ctx.tenantId}::uuid and revision.company_id=point."companyId"
     and revision.rule_id=point."ruleId" and revision.effective_from<=point.date
    order by revision.effective_from desc,revision.ordinal desc limit 1) chosen on true
   left join lateral(select ${legacyAttendancePolicyAdmissionSql(ctx,{companyId:sql`point."companyId"`,ruleId:sql`point."ruleId"`,date:sql`point.date`})} as "predatesPolicy"
    from ${attendanceCorrection} left join ${attendancePolicyRequestContract}
     on ${attendancePolicyRequestContract.correctionId}=${attendanceCorrection.id} and ${attendancePolicyRequestContract.tenantId}=${ctx.tenantId}::uuid
    where chosen.id is not null and ${attendanceCorrection.tenantId}=${ctx.tenantId}::uuid
     and ${attendanceCorrection.employmentId}=point."employmentId" and ${attendanceCorrection.attendanceDate}=point.date
     and ${attendanceCorrection.requestedOtMinutes} is not null and ${attendanceCorrection.status} in('approved','pending')
    order by case when ${attendanceCorrection.status}='approved' then 0 else 1 end,
     ${attendanceCorrection.decidedAt} desc,${attendanceCorrection.createdAt} desc,${attendanceCorrection.id} desc limit 1) application on true
   order by point."employmentId",point.date`) as unknown as {employmentId:string;date:string;policyId:string|null;policy:unknown;legacyApplication:boolean}[];
  const byPoint=new Map(rows.map(row=>[row.employmentId+'|'+row.date,row]));
  for(const p of requested){
   const key=p.employmentId+'|'+p.date,row=byPoint.get(key);
   if(!row)throw Error('Canonical import policy selection is incomplete.');
   if(row.policyId)validateAttendanceGroupPolicy(row.policy,4320);
   out.set(key,!row.policyId||row.legacyApplication?'legacy':'policy');
  }
 }
 await current();
 return out;
}
