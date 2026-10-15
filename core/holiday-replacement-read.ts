/** Employee projection only. This reader never resolves schedules or allocates another holiday. */
import {and,eq,gte,inArray,isNotNull,lte,asc,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {replacementHoliday,replacementHolidayRevision,replacementHolidayQueue,employment,person,holiday} from '../db/schema';
export async function replacementHolidayDatesByEmployment(tx:Tx,p:{employmentIds:readonly string[];startDate:string;endDate:string}){
 const out=new Map<string,Set<string>>();
 if(!p.employmentIds.length)return out;
 const rows=await tx.select({employmentId:replacementHoliday.employmentId,date:replacementHoliday.replacementDate}).from(replacementHoliday).where(and(inArray(replacementHoliday.employmentId,[...p.employmentIds]),isNotNull(replacementHoliday.replacementDate),gte(replacementHoliday.replacementDate,p.startDate),lte(replacementHoliday.replacementDate,p.endDate))).orderBy(asc(replacementHoliday.employmentId),asc(replacementHoliday.replacementDate));
 for(const row of rows){const dates=out.get(row.employmentId)??new Set<string>();if(row.date)dates.add(row.date);out.set(row.employmentId,dates);}return out;
}
export function listReplacementHolidays(ctx:SessionContext,p:{companyIds?:readonly string[];employmentId?:string;from?:string;to?:string}={}){
 return withTenant(ctx,tx=>tx.select().from(replacementHoliday).where(and(p.companyIds?inArray(replacementHoliday.companyId,[...p.companyIds]):undefined,p.employmentId?eq(replacementHoliday.employmentId,p.employmentId):undefined,p.from?gte(replacementHoliday.sourceDate,p.from):undefined,p.to?lte(replacementHoliday.sourceDate,p.to):undefined)).orderBy(asc(replacementHoliday.sourceDate),asc(replacementHoliday.employmentId),asc(replacementHoliday.id)));
}
export function replacementHolidayHistory(ctx:SessionContext,id:string){return withTenant(ctx,tx=>tx.select().from(replacementHolidayRevision).where(eq(replacementHolidayRevision.allocationId,id)).orderBy(asc(replacementHolidayRevision.createdAt),asc(replacementHolidayRevision.id)));}
export function replacementHolidayCalendarNotes(ctx:SessionContext,p:{employmentId:string;from:string;to:string}){
 return withTenant(ctx,tx=>tx.select().from(replacementHoliday).where(and(eq(replacementHoliday.employmentId,p.employmentId),isNotNull(replacementHoliday.replacementDate),gte(replacementHoliday.replacementDate,p.from),lte(replacementHoliday.replacementDate,p.to))).orderBy(asc(replacementHoliday.replacementDate),asc(replacementHoliday.id)));
}

export function replacementHolidayReviewRows(ctx:SessionContext,companyId:string){
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({allocation:replacementHoliday,name:person.fullName,employeeCode:employment.employeeCode,currentSourceDate:holiday.holidayDate}).from(replacementHoliday).innerJoin(employment,eq(employment.id,replacementHoliday.employmentId)).innerJoin(person,eq(person.id,employment.personId)).innerJoin(holiday,eq(holiday.id,replacementHoliday.sourceHolidayId)).where(eq(replacementHoliday.companyId,companyId)).orderBy(asc(replacementHoliday.sourceDate),asc(person.fullName),asc(replacementHoliday.id));
  const failures=await tx.select({employmentId:employment.id,name:person.fullName,error:replacementHolidayQueue.lastError,calendarConflicts:replacementHolidayQueue.calendarConflicts}).from(replacementHolidayQueue).innerJoin(employment,eq(employment.id,replacementHolidayQueue.employmentId)).innerJoin(person,eq(person.id,employment.personId)).where(and(eq(employment.companyId,companyId),or(isNotNull(replacementHolidayQueue.lastError),sql`jsonb_array_length(${replacementHolidayQueue.calendarConflicts})>0`))).orderBy(asc(person.fullName),asc(employment.id));
  return {rows,failures};
 });
}
