/** Hosted baseline observation; no application source changes in this checkpoint. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {employment,person} from '../db/schema';
import {labelMaintenanceHeadOptions} from '../core/system-labels';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('observes the real native head lookup refusing an otherwise empty-label tenant with5001employees',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const ids=Array.from({length:5001},()=>({employmentId:randomUUID(),personId:randomUUID()}));
 for(let start=0;start<ids.length;start+=500){
  const batch=ids.slice(start,start+500);
  await owner.db.insert(person).values(batch.map((row,index)=>({id:row.personId,tenantId:b.tenantId,fullName:'Fictional head employee '+String(start+index).padStart(5,'0'),primaryEmail:row.personId+'@example.invalid'})));
  await owner.db.insert(employment).values(batch.map((row,index)=>({id:row.employmentId,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,hiredOn:'2020-01-01',employeeCode:'HEAD'+String(start+index).padStart(5,'0')})));
 }
 const native=database.withTenant,identities:unknown[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(session,async tx=>{
  const [identity]=await tx.execute<{role:string;tenant:string;user:string;employmentRls:boolean;personRls:boolean}>(sql`select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as "user",row_security_active('employment'::regclass) as "employmentRls",row_security_active('person'::regclass) as "personRls"`);
  expect(identity).toEqual({role:'ai_hr_app',tenant:b.tenantId,user:b.adminUserId,employmentRls:true,personRls:true});identities.push(identity);
  return read(tx);
 },options));
 const started=performance.now();let refusal:unknown;
 try{await labelMaintenanceHeadOptions(ctx);}catch(error){refusal=error;}finally{spy.mockRestore();}
 expect(refusal).toBeInstanceOf(Error);
 expect((refusal as Error).message).toContain('exceeds the supported maintenance size');
 expect(identities).toHaveLength(1);
 const [actual]=await owner.client`select count(*)::int as employees from employment where tenant_id=${b.tenantId}::uuid`;
 expect(actual.employees).toBe(5001);
 const report={kind:'SYSTEM_LABEL_HEAD_LOOKUP_BASELINE',releaseEligible:false,employees:5001,nativeIdentities:identities,observedRefusal:(refusal as Error).message,elapsedMs:performance.now()-started,
  limitation:'Observed direct service refusal. The page source unconditionally calls this reader, but this probe does not constitute a rendered browser claim.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'system-label-head-baseline.json'),JSON.stringify(report,null,2));
},120000);
