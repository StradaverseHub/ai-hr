/** Frozen2f9 native body, SHA256 pinned in the source test. Actual native admission and inserts;
 * emits genuine old-format events without ever editing an immutable event or fabricating a frame. */
import {and,eq,isNull,or,gt,sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../../db/client';
import {assignment,employment} from '../../db/schema';
import {appendEvent,actorOf} from '../../db/events';
import {isCalendarDate} from '../../lib/calendar-date';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx} from '../../core/workforce-access';
import {deriveCompanyOrganisationTx,recordEmploymentOrganisationTagsTx,type OrganisationTagTrigger} from '../../core/company-organisation';
function earliestEmploymentDate(...dates: (string | null | undefined)[]): string | null {
  const present = dates.filter((d): d is string => d != null);
  return present.length === 0 ? null : present.reduce((a, b) => (a < b ? a : b));
}
export async function projectEmploymentOrganisationAssignmentTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;effectiveOn:string;trigger:OrganisationTagTrigger}):Promise<{changed:number;assignmentIds:string[]}>{
  if(!isCalendarDate(p.effectiveOn))throw new Error('Select a valid organisation reference date.');
  await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
  await tx.execute(sql`select app.access_configuration_write_lock()`);
  const [emp]=await tx.select().from(employment).where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,ctx.tenantId))).for('update');
  if(!emp)throw new Error('Employment is unavailable.');
  const endedOn=earliestEmploymentDate(emp.resignationDate,emp.lastWorkingDate,emp.terminatedOn);
  if(emp.voidedAt||emp.hiredOn>p.effectiveOn||(endedOn&&endedOn<=p.effectiveOn)||(emp.blacklistedAt&&todayInKualaLumpur(new Date(emp.blacklistedAt))<=p.effectiveOn))return {changed:0,assignmentIds:[]};
  const rows=await tx.select().from(assignment).where(and(eq(assignment.employmentId,p.employmentId),eq(assignment.tenantId,ctx.tenantId),isNull(assignment.supersededAt),or(isNull(assignment.validTo),gt(assignment.validTo,p.effectiveOn)))).orderBy(assignment.validFrom).for('update');
  const assignmentIds:string[]=[];
  let changed=0;
  for(const row of rows){
    const companyId=row.companyId??emp.companyId;
    await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
    const [boundary]=await tx.execute<{next:string|null}>(sql`select app.company_organisation_next_change(${companyId}::uuid,${p.effectiveOn}::date)::text as next`);
    const from=row.validFrom>p.effectiveOn?row.validFrom:p.effectiveOn;
    const to=boundary?.next&&(!row.validTo||boundary.next<row.validTo)?boundary.next:row.validTo;
    if(to&&from>=to)continue;
    const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId,asOf:from});
    if(tags.status==='legacy'||tags.businessUnitId===row.businessUnitId)continue;
    const source=await tx.update(assignment).set({supersededAt:new Date()}).where(and(eq(assignment.id,row.id),isNull(assignment.supersededAt))).returning({id:assignment.id});
    if(source.length!==1)throw new Error('Assignment changed during organisation publication.');
    const parts:Array<{validFrom:string;validTo:string|null;businessUnitId:string|null}>=[];
    if(row.validFrom<from)parts.push({validFrom:row.validFrom,validTo:from,businessUnitId:row.businessUnitId});
    parts.push({validFrom:from,validTo:to,businessUnitId:tags.businessUnitId});
    if(to&&(!row.validTo||to<row.validTo))parts.push({validFrom:to,validTo:row.validTo,businessUnitId:row.businessUnitId});
    for(const part of parts){
      const [next]=await tx.insert(assignment).values({tenantId:row.tenantId,employmentId:row.employmentId,departmentId:row.departmentId,positionId:row.positionId,costCenterId:row.costCenterId,locationId:row.locationId,companyId:row.companyId,employmentType:row.employmentType,...part}).returning({id:assignment.id});
      assignmentIds.push(next.id);
    }
    await recordEmploymentOrganisationTagsTx(tx,ctx,{employmentId:p.employmentId,companyId,asOf:from,trigger:p.trigger});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'assignment',aggregateId:row.id,eventType:'employment.organisation.projected',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{sourceAssignmentId:row.id,effectiveOn:from,validTo:to,beforeBusinessUnitId:row.businessUnitId,businessUnitId:tags.businessUnitId,mappingVersionId:tags.mappingVersionId,trigger:p.trigger}});
    changed++;
  }
  return {changed,assignmentIds};
}
