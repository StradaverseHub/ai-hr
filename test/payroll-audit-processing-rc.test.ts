/** A concurrent real writer can disprove batching the processing audit's existing RC reads. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {withPayrollTenant} from '../core/module-gate';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {saveClaimDraft} from '../core/claims';
import {runInputsTx} from '../core/payroll-audit/inputs';
import {lockPayComponentCatalogReadTx} from '../core/pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from '../core/payroll-period-lock';
import {lockPayrollOvertimeBatchContextTx} from '../core/payroll-overtime-pattern';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

it('observes an in-window real Claims draft commit between audit reads while native processing barriers remain held',async()=>{
 await resetDb();
 const b=await seedBase(),root=adminCtx(b);
 const worker=await hireEmployee(root,{person:{fullName:'Fictional payroll/claim audit subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:worker.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:worker.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});
 await generatePayslips(root,{batchId});
 const [type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:'AUDIT_RC',name:'Fictional audit RC type',requiresReceipt:false}).returning({id:schema.claimType.id});
 const actor:SessionContext={...root,userId:await createAppUser(b.tenantId,worker.personId,'employee'),personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const month={start:'2026-01-01',end:'2026-01-31'},windows={attendance:month,overtime:month,leave:month,claim:month};
 let pending:Promise<{id:string}>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const receipt=await withPayrollTenant(root,async tx=>{
   await lockPayComponentCatalogReadTx(tx,root);
   expect(await lockNativePayrollBatchPeriodTx(tx,root,batchId)).toMatchObject({companyId:b.companyId,payPeriod:'2026-01'});
   await lockPayrollOvertimeBatchContextTx(tx,root,batchId);
   const [batch]=await tx.execute(sql`select id from public.payroll_batch where id=${batchId}::uuid for update`);
   expect(batch.id).toBe(batchId);
   const [isolation]=await tx.execute(sql`select current_setting('transaction_isolation') as isolation,pg_backend_pid() as pid`);expect(isolation.isolation).toBe('read committed');
   const barriers=async()=>Array.from(await tx.execute(sql`select classid::text,objid::text,objsubid,mode from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted order by classid,objid,objsubid,mode`));
   const beforeLocks=await barriers();expect(beforeLocks.filter(l=>l.mode==='ExclusiveLock').length).toBeGreaterThanOrEqual(2);
   const args={batchId,payPeriod:'2026-01',windows};
   const before=await runInputsTx(tx,args);expect(before.employments).toBe(1);expect(before.components.claims.rows).toBe(0);
   pending=saveClaimDraft(actor,{employmentId:worker.employmentId,claimTypeId:type.id,amount:12.34,incurredOn:'2026-01-15',description:'Fictional concurrent audit witness'});
   const outcome=await Promise.race([pending,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);
   if(timer)clearTimeout(timer);
   expect(outcome,'ordinary Claims draft committed while processing held its locks').not.toBeNull();
   const after=await runInputsTx(tx,args);expect(after.components.claims.rows).toBe(1);expect(after.components.claims.hash).not.toBe(before.components.claims.hash);
   const {claims:oldClaim,...oldRest}=before.components;const {claims:newClaim,...newRest}=after.components;
   expect(newRest).toEqual(oldRest);expect(after.results).toEqual(before.results);
   expect(await barriers()).toEqual(beforeLocks);
   return {kind:'NATIVE_PROCESSING_READ_COMMITTED_CLAIM_INTERLEAVE',releaseEligible:false,mode:isolation.isolation,heldLocks:beforeLocks.map(l=>l.mode),claimBefore:oldClaim.rows,claimAfter:newClaim.rows,claimDigestChanged:true,otherDigestsUnchanged:true};
  });
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-audit-processing-rc.json'),JSON.stringify(receipt,null,2));
 }finally{if(timer)clearTimeout(timer);await pending?.catch(()=>undefined);}
},60000);
