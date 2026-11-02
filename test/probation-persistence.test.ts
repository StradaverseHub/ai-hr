import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {bootstrapProbationPreparer,installProbationDrafts,probationSetup,saveProbationConfiguration,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,canConfigureProbationWorkflows,sweepProbation} from '../packs/probation/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);});
describe('native probation configuration custody and default-off authority',()=>{
 it('starts hidden and disabled and only bounded bootstrap creates named configuration authority',async()=>{
  expect(await canConfigureProbationWorkflows(admin)).toBe(false);
  await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named staging preparer'});
  expect(await canConfigureProbationWorkflows(admin)).toBe(true);
  await expect(bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Second bootstrap'})).rejects.toThrow();
  await installProbationDrafts(admin,b.companyId);await installProbationDrafts(admin,b.companyId);
  const setup=await probationSetup(admin,b.companyId);expect(setup.enabled).toBe(false);expect(setup.settings).toBeNull();expect(setup.drafts.form?.data).toMatchObject({name:DEFAULT_PROBATION_FORM.name});expect(setup.latestVersion).toEqual({settings:1,form:1,route:1});
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:false,expectedVersion:0})).rejects.toThrow();
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:true,expectedVersion:1});expect((await probationSetup(admin,b.companyId)).settings?.version).toBe(2);
 });
 it('rejects direct table writes, unapproved Grade H and an unrunnable evaluation route',async()=>{
  await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named configuration preparer'});
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into probation_activation(tenant_id,company_id,enabled) values(${b.tenantId}::uuid,${b.companyId}::uuid,true)`))).rejects.toThrow();
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:{...DEFAULT_PROBATION_CONFIG,gradeHEnabled:true,gradeHFormPublished:true},publish:true,expectedVersion:0})).rejects.toThrow();
  const route=defaultProbationRoutes();route.parts['1'].steps.find(s=>s.role==='employee')!.stage=0;
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'route',data:route,publish:true,expectedVersion:0})).rejects.toThrow();
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'route',data:defaultProbationRoutes(),publish:true,expectedVersion:0});
 });
 it('does not grant app callers owner scheduling or private content/source helper authority',async()=>{
  await expect(sweepProbation({...admin,userId:undefined},{withTenant},new Date())).rejects.toThrow();
  for(const query of [sql`select app.probation_content(${randomUUID()}::uuid)`,sql`select app.probation_notification_content(${b.tenantId}::uuid,${randomUUID()}::uuid,${admin.userId}::uuid)`,sql`select app.probation_activate_cutover(${randomUUID()}::uuid,current_date)`])await expect(withTenant(admin,tx=>tx.execute(query))).rejects.toThrow();
  const functions=await owner.db.execute<{name:string;public:boolean}>(sql`select p.proname as name,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') as public from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'probation_%' and p.prosecdef`);expect(functions.length).toBeGreaterThan(20);expect(functions.filter(f=>f.public)).toEqual([]);
 });
});
