/** Native presentation/command separation; no returned authority or money is mocked. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {businessUnit,employment,jobGrade,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import {setupReadTenant,setupTenant} from '../packs/rewards/setup-data';
import {confirmRewardLibrary,rewardLibraries,rewardLibraryGradeChoices,rewardLibraryHistory,rewardPlanLibraryChoices,saveRewardLibrary,submitRewardLibrary} from '../packs/rewards/libraries';
import {previewNewRewardPlan,previewRewardPlanCreation,previewRewardPlanSplit,previewRewardUncoveredPlans,rewardPlanSettings,rewardPlanSuggestions,rewardSetupPlan,rewardSetupPlanChoices,saveRewardPlanSettings} from '../packs/rewards/plan-configuration';
import {rewardPatInputs,rewardPlanCompanyChoices} from '../packs/rewards/pat-inputs';
import {rewardPlanCompanyChoicesQueryTx,rewardPlanLibraryChoicesQueryTx} from '../packs/rewards/setup-query-owner';
import {legacyRewardSetupQueryPort} from '../packs/rewards/setup-legacy-query-port';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {createApprovedRewardUnit,setupChecker} from './rewards-setup-fixture';
import {observeNativeRead} from './helpers/native-read-observer';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
async function fixture(){
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');const ctx=adminCtx(b),today=todayInKualaLumpur(),year=Number(today.slice(0,4)),on=year+'-01-01';
 const [bu]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'SNAPSHOT',name:'Fictional snapshot Business unit'}).returning();
 const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional snapshot grade',rank:12}).returning();
 const employee=await hireEmployee(ctx,{person:{fullName:'Fictional setup snapshot employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,gradeId:grade.id,employeeCode:'SNAPSHOT-001',employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.update(employment).set({confirmationDate:'2020-04-01'}).where(eq(employment.id,employee.employmentId));
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
 const unitId=await createApprovedRewardUnit(ctx,{name:'Fictional snapshot annual review',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:on});
 const [binding]=await owner.client<{plan_version_id:string;salary_version_id:string;bonus_version_id:string}[]>`select plan_version_id,salary_version_id,bonus_version_id from reward_unit_setup where unit_id=${unitId}::uuid`;
 return{b,ctx,today,year,on,bu,grade,employee,unitId,binding};
}
function budgets(){
 const native=database.withTenant;
 return vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);return read(tx);
 },options));
}
async function held(tenantId:string,kind:'access'|'history',signal:AbortSignal,read:(writerPid:number)=>Promise<void>){
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});let writerPid=0;
 const writer=owner.client.begin(async tx=>{
  await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;
  if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`;
  else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+tenantId}))`;
  const [row]=await tx`select pg_backend_pid() as pid`;writerPid=row.pid;entered();await done;
 });
 const abort=()=>release();signal.addEventListener('abort',abort,{once:true});
 try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before taking the barrier');})]);signal.throwIfAborted();await read(writerPid);}
 finally{release();signal.removeEventListener('abort',abort);await writer;}
}
async function events(tenantId:string){return [...await owner.client`select id,event_type,payload,chain_seq,hash from domain_event where tenant_id=${tenantId}::uuid order by id`];}

it('reads real plan IDs, money, library history and previews while Access and History writers remain held',async context=>{
 const f=await fixture(),spy=budgets(),before=await events(f.b.tenantId);
 const read=async()=>{
  expect((await rewardSetupPlanChoices(f.ctx)).map(p=>p.source.versionId)).toEqual([f.binding.plan_version_id]);
  const plan=await rewardSetupPlan(f.ctx,f.binding.plan_version_id);expect(plan.setup).toMatchObject({state:'approved',companyIds:[f.b.companyId],bindings:[{companyId:f.b.companyId,businessUnitId:f.bu.id,salaryVersionId:f.binding.salary_version_id,bonusVersionId:f.binding.bonus_version_id}]});
  const settings=await rewardPlanSettings(f.ctx,f.binding.plan_version_id);expect(settings.policy.ranges['12']).toEqual([300000,500000,700000]);expect(settings.policy.bonusMatrix['12']).toEqual([0,5000,15000,22500,30000]);
  const grades=await rewardLibraryGradeChoices(f.ctx);expect(grades).toContainEqual({gradeId:f.grade.id,grade:'12',name:f.grade.name});
  const history=await rewardLibraryHistory(f.ctx,f.binding.salary_version_id);expect(history.map(r=>r.afterState)).toEqual(['confirmed','pending','draft']);expect(history[0].after).toMatchObject({kind:'salary',rows:expect.arrayContaining([{gradeId:f.grade.id,grade:'12',minimumCents:300000,midpointCents:500000,maximumCents:700000}])});
  const suggestions=await rewardPlanSuggestions(f.ctx,f.year,[f.b.companyId],f.on);expect(suggestions).toHaveLength(1);expect(suggestions[0].company.id).toBe(f.b.companyId);
  const creation=await previewRewardPlanCreation(f.ctx,f.binding.plan_version_id);expect(creation.rows).toHaveLength(1);expect(creation.rows[0]).toMatchObject({companyId:f.b.companyId,status:'skip',existingUnitId:f.unitId});
  const uncovered=await previewRewardUncoveredPlans(f.ctx,f.year);expect(uncovered.rows).toEqual([]);
  const nextYear=await previewRewardUncoveredPlans(f.ctx,f.year+1);expect(nextYear.rows.map(r=>r.company.id)).toEqual([f.b.companyId]);
  const preview=await previewNewRewardPlan(f.ctx,{year:f.year,name:'Fictional preview only',snapshotDate:f.on,companyIds:[f.b.companyId],salaryVersionId:f.binding.salary_version_id,bonusVersionId:f.binding.bonus_version_id,branchAcknowledged:false});expect(preview.rows).toHaveLength(1);expect(preview.rows[0]).toMatchObject({companyId:f.b.companyId,status:'skip',reason:'already-assigned'});
 };
 try{await read();for(const kind of ['access','history']as const)await held(f.b.tenantId,kind,context.signal,async pid=>{
  await read();const [proof]=await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted) as held`;expect(proof.held).toBe(true);
  // The former carrier really waits; audited views still use it intentionally.
  if(kind==='access')await expect(setupTenant(f.ctx,async()=>true)).rejects.toMatchObject({cause:{code:'55P03'}});
 });expect(await events(f.b.tenantId)).toEqual(before);}
 finally{spy.mockRestore();}
},30000);

it('enforces native RR/RO and retains command/audited-view barriers and durable history',async context=>{
 const f=await fixture(),spy=budgets();
 try{
  const settings=await rewardPlanSettings(f.ctx,f.binding.plan_version_id),command={versionId:f.binding.plan_version_id,sourceRevision:settings.source.revision,setupRevision:settings.setup.revision,name:settings.source.name,policy:settings.policy,successor:true,reason:'Fictional checked snapshot successor'};
  const draft=await saveRewardPlanSettings(f.ctx,command);
  const split=await previewRewardPlanSplit(f.ctx,draft);expect(split.groups).toHaveLength(1);expect(split.plan.bindings.map(b=>b.companyId)).toEqual([f.b.companyId]);
  const mode=await setupReadTenant(f.ctx,async tx=>{const [row]=await tx.execute<{isolation:string;readonly:string;user:string;tenant:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,app.current_user_id() as "user",app.current_tenant_id() as tenant`);return row;});
  expect(mode).toEqual({isolation:'repeatable read',readonly:'on',user:f.ctx.userId,tenant:f.b.tenantId});
  await expect(setupReadTenant(f.ctx,tx=>tx.execute(sql`update reward_library_version set reason='A presentation must never mutate' where id=${f.binding.salary_version_id}::uuid`))).rejects.toMatchObject({cause:{code:'25006'}});
  await held(f.b.tenantId,'access',context.signal,async()=>{expect(await previewRewardPlanSplit(f.ctx,draft)).toEqual(split);await expect(saveRewardPlanSettings(f.ctx,command)).rejects.toMatchObject({cause:{code:'55P03'}});await expect(rewardLibraries(f.ctx,'salary',f.year)).rejects.toMatchObject({cause:{code:'55P03'}});});
  await held(f.b.tenantId,'history',context.signal,async()=>{await expect(rewardPatInputs(f.ctx,f.year)).rejects.toMatchObject({cause:{code:'55P03'}});});
  const before=await events(f.b.tenantId);expect(await rewardLibraries(f.ctx,'salary',f.year)).toHaveLength(1);expect(await rewardPatInputs(f.ctx,f.year)).toHaveLength(1);
  const after=await events(f.b.tenantId);expect(after).toHaveLength(before.length+2);expect(after.filter(row=>!before.some(old=>old.id===row.id)).map(row=>row.event_type).sort()).toEqual(['rewards-setup.libraries.viewed','rewards-setup.pat.viewed']);
 }finally{spy.mockRestore();}
},30000);

it('rechecks native setup grants and actual login grants with retained contexts and denies foreign IDs',async()=>{
 const f=await fixture(),foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');
 await expect(rewardSetupPlan(adminCtx(foreign),f.binding.plan_version_id)).rejects.toThrow();
 const userId=f.ctx.userId;if(typeof userId!=='string'||!userId)throw Error('A concrete native fixture administrator is required');
 expect(userId).toBe(f.b.adminUserId);
 const [grant]=await owner.client<{id:string}[]>`select id from reward_setup_grant where tenant_id=${f.b.tenantId}::uuid and user_id=${userId}::uuid and active`;
 await owner.client`update reward_setup_grant set active=false where id=${grant.id}::uuid`;
 await expect(rewardLibraryGradeChoices(f.ctx)).rejects.toThrow(/not available/);await expect(rewardSetupPlanChoices(f.ctx)).rejects.toThrow(/not available/);
 await owner.client`update reward_setup_grant set active=true where id=${grant.id}::uuid`;
 expect((await rewardSetupPlanChoices(f.ctx)).map(p=>p.source.versionId)).toEqual([f.binding.plan_version_id]);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.ctx.userId!));
 await expect(rewardSetupPlanChoices(f.ctx)).rejects.toThrow(/not available/);
},30000);


it('keeps Plans dropdown labels and durable audit events while withholding matrices and PAT values',async context=>{
 const f=await fixture(),checker=await setupChecker(f.ctx);
 const [legacyBonus]=await rewardLibraries(f.ctx,'bonus',f.year);
 if(legacyBonus?.data.kind!=='bonus')throw Error('Fictional bonus fixture is missing');
 const input={libraryId:null,versionId:null,expectedLock:0,name:'A fictional branch matrix',year:f.year,tags:[],groupDefault:false,previousLibraryId:null,
  data:{...legacyBonus.data,type:'branch',segments:[{name:'Fictional branch',factors:[0,10000,10000,10000,10000]}]},reason:'Fictional selector branch fixture'};
 const branchId=await saveRewardLibrary(f.ctx,input);
 await submitRewardLibrary(f.ctx,branchId,1);await confirmRewardLibrary(checker,branchId);
 const draftId=await saveRewardLibrary(f.ctx,{...input,name:'Unconfirmed fictional matrix'});
 const libraries=await rewardLibraries(f.ctx,undefined,f.year),pats=await rewardPatInputs(f.ctx,f.year);
 expect(pats[0]?.current?.inputs).toBeDefined();
 const expected={
  libraries:libraries.filter(row=>row.state==='confirmed').map(({id,libraryId,kind,name,version,data})=>({id,libraryId,kind,name,version,bonusType:data.kind==='bonus'?data.type:null})),
  companies:pats.map(({company:{id,name}})=>({id,name})),
 };
 expect(expected.libraries).toEqual(expect.arrayContaining([expect.objectContaining({id:branchId,bonusType:'branch'})]));
 expect(expected.libraries.some(row=>row.id===draftId)).toBe(false);
 const snapshot=()=>setupReadTenant(f.ctx,async tx=>({
  libraries:await rewardPlanLibraryChoicesQueryTx(tx,f.ctx,f.year,legacyRewardSetupQueryPort),
  companies:await rewardPlanCompanyChoicesQueryTx(tx,f.ctx,f.year,legacyRewardSetupQueryPort),
 }));
 const before=await events(f.b.tenantId),probe=observeNativeRead();
 try{
  expect(await snapshot()).toEqual(expected);
  expect(probe.properties).toEqual([expect.objectContaining({isolation:'repeatable read',readOnly:true,role:'ai_hr_app'})]);
  const statements=probe.queries.map(query=>query.sql).join(' ');
  expect(statements).toContain('reward_library_version');
  expect(statements).not.toMatch(/reward_private_pat_history|reward_pat_version|v\.data\s*(?:,|as)|reward_library_used_by|reward_library_locked/);
 }finally{probe.restore();}
 const spy=budgets();
 try{
  await held(f.b.tenantId,'access',context.signal,async pid=>{
   expect(await snapshot()).toEqual(expected);
   const [proof]=await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted) as held`;
   expect(proof.held).toBe(true);
   await expect(rewardPlanLibraryChoices(f.ctx,f.year)).rejects.toMatchObject({cause:{code:'55P03'}});
   await expect(rewardPlanCompanyChoices(f.ctx,f.year)).rejects.toMatchObject({cause:{code:'55P03'}});
  });
  expect(await events(f.b.tenantId)).toEqual(before);
  expect(await rewardPlanLibraryChoices(f.ctx,f.year)).toEqual(expected.libraries);
  expect(await rewardPlanCompanyChoices(f.ctx,f.year)).toEqual(expected.companies);
  const added=(await events(f.b.tenantId)).filter(row=>!before.some(previous=>row.id===previous.id));
  expect(added.map(({event_type,payload})=>({event_type,payload})).sort((a,b)=>a.event_type.localeCompare(b.event_type))).toEqual([
   {event_type:'rewards-setup.libraries.viewed',payload:{kind:null,year:f.year}},
   {event_type:'rewards-setup.pat.viewed',payload:{year:f.year}},
  ]);
 }finally{spy.mockRestore();}
},30000);

it('refuses Plans selector and audit calls for foreign tenants and company-scoped Rewards grants',async()=>{
 const f=await fixture(),foreign=await seedBase();
 await setModule(foreign.tenantId,'rewards','active');
 const expected=await events(f.b.tenantId);
 const refuse=async(ctx:SessionContext)=>{
  await expect(rewardPlanLibraryChoices(ctx,f.year)).rejects.toThrow();
  await expect(rewardPlanCompanyChoices(ctx,f.year)).rejects.toThrow();
 };
 await refuse(adminCtx(foreign));await refuse({...f.ctx,tenantId:foreign.tenantId});
 await owner.client`update reward_setup_grant set company_id=${f.b.companyId}::uuid where tenant_id=${f.b.tenantId}::uuid and user_id=${f.ctx.userId!}::uuid`;
 await refuse(f.ctx);
 await expect(setupReadTenant(f.ctx,tx=>rewardPlanLibraryChoicesQueryTx(tx,f.ctx,f.year,legacyRewardSetupQueryPort))).rejects.toThrow(/not available/);
 await expect(setupReadTenant(f.ctx,tx=>rewardPlanCompanyChoicesQueryTx(tx,f.ctx,f.year,legacyRewardSetupQueryPort))).rejects.toThrow(/not available/);
 expect(await events(f.b.tenantId)).toEqual(expected);
},30000);
