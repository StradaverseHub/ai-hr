/** Test-only proposal against the exact published owner reader. No app/native implementation changes. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,endReportingLine,setReportingLine} from '../core/org';
import {createClaimType,pendingClaimTaskMetadata} from '../packs/claims/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {claimTaskStatementProbe,claimTaskBoundedHeaderProbe,claimTaskGroupedHeaderProbe} from './helpers/claim-task-statement-probe';

let b:Base,ctx:SessionContext,typeId:string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'claims','active');ctx=adminCtx(b);
 typeId=(await createClaimType(ctx,{code:'STMT_PROBE',name:'Fictional statement proposal',requiresReceipt:false,defaultTaxable:false})).id;});
async function person(name:string,manager?:string,departmentId=b.deptA){return hireEmployee(ctx,{person:{fullName:'Fictional '+name,primaryEmail:randomUUID()+'@example.invalid'},
 companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur(new Date(Date.now()-7*86400000)),reportingManagerEmploymentId:manager});}
async function claims(employmentId:string,count:number){const start=Date.now()-120000;return owner.db.insert(s.claimRequest).values(Array.from({length:count},(_,i)=>({
 tenantId:b.tenantId,employmentId,claimTypeId:typeId,amount:'1.00',status:'pending' as const,incurredOn:todayInKualaLumpur(),createdAt:new Date(start+i*1000),
}))).returning({id:s.claimRequest.id,createdAt:s.claimRequest.createdAt});}
async function compare(actor:SessionContext,companyIds?:string[]){
 const expected=await pendingClaimTaskMetadata(actor,companyIds);const actual=await claimTaskStatementProbe(actor,companyIds);
 expect(actual.items).toEqual(expected);expect(actual.total).toBe(expected.length);
 const bounded=await claimTaskBoundedHeaderProbe(actor,companyIds);expect(bounded).toEqual(actual);
 expect(await claimTaskGroupedHeaderProbe(actor,companyIds)).toEqual(actual);return actual;
}

it('keeps typed Claims delegation and department coverage as the current edge ends',async()=>{
 const manager=await person('cover delegator'),standIn=await person('cover delegate');
 await person('stand-in direct report',standIn.employmentId);
 const included=await person('covered claimant',manager.employmentId),excluded=await person('out-of-scope claimant',manager.employmentId,b.deptB);
 const userId=await createAppUser(b.tenantId,standIn.personId,'manager');
 const actor:SessionContext={...ctx,userId,personId:standIn.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};
 const kept=await claims(included.employmentId,4);await claims(excluded.employmentId,2);
 const {reportingLineId}=await setReportingLine(ctx,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:standIn.employmentId,lineType:'delegate',
  validFrom:todayInKualaLumpur(new Date(Date.now()-86400000)),validTo:todayInKualaLumpur(new Date(Date.now()+86400000)),
  scopes:[{module:'claims',taskType:'claims.claim'}],orgScope:{companyId:b.companyId,businessUnitId:null,departmentId:b.deptA}});
 expect(new Set((await compare(actor,[b.companyId])).items.map(row=>row.id))).toEqual(new Set(kept.map(row=>row.id)));
 await endReportingLine(ctx,{reportingLineId,endDate:todayInKualaLumpur()});
 expect((await compare(actor,[b.companyId])).total).toBe(0);
});
