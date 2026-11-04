import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {createCompany} from '../core/admin';
import {processRequestedProbationActivations} from '../core/probation-cutover';
import {probationAdministrationOptions,probationNavigationAccess,probationSetup,installProbationDrafts,saveProbationConfiguration,DEFAULT_PROBATION_CONFIG,requestProbationActivation,bootstrapProbationPreparer} from '../packs/probation/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});
async function member(){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional module holder',${randomUUID()+'@module.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return{...admin,userId,personId:p.id,roles:['employee'],grants:undefined};
}
async function grant(userId:string,effect:'allow'|'deny'='allow'){
 await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${b.tenantId}::uuid,${userId}::uuid,'probation.module',${effect})`);
}
describe('Probation setup is owned by the module capability',()=>{
 it('gives System Administrators setup without any preparer nomination and leaves runtime off',async()=>{
  const [legacy]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_access where tenant_id=${b.tenantId}::uuid and role='admin'`);expect(legacy.n).toBe(0);
  expect(await probationNavigationAccess(admin)).toMatchObject({configure:true});
  await installProbationDrafts(admin,b.companyId);expect(await probationSetup(admin,b.companyId)).toMatchObject({canConfigure:true,enabled:false});
  await expect(bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Obsolete nomination'})).rejects.toThrow();
 });
 it('allows a granted module user to configure every entitled company without HR scope',async()=>{
  const other=await createCompany(admin,{legalName:'Second fictional employer',country:'MY',currency:'MYR'}),ctx=await member();await grant(ctx.userId!);
  expect((await probationAdministrationOptions(ctx)).companies.map(c=>c.id)).toEqual(expect.arrayContaining([b.companyId,other.id]));
  for(const companyId of [b.companyId,other.id]){
   await installProbationDrafts(ctx,companyId);const setup=await probationSetup(ctx,companyId);
   await saveProbationConfiguration(ctx,{companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:false,expectedVersion:setup.latestVersion.settings});
  }
 });
 it('does not infer setup permission from employee participation or stale role text',async()=>{
  const ctx=await member();expect(await probationNavigationAccess({...ctx,roles:['super_admin']})).toMatchObject({configure:false});
  await expect(probationAdministrationOptions(ctx)).rejects.toThrow();await expect(installProbationDrafts(ctx,b.companyId)).rejects.toThrow();
  await expect(requestProbationActivation(ctx,{id:randomUUID(),digest:'a'.repeat(64),installationReference:'Fictional confirmation'})).rejects.toThrow();
 });
 it('honors revocation immediately and never crosses tenants',async()=>{
  const ctx=await member();await grant(ctx.userId!);await installProbationDrafts(ctx,b.companyId);
  const foreign=await seedBase();const[proof]=await withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${foreign.companyId}::uuid) as ok`));expect(proof.ok).toBe(false);
  await owner.db.execute(sql`update access_user_override set effect='deny' where tenant_id=${b.tenantId}::uuid and user_id=${ctx.userId}::uuid and capability_id='probation.module'`);
  expect(await probationNavigationAccess(ctx)).toMatchObject({configure:false});await expect(installProbationDrafts(ctx,b.companyId)).rejects.toThrow();
 });
 it('refuses activation without an exact approved current rehearsal and exposes no owner helper',async()=>{
  await expect(requestProbationActivation(admin,{id:randomUUID(),digest:'b'.repeat(64),installationReference:'Fictional confirmation'})).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_activate_cutover(${randomUUID()}::uuid,current_date)`))).rejects.toThrow();
  const[rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_activation_request where tenant_id=${b.tenantId}::uuid`);expect(rows.n).toBe(0);
 });
 it('fails a withdrawn requester once, audits the failure and leaves runtime and imports untouched',async()=>{
  const ctx=await member(),id=randomUUID(),cutoverId=randomUUID();
  await owner.db.execute(sql`insert into probation_cutover(id,tenant_id,company_id,data,digest,actor_user_id) values(${cutoverId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'{}'::jsonb,${'c'.repeat(64)},${admin.userId}::uuid)`);
  await owner.db.execute(sql`insert into probation_activation_request(id,tenant_id,company_id,cutover_id,requested_by,digest,installation_reference) values(${id}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${cutoverId}::uuid,${ctx.userId}::uuid,${'c'.repeat(64)},'Fictional installation verification')`);
  const maintenance={...admin,userId:undefined,roles:[],grants:undefined};
  expect(await processRequestedProbationActivations(maintenance,owner)).toEqual({processed:0,failed:1});
  expect(await processRequestedProbationActivations(maintenance,owner)).toEqual({processed:0,failed:0});
  const[state]=await owner.db.execute<{state:string}>(sql`select state from probation_activation_request where id=${id}::uuid`);expect(state.state).toBe('failed');
  const[effects]=await owner.db.execute<{activations:number;cases:number;events:number}>(sql`select (select count(*) from probation_activation where tenant_id=${b.tenantId}::uuid)::int as activations,(select count(*) from probation_case where tenant_id=${b.tenantId}::uuid)::int as cases,(select count(*) from domain_event where tenant_id=${b.tenantId}::uuid and event_type='probation.runtime.activation-failed')::int as events`);
  expect(effects).toEqual({activations:0,cases:0,events:1});
 });
});
