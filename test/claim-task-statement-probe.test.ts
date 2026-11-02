/** Test-only proposal against the exact published owner reader. No app/native implementation changes. */
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,endReportingLine} from '../core/org';
import {createClaimType,pendingClaimTaskMetadata} from '../packs/claims/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {claimTaskStatementProbe} from './helpers/claim-task-statement-probe';

let b:Base,ctx:SessionContext,typeId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'claims','active');ctx=adminCtx(b);
 typeId=(await createClaimType(ctx,{code:'STMT_PROBE',name:'Fictional statement proposal',requiresReceipt:false,defaultTaxable:false})).id;});
async function person(name:string,manager?:string){return hireEmployee(ctx,{person:{fullName:'Fictional '+name,primaryEmail:randomUUID()+'@example.invalid'},
 companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(new Date(Date.now()-7*86400000)),reportingManagerEmploymentId:manager});}
async function claims(employmentId:string,count:number){const start=Date.now()-120000;return owner.db.insert(s.claimRequest).values(Array.from({length:count},(_,i)=>({
 tenantId:b.tenantId,employmentId,claimTypeId:typeId,amount:'1.00',status:'pending' as const,incurredOn:todayInKualaLumpur(),createdAt:new Date(start+i*1000),
}))).returning({id:s.claimRequest.id,createdAt:s.claimRequest.createdAt});}
async function counted<T>(run:()=>Promise<T>){const previous=client.options.debug;let statements=0;
 client.options.debug=(connection,query,parameters,types)=>{statements++;if(typeof previous==='function')previous(connection,query,parameters,types);};
 try{return {value:await run(),statements};}finally{client.options.debug=previous;}}
async function compare(actor:SessionContext,companyIds?:string[]){
 const expected=await pendingClaimTaskMetadata(actor,companyIds);const actual=await claimTaskStatementProbe(actor,companyIds);
 expect(actual.items).toEqual(expected);expect(actual.total).toBe(expected.length);return actual;
}
async function events(){const [row]=await owner.client`select count(*)::int as total from domain_event`;return row.total;}
function state(error:unknown){for(let e=error;e&&typeof e==='object';e=(e as {cause?:unknown}).cause){const code=(e as {code?:string}).code;if(code)return code;}return null;}

it('matches every ordered header and exact bounded preview while client statement count stays constant',async()=>{
 const subject=await person('repeated subject');await claims(subject.employmentId,1);
 const [role]=await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)) as unknown as {role:string}[];expect(role.role).toBe('ai_hr_app');
 const small=await counted(()=>claimTaskStatementProbe(ctx,[b.companyId]));expect(small.value.total).toBe(1);expect(small.statements).toBeGreaterThan(0);
 await claims(subject.employmentId,39);const before=await events();
 const expected=await pendingClaimTaskMetadata(ctx,[b.companyId]);expect(expected).toHaveLength(40);
 const large=await counted(()=>claimTaskStatementProbe(ctx,[b.companyId]));expect(large.value.items).toEqual(expected);expect(large.value.total).toBe(40);
 expect(large.statements).toBeLessThanOrEqual(small.statements+2);
 const preview=await claimTaskStatementProbe(ctx,[b.companyId],5);expect(preview.items).toEqual(expected.slice(0,5));expect(preview.total).toBe(40);
 expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(Buffer.byteLength(JSON.stringify(large.value)));
 expect(await claimTaskStatementProbe(ctx,[])).toEqual({items:[],total:0});
 const pairs=[];
 for(let i=0;i<4;i++){const results:Record<string,number>={};
  for(const kind of i%2?['prototype','canonical']:['canonical','prototype']){const start=performance.now();
   if(kind==='canonical')expect(await pendingClaimTaskMetadata(ctx,[b.companyId])).toEqual(expected);
   else expect((await claimTaskStatementProbe(ctx,[b.companyId])).items).toEqual(expected);
   results[kind]=performance.now()-start;
  }pairs.push(results);
 }
 expect(await events()).toBe(before);
 console.log('CLAIM_TASK_STATEMENT_PROBE '+JSON.stringify({scope:'private component, not production reader or500-user acceptance',
  rows:40,actorRole:role.role,exactOrderedHeaders:true,exactPreviewTotal:true,smallStatements:small.statements,largeStatements:large.statements,pairs,auditUnchanged:true}));
});

it('matches a real assigned manager without a platform manager role and refreshes after the line ends',async()=>{
 const manager=await person('assigned manager'),subject=await person('manager subject',manager.employmentId);
 const userId=await createAppUser(b.tenantId,manager.personId,'employee');
 const actor:SessionContext={...ctx,userId,personId:manager.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await claims(subject.employmentId,8);await claims(manager.employmentId,2);
 expect((await compare(actor)).items).toHaveLength(8);
 // Exercise the real dated relationship owner; later statements cannot reuse the previous decision.
 const [line]=await owner.db.select({id:s.reportingLine.id}).from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,subject.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.supersededAt),isNull(s.reportingLine.validTo)));
 expect(line).toBeDefined();await endReportingLine(ctx,{reportingLineId:line.id,endDate:todayInKualaLumpur()});
 expect((await compare(actor)).items).toHaveLength(0);
});

it('fails closed for revoked or forged caller facts and recovers after a SQL error without audit writes',async()=>{
 const subject=await person('error recovery subject');await claims(subject.employmentId,3);expect((await compare(ctx)).total).toBe(3);
 const before=await events(),forged={...ctx,personId:randomUUID()};
 await expect(pendingClaimTaskMetadata(forged,[b.companyId])).rejects.toThrow();
 await expect(claimTaskStatementProbe(forged,[b.companyId])).rejects.toThrow();
 let canonicalError:unknown,prototypeError:unknown;
 try{await pendingClaimTaskMetadata(ctx,['not-a-uuid']);}catch(error){canonicalError=error;}
 try{await claimTaskStatementProbe(ctx,['not-a-uuid']);}catch(error){prototypeError=error;}
 expect(state(canonicalError)).toBe('22P02');expect(state(prototypeError)).toBe('22P02');
 expect((await compare(ctx)).total).toBe(3);expect(await events()).toBe(before);
 const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
 await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
 try{await expect(pendingClaimTaskMetadata(ctx,[b.companyId])).rejects.toThrow();await expect(claimTaskStatementProbe(ctx,[b.companyId])).rejects.toThrow();}
 finally{await owner.db.insert(s.roleAssignment).values(grants);}
 expect((await compare(ctx)).total).toBe(3);
});

it('keeps same-tenant company filters and foreign-tenant rows identical to the published reader',async()=>{
 const local=await person('company-filter subject');const localRows=await claims(local.employmentId,3);
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second company',country:'MY'}).returning();
 const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional second department'}).returning();
 const other=await hireEmployee(ctx,{person:{fullName:'Fictional other-company subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const otherRows=await claims(other.employmentId,2);
 const foreign=await seedBase();await setModule(foreign.tenantId,'claims','active');const foreignCtx=adminCtx(foreign);
 const foreignType=await createClaimType(foreignCtx,{code:'FOREIGN_PROBE',name:'Fictional foreign claims',requiresReceipt:false,defaultTaxable:false});
 const foreignPerson=await hireEmployee(foreignCtx,{person:{fullName:'Fictional foreign-tenant subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 await owner.db.insert(s.claimRequest).values({tenantId:foreign.tenantId,employmentId:foreignPerson.employmentId,claimTypeId:foreignType.id,amount:'1.00',incurredOn:todayInKualaLumpur(),status:'pending'});
 expect(new Set((await compare(ctx,undefined)).items.map(row=>row.id))).toEqual(new Set([...localRows,...otherRows].map(row=>row.id)));
 expect(new Set((await compare(ctx,[b.companyId])).items.map(row=>row.id))).toEqual(new Set(localRows.map(row=>row.id)));
 expect(new Set((await compare(ctx,[company.id])).items.map(row=>row.id))).toEqual(new Set(otherRows.map(row=>row.id)));
 expect((await compare(ctx,[foreign.companyId])).total).toBe(0);
});
