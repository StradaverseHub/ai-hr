/** One calendar window statement (core/calendar-window-inputs.ts) answers every holiday, replacement day, leave presence
 * and dated company proof read inside its window exactly as the owners' own statements do.
 *
 * For each employment and each narrow window inside one wide window across a year end, every owner runs on its own
 * statements and on the rows the one statement read for the wide window, inside one read-only snapshot, and the results
 * must be identical: original holiday calendars (national, tentative, inactive, state, the company default state, a
 * company-subtree override inherited by a child company and another company's own override, an inheriting group whose
 * parent is extended, a custom group, a standard group, group-scoped extra days and ticked holidays, dated calendar
 * periods, a dated company change, and a tenure that starts and ends inside the window), retained replacement days
 * (covered and refused), approved and pending presence (whole span, per-date children, part days) and company proof.
 * A group whose states are not all text, another transaction, another employment and a window outside the read fall
 * back to the owners' own statements. Inside a Home stream the declared window is read once by the one statement. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client,declareSharedReadWindow,withSharedReadSnapshot,withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveEmploymentHolidayCalendarAssignment} from '../core/holiday-calendar-assignment';
import {holidayDatesFor,originalHolidayCalendarFor} from '../core/holidays';
import {replacementHolidayCalendarProjectionsTx} from '../core/holiday-replacement-read';
import {provenCompanyDatesTx} from '../core/employment-company';
import {readCalendarWindowInputsTx,withStagedHomeReads,type CalendarWindowInputs} from '../core/calendar-window-inputs';
import {approvedLeavePresenceByEmploymentTx,leaveCalendarPresenceByEmploymentTx} from '../packs/leave/service';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

// The next December not yet begun, so dated calendar periods can start inside the window.
const now=todayInKualaLumpur(),Y0=Number(now.slice(0,4))+(now.slice(5)<'12-01'?0:1),Y1=Y0+1;
const W={from:`${Y0}-12-10`,to:`${Y1}-01-25`};
const narrow:[string,string][]=[[W.from,W.to],[`${Y0}-12-10`,`${Y0}-12-13`],[`${Y0}-12-14`,`${Y0}-12-14`],[`${Y0}-12-15`,`${Y0}-12-21`],
 [`${Y0}-12-24`,`${Y1}-01-02`],[`${Y0}-12-27`,`${Y0}-12-27`],[`${Y0}-12-31`,`${Y1}-01-01`],[`${Y1}-01-04`,`${Y1}-01-11`],[`${Y1}-01-13`,`${Y1}-01-25`],[`${Y1}-01-25`,`${Y1}-01-25`]];
let b:Base,admin:SessionContext;
const subjects:{name:string;employmentId:string}[]=[];
let employee:SessionContext,employeeEmployment:string,oddGroupEmployment:string;

const dates=(from:string,to:string)=>{const out:string[]=[];for(let at=Date.parse(from+'T00:00:00Z');at<=Date.parse(to+'T00:00:00Z');at+=86400000)out.push(new Date(at).toISOString().slice(0,10));return out;};
const owners=(tx:Tx,id:string,from:string,to:string,pre?:CalendarWindowInputs)=>Promise.all([
 originalHolidayCalendarFor(tx,{employmentId:id,startDate:from,endDate:to},pre),
 holidayDatesFor(tx,{employmentId:id,startDate:from,endDate:to},pre).then(set=>[...set].sort()),
 replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[id],startDate:from,endDate:to},pre),
 approvedLeavePresenceByEmploymentTx(tx,[id],from,to,pre).then(map=>[...map].map(([key,days])=>[key,[...days]])),
 leaveCalendarPresenceByEmploymentTx(tx,[id],from,to,pre).then(value=>({approved:[...value.approved].map(([key,days])=>[key,[...days]]),
  pending:[...value.pending].map(([key,days])=>[key,[...days]])})),
 provenCompanyDatesTx(tx,[to,...dates(from,to),from].map(date=>({employmentId:id,date})),pre).then(map=>[...map]),
]);
async function sent<T>(work:()=>Promise<T>){
 const options=client.options as {debug?:unknown},texts:string[]=[],previous=options.debug;
 options.debug=(_connection:number,query:string)=>{texts.push(query.replace(/\s+/g,' ').trim());};
 try{return {result:await work(),texts};}finally{options.debug=previous;}
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();admin=adminCtx(b);
 await owner.db.update(s.company).set({defaultWorkState:'Selangor'}).where(eq(s.company.id,b.companyId));
 const [holding]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional holding company',country:'MY'}).returning();
 const [child]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional child company',country:'MY',parentCompanyId:holding.id}).returning();
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other company',country:'MY'}).returning();
 const department=async(companyId:string)=>(await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId,name:'Fictional department'}).returning())[0].id;
 const childDepartment=await department(child.id),otherDepartment=await department(other.id);
 const hire=async(name:string,companyId=b.companyId,departmentId=b.deptA,hiredOn=`${Y0}-01-01`)=>{
  const hired=await hireEmployee(admin,{person:{fullName:'Fictional '+name,primaryEmail:randomUUID()+'@calendar-window.test'},companyId,departmentId,employmentType:'full_time',hiredOn});
  subjects.push({name,employmentId:hired.employmentId});
  return hired;
 };
 const group=async(name:string,states:string[],archetype:'standard'|'extended'|'custom',parentGroupId:string|null=null)=>
  (await owner.db.insert(s.holidayGroup).values({tenantId:b.tenantId,name,states,archetype,parentGroupId}).returning())[0].id;
 const parent=await group('Fictional extended parent',['Johor'],'extended');
 const inheriting=await group('Fictional inheriting child',['Sabah'],'standard',parent);
 const custom=await group('Fictional custom calendar',[],'custom');
 const standard=await group('Fictional standard calendar',['Selangor','Johor'],'standard');
 const holiday=(holidayDate:string,name:string,extra:Partial<typeof s.holiday.$inferInsert>={})=>({tenantId:b.tenantId,country:'MY',holidayDate,name:'Fictional '+name,...extra});
 const [national]=await owner.db.insert(s.holiday).values(holiday(`${Y0}-12-25`,'national')).returning();
 const [sabah]=await owner.db.insert(s.holiday).values(holiday(`${Y1}-01-08`,'Sabah day',{state:'Sabah'})).returning();
 await owner.db.insert(s.holiday).values([
  holiday(`${Y0}-12-31`,'tentative',{tentative:true}),holiday(`${Y1}-01-01`,'new year'),holiday(`${Y1}-01-20`,'inactive',{active:false}),
  holiday(`${Y0}-12-11`,'Selangor day',{state:'Selangor'}),holiday(`${Y0}-12-12`,'Johor day',{state:'Johor'}),
  // A company-subtree override for the holding company's next year, inherited by its child; the other company's own this year.
  holiday(`${Y1}-01-14`,'group override',{companyId:holding.id}),holiday(`${Y0}-12-20`,'other company day',{companyId:other.id}),
  holiday(`${Y0}-12-15`,'parent extra',{holidayGroupId:parent}),holiday(`${Y0}-12-16`,'child extra',{holidayGroupId:inheriting}),
  holiday(`${Y0}-12-17`,'custom extra',{holidayGroupId:custom}),holiday(`${Y0}-12-18`,'standard extra',{holidayGroupId:standard}),
  holiday(`${Y0}-12-19`,'Singapore day',{country:'SG'}),
 ]);
 await owner.db.insert(s.holidayGroupHoliday).values([{tenantId:b.tenantId,holidayGroupId:inheriting,holidayId:sabah.id},{tenantId:b.tenantId,holidayGroupId:parent,holidayId:sabah.id}]);
 const plain=await hire('plain');
 await hire('child company',child.id,childDepartment);
 await hire('other company',other.id,otherDepartment);
 const stateful=await hire('work state');
 await owner.db.update(s.employment).set({workState:'Johor'}).where(eq(s.employment.id,stateful.employmentId));
 for(const [name,groupId] of [['inheriting group',inheriting],['custom group',custom],['standard group',standard]] as const){
  const hired=await hire(name);
  await owner.db.update(s.employment).set({holidayGroupId:groupId}).where(eq(s.employment.id,hired.employmentId));
 }
 const dated=await hire('dated calendar');
 await saveEmploymentHolidayCalendarAssignment(admin,{employmentId:dated.employmentId,startDate:`${Y0}-12-20`,endDate:`${Y1}-01-10`,selection:{kind:'state',state:'Sabah'}});
 await saveEmploymentHolidayCalendarAssignment(admin,{employmentId:dated.employmentId,startDate:`${Y1}-01-11`,selection:{kind:'group',groupId:standard}});
 // A dated company change inside the window: the parent company until 26 December, the other company from the 27th.
 const moved=await hire('company change');
 const [current]=await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,moved.employmentId));
 await owner.db.update(s.assignment).set({validTo:`${Y0}-12-27`}).where(eq(s.assignment.id,current.id));
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:moved.employmentId,departmentId:otherDepartment,companyId:other.id,
  employmentType:current.employmentType,validFrom:`${Y0}-12-27`});
 const tenure=await hire('short tenure',b.companyId,b.deptA,`${Y0}-12-14`);
 await owner.db.update(s.employment).set({terminatedOn:`${Y1}-01-10`}).where(eq(s.employment.id,tenure.employmentId));
 // A group whose states hold a number: the window declines to answer, so every owner would read alone.
 const odd=await hireEmployee(admin,{person:{fullName:'Fictional odd group',primaryEmail:randomUUID()+'@calendar-window.test'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:`${Y0}-01-01`});oddGroupEmployment=odd.employmentId;
 const [oddGroup]=await owner.db.insert(s.holidayGroup).values({tenantId:b.tenantId,name:'Fictional odd calendar',states:['Selangor',7]}).returning();
 await owner.db.update(s.employment).set({holidayGroupId:oddGroup.id}).where(eq(s.employment.id,odd.employmentId));
 // Replacement days for the plain employment: one covered, one refused because its recorded company is another.
 const [policy]=await owner.db.insert(s.replacementHolidayPolicy).values({tenantId:b.tenantId,companyId:b.companyId,effectiveFrom:now,regime:'MY_EA_60D',
  confirmed:true,restMode:'scheduled_rest',searchDays:30,reason:'Fictional replacement policy',createdBy:'fixture'}).returning();
 const [newYear]=await owner.db.select().from(s.holiday).where(eq(s.holiday.name,'Fictional new year'));
 await owner.db.insert(s.replacementHoliday).values([
  {tenantId:b.tenantId,employmentId:plain.employmentId,companyId:b.companyId,sourceHolidayId:national.id,policyId:policy.id,sourceDate:`${Y0}-12-25`,
   sourceName:national.name,inputDigest:'fictional',status:'allocated',replacementDate:`${Y0}-12-28`,reason:'Fictional replacement'},
  {tenantId:b.tenantId,employmentId:plain.employmentId,companyId:other.id,sourceHolidayId:newYear.id,policyId:policy.id,sourceDate:`${Y1}-01-01`,
   sourceName:newYear.name,inputDigest:'fictional',status:'allocated',replacementDate:`${Y1}-01-02`,reason:'Fictional refused replacement'},
 ]);
 const [withChildren]=await owner.db.insert(s.leaveRequest).values([
  {tenantId:b.tenantId,employmentId:plain.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y1}-01-05`,endDate:`${Y1}-01-07`,days:'3',status:'approved' as const},
  {tenantId:b.tenantId,employmentId:plain.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y0}-12-16`,endDate:`${Y0}-12-18`,days:'3',status:'approved' as const},
  {tenantId:b.tenantId,employmentId:plain.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y0}-12-22`,endDate:`${Y0}-12-22`,days:'0.5',durationType:'half_day_pm',status:'approved' as const},
  {tenantId:b.tenantId,employmentId:plain.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y1}-01-12`,endDate:`${Y1}-01-13`,days:'2',status:'pending' as const},
 ]).returning();
 await owner.db.insert(s.leaveRequestDate).values([
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:plain.employmentId,leaveDate:`${Y1}-01-05`,days:'1',status:'approved' as const},
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:plain.employmentId,leaveDate:`${Y1}-01-06`,days:'1',status:'rejected' as const},
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:plain.employmentId,leaveDate:`${Y1}-01-07`,days:'1',status:'approved' as const},
 ]);
 employeeEmployment=plain.employmentId;
 const userId=await createAppUser(b.tenantId,plain.personId,'employee');
 employee={tenantId:b.tenantId,userId,personId:plain.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
},300_000);
afterAll(closeAll);

describe('the calendar window statement',()=>{
 it('answers every owner for every window inside it exactly as the owners\' own statements do',async()=>{
  const observed:Record<string,unknown>={};
  for(const subject of subjects){
   await withTenant(admin,async tx=>{
    const pre=await readCalendarWindowInputsTx(tx,subject.employmentId,W.from,W.to);
    for(const [from,to] of narrow){
     const live=await owners(tx,subject.employmentId,from,to);
     const {result:bundled,texts}=await sent(()=>owners(tx,subject.employmentId,from,to,pre));
     expect(JSON.stringify(bundled),`${subject.name} ${from}..${to}`).toBe(JSON.stringify(live));
     expect(bundled).toStrictEqual(live);
     expect(texts,`${subject.name} ${from}..${to} sent nothing`).toEqual([]);
    }
    observed[subject.name]=(await owners(tx,subject.employmentId,W.from,W.to))[1];
   },{readOnlySnapshot:true});
  }
  console.info('[home-calendar-window] '+JSON.stringify(observed));
  // Non-vacuity: the branches named above produced different calendars.
  const days=(name:string)=>observed[name] as string[];
  expect(days('plain')).toEqual(expect.arrayContaining([`${Y0}-12-11`,`${Y0}-12-25`,`${Y0}-12-28`,`${Y0}-12-31`,`${Y1}-01-01`]));
  expect(days('plain')).not.toContain(`${Y1}-01-02`);
  expect(days('child company')).toContain(`${Y1}-01-14`);
  expect(days('child company')).not.toContain(`${Y1}-01-01`);
  expect(days('other company')).toEqual(expect.arrayContaining([`${Y0}-12-20`,`${Y1}-01-01`]));
  expect(days('other company')).not.toContain(`${Y0}-12-25`);
  expect(days('work state')).toContain(`${Y0}-12-12`);
  expect(days('inheriting group')).toEqual(expect.arrayContaining([`${Y0}-12-12`,`${Y0}-12-15`,`${Y0}-12-16`,`${Y1}-01-08`]));
  expect(days('custom group')).toEqual([`${Y0}-12-17`]);
  expect(days('standard group')).toEqual(expect.arrayContaining([`${Y0}-12-11`,`${Y0}-12-12`,`${Y0}-12-18`]));
  expect(days('company change')).toEqual(expect.arrayContaining([`${Y0}-12-11`,`${Y1}-01-01`]));
  expect(days('short tenure')).not.toContain(`${Y0}-12-11`);
  expect(days('dated calendar')).toEqual(expect.arrayContaining([`${Y0}-12-11`,`${Y1}-01-08`]));
 },240_000);

 it('answers the same for an employee reading their own employment under their own row security',async()=>{
  await withTenant(employee,async tx=>{
   const pre=await readCalendarWindowInputsTx(tx,employeeEmployment,W.from,W.to);
   for(const [from,to] of narrow)expect(await owners(tx,employeeEmployment,from,to,pre)).toStrictEqual(await owners(tx,employeeEmployment,from,to));
   const presence=await leaveCalendarPresenceByEmploymentTx(tx,[employeeEmployment],W.from,W.to,pre);
   expect([...presence.approved.get(employeeEmployment)!]).toContainEqual([`${Y0}-12-22`,'part_day']);
   expect([...presence.pending.get(employeeEmployment)!].map(([day])=>day)).toEqual([`${Y1}-01-12`,`${Y1}-01-13`]);
   expect((await replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[employeeEmployment],startDate:W.from,endDate:W.to},pre)).map(row=>row.replacementDate)).toEqual([`${Y0}-12-28`]);
  },{readOnlySnapshot:true});
 });

 it('declines another transaction, another employment, a window outside its own and a group whose states are not text',async()=>{
  const [first,second]=[subjects[0].employmentId,subjects[1].employmentId];
  const pre=await withTenant(admin,tx=>readCalendarWindowInputsTx(tx,first,`${Y0}-12-20`,`${Y0}-12-31`),{readOnlySnapshot:true});
  await withTenant(admin,async tx=>{
   expect(pre.answers(tx,first,`${Y0}-12-21`,`${Y0}-12-22`)).toBe(false);
   const {texts}=await sent(()=>owners(tx,first,`${Y0}-12-21`,`${Y0}-12-22`,pre));
   expect(texts.length).toBeGreaterThan(0);
   const own=await readCalendarWindowInputsTx(tx,first,`${Y0}-12-20`,`${Y0}-12-31`);
   expect([own.answers(tx,second,`${Y0}-12-21`,`${Y0}-12-22`),own.answers(tx,first,`${Y0}-12-19`,`${Y0}-12-22`),own.answers(tx,first,`${Y0}-12-30`,`${Y1}-01-01`),
    own.answers(tx,first,`${Y0}-12-21`,`${Y0}-12-21`)]).toEqual([false,false,false,true]);
   const odd=await readCalendarWindowInputsTx(tx,oddGroupEmployment,W.from,W.to);
   expect(odd.answers(tx,oddGroupEmployment,W.from,W.to)).toBe(false);
  },{readOnlySnapshot:true});
 });

 it('is the one statement a Home stream\'s declared window reads, and staged reads keep the owners\' own',async()=>{
  for(const subject of subjects.slice(0,3)){
   const independent=await Promise.all(narrow.map(([from,to])=>withTenant(admin,tx=>owners(tx,subject.employmentId,from,to),{readOnlySnapshot:true})));
   const run=(staged:boolean)=>sent(()=>withSharedReadSnapshot(admin,async()=>{
    declareSharedReadWindow(subject.employmentId,W.from,W.to);
    const read=()=>Promise.all(narrow.map(([from,to])=>withTenant(admin,tx=>owners(tx,subject.employmentId,from,to),{readOnlySnapshot:true})));
    return staged?withStagedHomeReads(read):read();
   }));
   const [bundled,staged]=[await run(false),await run(true)];
   expect(bundled.result).toStrictEqual(independent);
   expect(staged.result).toStrictEqual(independent);
   const calendarStatements=(texts:string[])=>texts.filter(text=>text.includes('w_employment')).length;
   expect(calendarStatements(bundled.texts)).toBe(1);
   expect(calendarStatements(staged.texts)).toBe(0);
   expect(bundled.texts.filter(text=>/from "holiday"|leave_calendar_presence|"replacement_holiday"|"employment_holiday_calendar"|proven_company_date_points/.test(text)
    &&!text.includes('w_employment'))).toEqual([]);
   console.info('[home-calendar-window-stream] '+JSON.stringify({subject:subject.name,bundled:bundled.texts.length,staged:staged.texts.length}));
   expect(bundled.texts.length).toBeLessThan(staged.texts.length);
  }
 },120_000);
});
