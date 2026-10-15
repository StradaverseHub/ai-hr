/** Empty reporting-edge sets serialize through the actual subordinate employment row. */
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {hireEmployee,setReportingLine} from '../core/org';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function waiting(count:number){for(let i=0;i<500;i++){const [row]=await owner.db.execute(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and wait_event_type='Lock'`) as unknown as {n:number}[];if(row.n>=count)return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Both actual reporting writers must reach their database lock');}
it('serializes two canonical writers starting with NO administrative edge, retaining exactly one open edge',async()=>{
 const ctx=adminCtx(b),on=todayInKualaLumpur(),hire=(name:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:name+'@reporting-lock.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const previous=new Date(on+'T00:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);const earlier=previous.toISOString().slice(0,10);
 const subordinate=await hire('subordinate'),a=await hire('managerA'),other=await hire('managerB');
 expect(await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,subordinate.employmentId))).toHaveLength(0);
 let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve),unblock=new Promise<void>(resolve=>release=resolve);
 const blocker=owner.db.transaction(async tx=>{await tx.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.id,subordinate.employmentId),eq(s.employment.tenantId,b.tenantId))).for('update');locked();await unblock;});await ready;
 let first:ReturnType<typeof setReportingLine>|undefined,second:ReturnType<typeof setReportingLine>|undefined,queueFailure:unknown;
 try{first=setReportingLine(ctx,{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:a.employmentId,lineType:'administrative',validFrom:earlier});await waiting(1);second=setReportingLine(ctx,{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:other.employmentId,lineType:'administrative',validFrom:on});await waiting(2);}catch(error){queueFailure=error;}finally{release();await blocker;}
 if(queueFailure){await Promise.allSettled([first,second].filter((p):p is ReturnType<typeof setReportingLine>=>!!p));throw queueFailure;}if(!first||!second)throw new Error('Both canonical writers are required');await Promise.all([first,second]);
 const rows=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,subordinate.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.supersededAt))).orderBy(asc(s.reportingLine.id));
 expect(rows).toHaveLength(2);expect(rows.filter(row=>row.validTo===null)).toHaveLength(1);expect(rows.filter(row=>row.validTo!==null)).toHaveLength(1);
 const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,subordinate.employmentId),eq(s.domainEvent.aggregateType,'reporting-line'))).orderBy(asc(s.domainEvent.sequence));expect(events.filter(row=>row.eventType==='reporting-line.set')).toHaveLength(2);expect(events.filter(row=>row.eventType==='reporting-line.superseded')).toHaveLength(1);
},60000);
