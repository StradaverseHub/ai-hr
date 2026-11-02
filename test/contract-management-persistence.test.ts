import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import * as S from '../db/schema';
import {canConfigureContractWorkflows,setupContractManagement,contractWorkflowWorkspace,assignContractRole,captureContractRetirementEvidence} from '../packs/contracts/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);});
describe('isolated Contract Staff native custody',()=>{
 it('creates five isolated draft workflows with runtime off and admits no legacy role label alone',async()=>{
  await setupContractManagement(admin,b.companyId,randomUUID());
  const workspace=await contractWorkflowWorkspace(admin);expect(workspace.workflows).toHaveLength(5);expect(workspace.workflows.every(w=>w.draft.module==='contract_staff'&&w.publishedVersion===null)).toBe(true);
  const [runtime]=await withTenant(admin,tx=>tx.execute<{enabled:boolean}>(sql`select app.contract_runtime(${b.companyId}::uuid) as enabled`));expect(runtime.enabled).toBe(false);
  const [p]=await owner.db.insert(S.person).values({tenantId:b.tenantId,fullName:'Fictional bounded contract reviewer',primaryEmail:randomUUID()+'@contract.test'}).returning();const userId=await createAppUser(b.tenantId,p.id,'employee');
  const actor={...admin,userId,personId:p.id,roles:['hr_admin'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  expect(await canConfigureContractWorkflows(actor)).toBe(false);
  await expect(assignContractRole(actor,{companyId:b.companyId,businessUnitId:null,userId,role:'gbs',from:'2026-01-01',to:null,reason:'Forged role claim must be refused'})).rejects.toThrow();
 });
 it('refuses direct app writes and forged retirement proof events',async()=>{
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into contract_configuration(tenant_id,company_id,data,updated_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,'{}',${admin.userId}::uuid)`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'retirement',${randomUUID()}::uuid,'retirement.contract-approved','user',${admin.userId}::uuid,'{}')`))).rejects.toMatchObject({cause:{code:'42501'}});
 });
 it('requires scoped PBP custody with real retirement and separate employee-file references',async()=>{
  await expect(captureContractRetirementEvidence(admin,{employmentId:randomUUID(),retirementCaseId:randomUUID(),approvalDocumentId:randomUUID(),healthDocumentId:randomUUID(),sourceRevision:'a'.repeat(64),reason:'Actual records are required, no client boolean bypass.'})).rejects.toThrow();
 });
});
