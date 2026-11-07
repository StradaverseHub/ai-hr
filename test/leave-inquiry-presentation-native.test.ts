/** Native authority and exact old-population/ICU-order parity for Leave inquiry. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import * as database from '../db/client';
import * as schema from '../db/schema';
import {leaveInquiryContext,leaveInquirySnapshot,leaveInquiryBalancePairs,leaveInquiryBalancePairsTx,leaveInquiryRecordsPage,leaveInquiryRecordsPageTx} from '../core/leave-inquiry';
import {listEmployees,leaveBalanceInquiryMembershipTx} from '../core/read';
import {inquiryBalancePage} from '../app/leave/employee-balances/inquiry-data';
import {parseInquiryQuery,InquiryQueryError} from '../lib/leave-inquiry-query';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';

let b:Base,ctx:SessionContext,ids:string[],foreignCompany:string,foreignId:string,hiddenType:string,archivedType:string;
const keys=['employmentId','name','employeeCode','company','companyId','department','departmentId','businessUnit','businessUnitId','terminatedOn'] as const;
const locales=['en','ms','ta','th','vi','zh'] as const;
const today=todayInKualaLumpur();
const query=(p:Record<string,string|string[]|undefined>={})=>parseInquiryQuery({asOf:today,...p},'balances');
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);ids=[];
 const names=['A','a','Á','Å','İnci','i\u0307nci','ΟΣ','Ος','σ','Straße','STRASSE','Kelvin','Kelvin','Emoji 😀','人員','甲','காவியா','สมชาย','Nguyễn','Duplicate'];
 const people=Array.from({length:124},(_,n)=>({id:randomUUID(),tenantId:b.tenantId,fullName:names[n%names.length]+(n%4===0?'':' '+String(n%7)),primaryEmail:randomUUID()+'@example.invalid',gender:n%3===0?'female' as const:'male' as const}));
 await owner.db.insert(schema.person).values(people);
 ids=people.map(()=>randomUUID());
 await owner.db.insert(schema.employment).values(people.map((p,n)=>({id:ids[n],tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employeeCode:n%13===0?null:(n%3===0?'e':'E')+'-'+String(n).padStart(3,'0'),hiredOn:'2020-01-01',terminatedOn:n%5===0?'2024-01-01':null})));
 await owner.db.insert(schema.assignment).values(ids.slice(1).map((id,n)=>({tenantId:b.tenantId,employmentId:id,companyId:b.companyId,departmentId:n%2===0?b.deptA:b.deptB,employmentType:'full_time' as const,validFrom:n===0?'2099-01-01':'2020-01-01'})));
 await owner.db.insert(schema.assignment).values([
  {tenantId:b.tenantId,employmentId:ids[2],companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2018-01-01',validTo:'2019-12-31'},
  {tenantId:b.tenantId,employmentId:ids[3],companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',validFrom:'2018-01-01',supersededAt:new Date()},
 ]);
 const [hidden]=await owner.db.insert(schema.leaveType).values({tenantId:b.tenantId,code:'HID',name:'Hidden HR type',visibleToEmployee:false}).returning();hiddenType=hidden.id;
 const [archived]=await owner.db.insert(schema.leaveType).values({tenantId:b.tenantId,code:'OLD',name:'Archived historical type',archivedAt:new Date()}).returning();archivedType=archived.id;
 await owner.db.insert(schema.leaveType).values({tenantId:b.tenantId,code:'WOM',name:'Eligibility type',eligibility:{gender:['female']}});
 await owner.db.insert(schema.leaveLedger).values(ids.slice(0,2).map(id=>({tenantId:b.tenantId,employmentId:id,leaveTypeId:archivedType,entryType:'adjustment' as const,days:'1',effectiveOn:today})));
 const foreign=await seedBase();foreignCompany=foreign.companyId;
 const [p]=await owner.db.insert(schema.person).values({tenantId:foreign.tenantId,fullName:'Foreign inquiry subject',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const [e]=await owner.db.insert(schema.employment).values({tenantId:foreign.tenantId,personId:p.id,companyId:foreign.companyId,hiredOn:'2020-01-01'}).returning();foreignId=e.id;
});

it('projects the same legacy rows without extra private fields, including ended/future/absent assignment facts',async()=>{
 const old=await listEmployees(ctx,[b.companyId]),scope=await leaveInquiryContext(ctx,[b.companyId],query());
 expect(scope.employees).toHaveLength(124);
 const minimal=old.map(row=>Object.fromEntries(keys.map(key=>[key,row[key]])));
 // The legacy SQL orders by name alone; equal-name physical row order is not a contract.
 const identityOrder=(a:{employmentId:unknown},b:{employmentId:unknown})=>String(a.employmentId).localeCompare(String(b.employmentId));
 expect([...scope.employees].sort(identityOrder)).toEqual(minimal.sort((a,b)=>identityOrder({employmentId:a.employmentId},{employmentId:b.employmentId})));
 expect(scope.employees.every(row=>Object.keys(row).length===10)).toBe(true);
 expect(scope.employees.find(row=>row.employmentId===ids[0])?.departmentId).toBeNull();
 expect(scope.employees.find(row=>row.employmentId===ids[1])?.departmentId).toBe(b.deptA);
 expect(scope.employees.filter(row=>row.terminatedOn!==null)).toHaveLength(25);
 const other=await leaveInquiryContext(ctx,[foreignCompany],query());expect(other.companyIds).toEqual([]);expect(other.employees).toEqual([]);
 await expect(leaveInquiryContext(ctx,[b.companyId],query({emp:foreignId}))).rejects.toBeInstanceOf(InquiryQueryError);
});

it('denies committed revocation before protected reads and retains actor/input/returned-row immutability',async()=>{
 const input=query({type:b.annualLeaveTypeId}),companies=[b.companyId],scope=await leaveInquiryContext(ctx,companies,input);
 scope.companyIds.push(foreignCompany);scope.employees[0].employmentId=foreignId;companies.length=0;
 const original=await leaveInquiryBalancePairs(ctx,scope,input,'en',{limit:25,offset:0});expect(original.total).toBe(124);
 original.rows[0].employee.employmentId=foreignId;original.rows[0].employee.name='Caller mutation';
 const stable=await leaveInquiryBalancePairs(ctx,scope,input,'en',{limit:25,offset:0});expect(stable.rows.every(row=>row.employee.employmentId!==foreignId&&row.employee.name!=='Caller mutation')).toBe(true);
 await expect(leaveInquiryBalancePairs({...ctx},{...scope},input,'en')).rejects.toBeInstanceOf(InquiryQueryError);
 const removed=await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId)).returning();
 const debug=database.client.options.debug,reads:string[]=[];database.client.options.debug=(_connection:number,text:string)=>{reads.push(text);};
 try{
  await expect(leaveInquiryContext(ctx,[b.companyId],input)).rejects.toBeInstanceOf(InquiryQueryError);
  await expect(leaveInquiryBalancePairs(ctx,scope,input,'en')).rejects.toBeInstanceOf(InquiryQueryError);
  await expect(leaveInquiryRecordsPage(ctx,scope,input)).rejects.toBeInstanceOf(InquiryQueryError);
  expect(reads.filter(text=>/\bfrom\s+"(?:employment|person|company)"/i.test(text))).toEqual([]);
 }finally{database.client.options.debug=debug;await owner.db.insert(schema.roleAssignment).values(removed);}
 expect((await leaveInquiryContext(ctx,[b.companyId],input)).employees).toHaveLength(124);
});

it('lets an admitted coherent snapshot finish while the next snapshot denies the committed change',async()=>{
 const input=query({type:b.annualLeaveTypeId});let removed:(typeof schema.roleAssignment.$inferSelect)[]=[];
 try{
  await leaveInquirySnapshot(ctx,[b.companyId],input,async(tx,scope)=>{
   const before=await leaveInquiryBalancePairsTx(tx,ctx,scope,input,'en',{limit:25,offset:0});
   removed=await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId)).returning();
   const after=await leaveInquiryBalancePairsTx(tx,ctx,scope,input,'en',{limit:25,offset:0});expect(after).toEqual(before);
  });
  await expect(leaveInquiryContext(ctx,[b.companyId],input)).rejects.toBeInstanceOf(InquiryQueryError);
 }finally{if(removed.length)await owner.db.insert(schema.roleAssignment).values(removed);}
});

it('keeps context, eligibility and canonical hydration coherent across company and type changes',async()=>{
 const input=query({emp:ids[0],type:b.annualLeaveTypeId});
 const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional transferred employer'}).returning();
 let previous:Awaited<ReturnType<typeof leaveInquiryContext>>|undefined;
 await leaveInquirySnapshot(ctx,[b.companyId],input,async(tx,scope)=>{
  previous=scope;
  const before=await inquiryBalancePage(ctx,scope,input,'en',input.pq,tx);
  expect(before.total).toBe(1);expect(before.rows[0].employee.company).toBe('Acme Sdn Bhd');expect(before.rows[0].leaveType).toBe('Annual Leave');
  await owner.db.update(schema.employment).set({companyId:destination.id}).where(eq(schema.employment.id,ids[0]));
  await owner.db.update(schema.leaveType).set({name:'Changed after admission',eligibility:{gender:['male']}}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  expect(await inquiryBalancePage(ctx,scope,input,'en',input.pq,tx)).toEqual(before);
 });
 // A prior context is selection intent only. The standalone page re-admits it,
 // so a transferred selected subject refuses rather than mixing old/new facts.
 await expect(inquiryBalancePage(ctx,previous!,input,'en')).rejects.toBeInstanceOf(InquiryQueryError);
 const current=await leaveInquiryContext(ctx,[destination.id],input);
 expect((await inquiryBalancePage(ctx,current,input,'en')).rows).toEqual([]);
});

it('loads one type catalogue per physical read and preserves old six-locale Unicode/deep ordering exactly',async()=>{
 const input=query(),scope=await leaveInquiryContext(ctx,[b.companyId],input);
 const byId=new Map(scope.employees.map(employee=>[employee.employmentId,employee]));
 for(const locale of locales){
  const pairs=await database.withTenant(ctx,async tx=>{
   const result:Awaited<ReturnType<typeof leaveBalanceInquiryMembershipTx>>=[];
   for(let offset=0;offset<ids.length;offset+=100)result.push(...await leaveBalanceInquiryMembershipTx(tx,ctx,ids.slice(offset,offset+100),today,locale));
   return result.map(pair=>({...pair,employee:byId.get(pair.employmentId)!}));
  });
  expect(pairs.some(pair=>pair.leaveTypeId===hiddenType)).toBe(true);expect(pairs.filter(pair=>pair.leaveTypeId===archivedType)).toHaveLength(2);
  for(const sort of ['employeeCode','name','type'] as const)for(const dir of ['asc','desc'] as const){
   const expected=[...pairs],compare=(a:string,b:string)=>a.localeCompare(b,locale,{sensitivity:'base'}),direction=dir==='desc'?-1:1;
   expected.sort((a,b)=>{
    const primary=sort==='type'?compare(a.code||a.leaveType,b.code||b.leaveType):sort==='name'?compare(a.employee.name,b.employee.name):compare(a.employee.employeeCode??'',b.employee.employeeCode??'');
    return direction*primary||compare(a.employee.employeeCode??'',b.employee.employeeCode??'')||compare(a.employee.name,b.employee.name)||a.employee.employmentId.localeCompare(b.employee.employmentId)||compare(a.code||a.leaveType,b.code||b.leaveType)||a.leaveTypeId.localeCompare(b.leaveTypeId);
   });
   const debug=database.client.options.debug,statements:string[]=[];database.client.options.debug=(_connection:number,text:string)=>{statements.push(text);};
   try{
    const actual=await leaveInquiryBalancePairs(ctx,scope,query({sort,dir}),locale,{limit:25,offset:150});
    expect(actual.total).toBe(expected.length);expect(actual.rows).toEqual(expected.slice(150,175));
    expect(statements.filter(text=>/from "leave_type"(?:\s|$)/.test(text))).toHaveLength(1);
   }finally{database.client.options.debug=debug;}
  }
 }
},120000);

it('does not mutate canonical rule/ledger state or confer effect authority through the display context',async()=>{
 const input=query(),before=await owner.db.select().from(schema.leaveLedger),scope=await leaveInquiryContext(ctx,[b.companyId],input);
 await leaveInquiryBalancePairs(ctx,scope,input,'en');expect(await owner.db.select().from(schema.leaveLedger)).toEqual(before);
 await expect(leaveInquirySnapshot(ctx,[b.companyId],input,tx=>tx.update(schema.company).set({legalName:'Must never persist'}).where(eq(schema.company.id,b.companyId)))).rejects.toThrow();
 expect((await owner.db.select().from(schema.company).where(eq(schema.company.id,b.companyId)))[0].legalName).toBe('Acme Sdn Bhd');
});


it('re-admits standalone All and selected scopes after an actual company transfer',async()=>{
 const all=query({type:b.annualLeaveTypeId}),selected=query({type:b.annualLeaveTypeId,emp:ids[0]});
 const scope=await leaveInquiryContext(ctx,[b.companyId],all),single=await leaveInquiryContext(ctx,[b.companyId],selected);
 await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:ids[0],leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',status:'pending'});
 expect((await leaveInquiryRecordsPage(ctx,scope,all)).total).toBe(1);
 const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Transferred out of the selected company'}).returning();
 await owner.db.update(schema.employment).set({companyId:destination.id}).where(eq(schema.employment.id,ids[0]));
 // The group-wide HR principal still has native RLS access to B, but the original
 // inquiry selection intent is A. A fresh physical read must not reuse A metadata.
 const after=await leaveInquiryBalancePairs(ctx,scope,all,'en',{limit:200,offset:0});
 expect(after.total).toBe(123);expect(after.rows.every(row=>row.employee.employmentId!==ids[0]&&row.employee.companyId===b.companyId)).toBe(true);
 expect((await leaveInquiryRecordsPage(ctx,scope,all)).total).toBe(0);
 await expect(leaveInquiryBalancePairs(ctx,single,selected,'en')).rejects.toThrow('Employee is unavailable in the selected companies');
 await expect(leaveInquiryRecordsPage(ctx,single,selected)).rejects.toThrow('Employee is unavailable in the selected companies');
});

it('binds borrowed contexts to their original physical transaction and denies cross-snapshot reuse',async()=>{
 const input=query({emp:ids[0],type:b.annualLeaveTypeId}),finished=await leaveInquiryContext(ctx,[b.companyId],input);
 await database.withTenant(ctx,async tx=>{
  const debug=database.client.options.debug,reads:string[]=[];database.client.options.debug=(_connection:number,text:string)=>{reads.push(text);};
  try{
   await expect(leaveInquiryBalancePairsTx(tx,ctx,finished,input,'en')).rejects.toThrow('Forbidden');
   await expect(leaveInquiryRecordsPageTx(tx,ctx,finished,input)).rejects.toThrow('Forbidden');
   expect(reads.filter(text=>/\bfrom\s+"(?:employment|person|company|leave_request|leave_ledger|leave_type)"/i.test(text))).toEqual([]);
  }finally{database.client.options.debug=debug;}
 },{readOnlySnapshot:true});
 await leaveInquirySnapshot(ctx,[b.companyId],input,async(original,scope)=>{
  const before=await leaveInquiryBalancePairsTx(original,ctx,scope,input,'en');
  await leaveInquirySnapshot(ctx,[b.companyId],input,async(other,current)=>{
   await expect(leaveInquiryBalancePairsTx(other,ctx,scope,input,'en')).rejects.toThrow('Forbidden');
   await expect(leaveInquiryRecordsPageTx(other,ctx,scope,input)).rejects.toThrow('Forbidden');
   expect((await leaveInquiryBalancePairsTx(other,ctx,current,input,'en')).total).toBe(1);
  });
  expect(await leaveInquiryBalancePairsTx(original,ctx,scope,input,'en')).toEqual(before);
 });
});
