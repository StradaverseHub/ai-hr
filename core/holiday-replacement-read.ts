/** Employee projection only. This reader never resolves schedules or allocates another holiday. */
import {and,eq,gte,inArray,isNotNull,lte,asc} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {replacementHoliday,replacementHolidayRevision} from '../db/schema';
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
