/** Actual Records owner: date-bounded native inputs, exact legacy figures and one MVCC snapshot. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {client,type SessionContext} from '../db/client';
import {attendanceEmploymentRangePage,attendanceForEmploymentRange,attendancePunchesForRange} from '../packs/attendance/service';
import {hireEmployee} from '../core/org';
import {parsePageQuery} from '../lib/pagination';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,personId:string;
const from='2026-07-01',to='2026-07-31';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);
 ({employmentId,personId}=await hireEmployee(ctx,{person:{fullName:'Fictional paged attendance',primaryEmail:'paged-attendance@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const days=Array.from({length:31},(_,i)=>({id:randomUUID(),tenantId:b.tenantId,employmentId,attendanceDate:`2026-07-${String(i+1).padStart(2,'0')}`,checkInAt:'08:00',checkOutAt:'17:00',status:'present' as const,dayType:'workday' as const,workedMinutes:480,otMinutes:0}));
 await owner.db.insert(schema.attendance).values(days);
 const punchDays=days.filter((_,i)=>[0,24,25,30].includes(i));
 await owner.db.insert(schema.attendancePunch).values(punchDays.flatMap(day=>[
  {tenantId:b.tenantId,employmentId,attendanceId:day.id,attendanceDate:day.attendanceDate,punchAt:'08:00',direction:'in' as const},
  {tenantId:b.tenantId,employmentId,attendanceId:day.id,attendanceDate:day.attendanceDate,punchAt:'12:00',direction:'out' as const},
  {tenantId:b.tenantId,employmentId,attendanceId:day.id,attendanceDate:day.attendanceDate,punchAt:'13:00',direction:'in' as const},
  {tenantId:b.tenantId,employmentId,attendanceId:day.id,attendanceDate:day.attendanceDate,punchAt:'17:00',direction:'out' as const},
 ]));
});

/** Observe real .values() results, preserving their native execution and mapping. */
function observeDayQueries(afterRows?:(params:unknown[])=>Promise<void>){
 const begin=client.begin.bind(client),queries:{params:unknown[];rows:number}[]=[];
 const spy=vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index] as (native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    const pending=Reflect.apply(target.unsafe,target,query);
    if(typeof query[0]==='string'&&query[0].includes('from "attendance"'))return new Proxy(pending,{get(result,key){
     if(key==='values')return async(...args:unknown[])=>{
      const rows=await Reflect.apply(result.values,result,args);if(!Array.isArray(rows))throw Error('Native values expected');
      const params=Array.isArray(query[1])?query[1]:[];queries.push({params,rows:rows.length});await afterRows?.(params);return rows;
     };
     const value=Reflect.get(result,key,result);return typeof value==='function'?value.bind(result):value;
    }});
    return pending;
   };
   return Reflect.get(target,key,receiver);
  }}));
  return Reflect.apply(begin,client,args);
 }) as typeof client.begin);
 return {spy,queries};
}

it('queries only visible dates before canonical derivation, with exact totals and complete punch trails',async()=>{
 const canonical=await attendanceForEmploymentRange(ctx,employmentId,from,to),allPunches=await attendancePunchesForRange(ctx,employmentId,from,to);
 expect(canonical).toHaveLength(31);expect(canonical.map(row=>row.workedMinutes)).toEqual(Array(31).fill(480));
 const {spy,queries}=observeDayQueries();
 try{
  const first=await attendanceEmploymentRangePage(ctx,employmentId,from,to,parsePageQuery());
  const last=await attendanceEmploymentRangePage(ctx,employmentId,from,to,parsePageQuery({page:'1'}));
  expect(first.dayPage).toEqual(canonical.slice(0,25));expect(last.dayPage).toEqual(canonical.slice(25));
  expect(first.pgState).toMatchObject({total:31,from:1,to:25,hasNext:true});expect(last.pgState).toMatchObject({total:31,from:26,to:31,hasNext:false});
  for(const result of [first,last]){
   expect(result.total).toBe(31);expect(result.punchesByAttendance.size).toBe(2);
   for(const [id,punches]of result.punchesByAttendance){expect(punches).toEqual(allPunches.get(id));expect(punches.map(p=>p.punchAt)).toEqual(['08:00:00','12:00:00','13:00:00','17:00:00']);}
  }
  expect(queries).toHaveLength(2);expect(queries.map(query=>query.rows)).toEqual([25,6]);
  expect(queries[0].params).toEqual(expect.arrayContaining(['2026-07-01','2026-07-25']));expect(queries[0].params).not.toContain('2026-07-31');
  expect(queries[1].params).toEqual(expect.arrayContaining(['2026-07-26','2026-07-31']));
  expect(spy).toHaveBeenCalledTimes(2);
 }finally{spy.mockRestore();}
});

it('keeps day figures and punch details on one snapshot when an update commits between their reads',async()=>{
 let changed=false;
 const {spy}=observeDayQueries(async()=>{
  if(changed)return;changed=true;
  await owner.client.begin(async tx=>{
   await tx`update attendance set worked_minutes=600,check_out_at='19:00' where employment_id=${employmentId}::uuid and attendance_date='2026-07-26'`;
   await tx`update attendance_punch set punch_at='19:00' where employment_id=${employmentId}::uuid and attendance_date='2026-07-26' and punch_at='17:00'`;
  });
 });
 let old:Awaited<ReturnType<typeof attendanceEmploymentRangePage>>;
 try{old=await attendanceEmploymentRangePage(ctx,employmentId,from,to,parsePageQuery({page:'1'}));}finally{spy.mockRestore();}
 expect(changed).toBe(true);expect(old.dayPage[0].workedMinutes).toBe(480);expect(old.dayPage[0].checkOutAt).toBe('17:00:00');
 expect(old.punchesByAttendance.get(old.dayPage[0].attendanceId!)!.at(-1)!.punchAt).toBe('17:00:00');
 const fresh=await attendanceEmploymentRangePage(ctx,employmentId,from,to,parsePageQuery({page:'1'}));
 expect(fresh.dayPage[0].workedMinutes).toBe(600);expect(fresh.dayPage[0].checkOutAt).toBe('19:00:00');
 expect(fresh.punchesByAttendance.get(fresh.dayPage[0].attendanceId!)!.at(-1)!.punchAt).toBe('19:00:00');
});

it('preserves native own and foreign visibility, rejects forged callers and keeps empty-page counts truthful',async()=>{
 const employee={...ctx,userId:await createAppUser(b.tenantId,personId,'employee'),personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
 expect((await attendanceEmploymentRangePage(employee,employmentId,from,to,parsePageQuery())).dayPage).toHaveLength(25);
 const foreign=adminCtx(await seedBase());
 expect(await attendanceForEmploymentRange(foreign,employmentId,from,to)).toEqual([]);
 expect(await attendanceEmploymentRangePage(foreign,employmentId,from,to,parsePageQuery())).toMatchObject({dayPage:[],total:0});
 await expect(attendanceEmploymentRangePage({...ctx,personId:randomUUID()},employmentId,from,to,parsePageQuery())).rejects.toThrow('calling authority');
 const {spy,queries}=observeDayQueries();
 try{expect(await attendanceEmploymentRangePage(ctx,employmentId,from,to,parsePageQuery({page:'100'}))).toMatchObject({dayPage:[],total:31,pgState:{from:0,to:0}});expect(queries).toEqual([]);}finally{spy.mockRestore();}
});

it.each([['2026-02-30',to],['2026-08-01',to],['2020-01-01',to]])('rejects an invalid or truncated range before SQL (%s)',async(start,end)=>{
 const begin=vi.spyOn(client,'begin');
 try{await expect(attendanceEmploymentRangePage(ctx,employmentId,start,end,parsePageQuery())).rejects.toThrow('valid Attendance range');expect(begin).not.toHaveBeenCalled();}finally{begin.mockRestore();}
});
