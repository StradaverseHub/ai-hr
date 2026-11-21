/** Disposable exact-924 fixture child. Business commands come only from the pinned F8 archive. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const SOURCE='f8c90ebcd3c0d4bd8310d9fb1cbab645b2ad108e';
const PINS={
 'db/client.ts':'93da2cd8b227b65bc913243920b1ecad3292903cac64f6b920d8df6ddb2a6b42',
 'db/worker-connection.ts':'6092196d8e4ba29c5c433464229659adf4348e2668bc12edf9e010a6fc982a89',
 'core/bulk-job-worker.ts':'72b1871bfefc2852d78bf64ae8a447647960f5048dac237b946d60d9ff79101c',
 'scripts/fixtures/reward-approved.ts':'89920f8eb24a4b0608072f80a6338dc3c7cd6820deadd8e3dac8dc20ddf8ae31',
 'packs/rewards/review-plans.ts':'91817ae72f86a225e665807c25f39a2ed215ab9702739b11c9738f06bc481bc6',
 'packs/rewards/person-history-upload.ts':'e344fd6b58a4de5a7004f58939af17d4f98bd4f4764876f4e2df5dcf39a28a13',
 'packs/rewards/person-history-worker.ts':'b418fca215c1c9c802dab76369f1f431868a991bcbaf6ff622a7e3a95100303c',
 'packs/rewards/person-history-model.ts':'ca8ec2c6a09a7d243980793f1430435c68e5e04f89185c58827b061bb9232f72',
 'core/company-organisation.ts':'b5a3c7ce2f43e61c9d1e166a8873279d960fc37e78551791ec1dc5ebd3d582f5',
 'core/entitlements.ts':'bb11d9601ec9d40c0d6c50cc9d878a4de555241e13f0116b18180aa417a3df98',
 'core/admin.ts':'625333cb66ec014c33f146f97d1c2c9d6d6b478201e94ece1abaa0e01ca5ca39',
 'tsconfig.json':'f5bc3a05bc19d85f6d1b7735e34bdd6b93f8f15741316108cc55d67ff4173785',
 'pnpm-lock.yaml':'7c833cb438bd31a1e22045b1704ed1498a4922343828e2d302e3ef4a6cdfb99a',
};
type Context={tenantId:string;userId:string;personId?:string|null;roles:string[];grants?:{role:string;companyId:string|null}[]};
type Receipt={source:string;actor:{userId:string;personId:string};businessUnitId:string;checkerUserId:string;
 plan:{year:number;companyId:string;revision:number;versionId:string;planType:'no_awards';reason:string};
 history:{id:string;jobId:string;employmentId:string;companyId:string;year:number;kind:'annual';source:'upload'};
 expected:{incrementCents:string;bonusCents:string;incrementBp:number;bonusMonthsBp:number}};
type Input={sourceRoot:string;mode:'seed'|'read';ctx:Context;companyId:string;departmentId:string;employmentId:string;employeeCode:'F8-924';year:number;receipt?:Receipt};
type ReadTx={execute(query:unknown):Promise<Record<string,unknown>[]>};
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function sqlState(error:unknown):string|undefined{
 for(let cause=error,n=0;cause&&typeof cause==='object'&&n<8;cause=(cause as {cause?:unknown}).cause,n++){
  const code=(cause as {code?:unknown}).code;if(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code))return code;
 }
}
function database(value:string|undefined,application:boolean){
 assert(value,'A disposable database URL is required');const url=new URL(value);
 assert(['postgres:','postgresql:'].includes(url.protocol));assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.port,'5433');
 assert(/^\/ai_hr_exact924_(?:base|ref|owner)_[a-f0-9]+$/.test(url.pathname),'Only the disposable exact924 databases are allowed');
 assert.equal(url.username==='ai_hr_app',application,'Separate native app and migration credentials required');
 return url;
}

async function main(){
 assert.equal(process.argv.length,3,'One JSON protocol argument required');const input=JSON.parse(process.argv[2]) as Input;
 assert(['seed','read'].includes(input.mode));assert.equal(input.employeeCode,'F8-924');
 for(const value of [input.ctx?.tenantId,input.ctx?.userId,input.companyId,input.departmentId,input.employmentId])assert(uuid(value));
 assert(Array.isArray(input.ctx.roles)&&input.ctx.roles.length>0&&input.ctx.roles.every(role=>['hr_admin','super_admin'].includes(role)));
 assert(Object.keys(input.ctx).every(key=>['tenantId','userId','personId','roles','grants'].includes(key)),'Only an actual human context is allowed');
 assert(Number.isInteger(input.year)&&input.year>=2003&&input.year<=2199);
 const sourceRoot=realpathSync(input.sourceRoot),temp=realpathSync(tmpdir()),inside=relative(temp,sourceRoot);
 assert(isAbsolute(input.sourceRoot)&&inside&&!inside.startsWith('..'+sep)&&!isAbsolute(inside));
 assert(inside.split(sep).some(part=>/^aihr-exact924-[a-zA-Z0-9_-]+$/.test(part)),'An owned exact924 temporary archive is required');
 assert.equal(resolve(input.sourceRoot),sourceRoot,'The source root itself cannot be a symlink');
 for(const [file,hash] of Object.entries(PINS))assert.equal(createHash('sha256').update(readFileSync(join(sourceRoot,file))).digest('hex'),hash,'Frozen F8 source mismatch: '+file);
 const app=database(process.env.TEST_DATABASE_URL??process.env.DATABASE_URL,true);
 const migration=database(process.env.TEST_MIGRATION_DATABASE_URL??process.env.MIGRATION_DATABASE_URL,false);
 assert.equal(app.pathname,migration.pathname);assert.equal(app.hostname,migration.hostname);
 for(const key of ['DATABASE_URL','DATABASE_POOLED_URL','TEST_DATABASE_URL'])process.env[key]=app.toString();
 for(const key of ['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])process.env[key]=migration.toString();
 process.env.AIHR_DB_PROCESS_ROLE='worker';process.env.AIHR_DB_POOL_MAX='1';process.env.AIHR_DB_POOLER_SERVER_CONNECTIONS='1';
 // No F8/application import occurs before URL, archive and identity-shape validation.
 process.chdir(sourceRoot);
 const load=async(file:string)=>{const loaded=await import(pathToFileURL(join(sourceRoot,file)).href);return loaded.default??loaded;};
 const client=await load('db/client.ts'),{sql}=await load('node_modules/drizzle-orm/index.js');
 const storage=client.createDb(migration.toString(),{max:1});let worker:ReturnType<typeof client.createDb>['client']|undefined;
 try{
  const [maker]=await client.withTenant(input.ctx,(tx:ReadTx)=>tx.execute(sql`select person_id::text as person_id from public.app_user where tenant_id=app.current_tenant_id() and id=app.current_user_id() and archived_at is null`));
  assert(maker,'The actual copied maker must exist');
  const {resolveEntitlementsTx}=await load('core/entitlements.ts');
  const entitlements=await client.withTenant(input.ctx,(tx:ReadTx)=>resolveEntitlementsTx(tx,input.ctx.tenantId));
  let ctx={...input.ctx,personId:maker.person_id,entitlements};
  const [subject]=await client.withTenant(ctx,(tx:ReadTx)=>tx.execute(sql`select e.company_id::text as company_id,e.employee_code,
   exists(select 1 from public.assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.department_id=${input.departmentId}::uuid and a.superseded_at is null and a.valid_to is null) as assigned
   from public.employment e where e.tenant_id=app.current_tenant_id() and e.id=${input.employmentId}::uuid`));
  assert.deepEqual(subject,{company_id:input.companyId,employee_code:input.employeeCode,assigned:true},'The genuine copied ordinary employment is required');
  const plans=await load('packs/rewards/review-plans.ts'),history=await load('packs/rewards/person-history-upload.ts');
  const metadata=async()=>client.withTenant(ctx,async(tx:ReadTx)=>{
   const [principal]=await tx.execute(sql`select app.principal_snapshot_current() as current,app.current_user_id()::text as uid`);
   assert.equal(principal?.current,true);assert.equal(principal?.uid,ctx.userId);
   return [...await tx.execute(sql`select id::text,company_id::text,employment_id::text,year,kind,source from public.reward_person_history where tenant_id=app.current_tenant_id() and employment_id=${input.employmentId}::uuid and source='upload' and superseded_at is null order by id`)];
  });
  let receipt=input.receipt;
  if(input.mode==='seed'){
   assert.equal(receipt,undefined,'Seed mode cannot adopt an existing receipt');
   const {todayInKualaLumpur}=await load('lib/hr-date.ts');assert.equal(input.year,Number(todayInKualaLumpur().slice(0,4)));
   const {approvedRewardFixtures}=await load('scripts/fixtures/reward-approved.ts');const fixtures=approvedRewardFixtures(storage);
   const checker=await fixtures.setupChecker(ctx);
   const [linked]=await client.withTenant(ctx,(tx:ReadTx)=>tx.execute(sql`select person_id::text as person_id from public.app_user where tenant_id=app.current_tenant_id() and id=app.current_user_id() and archived_at is null`));
   assert(uuid(linked?.person_id));ctx={...ctx,personId:linked.person_id};assert.notEqual(checker.userId,ctx.userId);
   const {createBusinessUnit}=await load('core/admin.ts');
   const unit=await createBusinessUnit(ctx,{companyId:input.companyId,code:'F8-924',name:'Fictional exact924 unit'});
   assert(uuid(unit.id));await fixtures.setupCompanyStructureFixture(ctx,[{companyId:input.companyId,businessUnitId:unit.id}],`${input.year}-01-01`,checker);
   const yearInput={year:input.year,settings:{effectiveFrom:`${input.year+1}-01-01`,joinedBefore:`${input.year}-10-01`,confirmedBy:`${input.year}-12-31`,activeAsOf:`${input.year}-12-31`,blockedFrom:`${input.year}-10-01`,blockedTo:`${input.year}-12-31`,snapshotDate:`${input.year}-01-01`}};
   const preview=await plans.previewRewardYear(ctx,yearInput);const created=await plans.createRewardYear(ctx,yearInput,preview.digest,'Reviewed fictional exact924 annual configuration');assert.equal(created.created,1);
   const view=await plans.rewardReviewPlans(ctx,{year:input.year});const row=view.rows.find((r:{companyId:string})=>r.companyId===input.companyId);assert(row);
   const reason='Fictional company has no awards this year';
   const edit={companyId:row.companyId,expectedRevision:row.revision,planType:'no_awards',reason,salaryVersionId:row.salaryVersionId,bonusVersionId:row.bonusVersionId,salaryReviewed:row.salarySuggestion.reviewed,bonusReviewed:row.bonusSuggestion.reviewed,branchAcknowledged:row.branchAcknowledged};
   const command={year:input.year,edits:[edit]},comparison=await plans.previewRewardPlanGrid(ctx,command);
   await plans.saveRewardPlanGrid(ctx,command,comparison.digest,'Reviewed fictional exact924 no-award comparison');
   const saved=(await plans.rewardReviewPlans(ctx,{year:input.year})).rows.find((r:{companyId:string})=>r.companyId===input.companyId);assert(saved);assert.equal(saved.planType,'no_awards');assert(uuid(saved.planVersionId));
   const {rewardHistoryUploadHeaders}=await load('packs/rewards/person-history-model.ts'),{toCsv}=await load('lib/csv.ts');
   const upload={companyId:input.companyId,name:'Fictional exact924 history.csv',csv:toCsv([rewardHistoryUploadHeaders,[input.employeeCode,String(input.year-2),'STAR','AE','5','250','5000','1','Annual']])};
   const checked=await history.previewRewardPersonHistoryImport(ctx,upload);assert.deepEqual(checked.problems,[]);assert.equal(checked.rows.length,1);assert.equal(checked.rows[0].employmentId,input.employmentId);
   const admitted=await history.importRewardPersonHistory(ctx,upload,checked.token);assert(uuid(admitted.jobId));
   const {openImportWorkerOwner}=await load('db/worker-connection.ts'),{runBulkJobTick}=await load('core/bulk-job-worker.ts'),{rewardPersonHistoryJobHandler}=await load('packs/rewards/person-history-worker.ts');
   worker=openImportWorkerOwner(migration.toString());let completed=false;
   for(let n=0;n<80;n++){
    const progress=await history.rewardPersonHistoryImportProgress(ctx,admitted.jobId);
    if(progress.state==='completed'){assert.equal(progress.stepsDone,1);assert.equal(progress.counters.imported,1);completed=true;break;}
    assert(!['failed','cancelled'].includes(progress.state),'The actual history job refused');
    const worked=await runBulkJobTick(worker,{handlers:[rewardPersonHistoryJobHandler]});
    if(!worked)await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert(completed,'The actual history kernel did not complete');
   const rows=await metadata();assert.equal(rows.length,1);assert(uuid(rows[0].id));
   receipt={source:SOURCE,actor:{userId:ctx.userId,personId:ctx.personId},businessUnitId:unit.id,checkerUserId:checker.userId,
    plan:{year:input.year,companyId:input.companyId,revision:saved.revision,versionId:saved.planVersionId,planType:'no_awards',reason},
    history:{id:String(rows[0].id),jobId:admitted.jobId,employmentId:input.employmentId,companyId:input.companyId,year:input.year-2,kind:'annual',source:'upload'},
    expected:{incrementCents:'25000',bonusCents:'500000',incrementBp:500,bonusMonthsBp:10000}};
  }
  assert(receipt&&receipt.source===SOURCE,'Original seed receipt required');assert.equal(receipt.actor.userId,ctx.userId);assert.equal(receipt.actor.personId,ctx.personId);
  assert.equal(receipt.plan.year,input.year);assert.equal(receipt.plan.companyId,input.companyId);assert.equal(receipt.history.employmentId,input.employmentId);
  const view=await plans.rewardReviewPlans(ctx,{year:input.year});const row=view.rows.find((r:{companyId:string})=>r.companyId===input.companyId);assert(row);
  assert.deepEqual({revision:row.revision,versionId:row.planVersionId,planType:row.planType,reason:row.reason},{revision:receipt.plan.revision,versionId:receipt.plan.versionId,planType:'no_awards',reason:receipt.plan.reason});
  assert.deepEqual(await metadata(),[{id:receipt.history.id,company_id:input.companyId,employment_id:input.employmentId,year:input.year-2,kind:'annual',source:'upload'}]);
  const progress=await history.rewardPersonHistoryImportProgress(ctx,receipt.history.jobId);assert.equal(progress.state,'completed');assert.equal(progress.counters.imported,1);
  await assert.rejects(()=>client.withTenant(ctx,(tx:ReadTx)=>tx.execute(sql`select bonus_cents,increment_cents from public.reward_person_history where id=${receipt!.history.id}::uuid`)),(error:unknown)=>sqlState(error)==='42501');
  const usage=await client.withTenant(ctx,(tx:ReadTx)=>tx.execute(sql`select app.reward_history_company_in_use(${input.companyId}::uuid) as history,app.reward_plan_company_in_use(${input.companyId}::uuid) as plan`));
  assert.deepEqual([...usage],[{history:true,plan:true}]);
  console.log('EXACT_924_RESULT '+JSON.stringify({kind:'NATIVE_F8_BOARD_BASELINE',mode:input.mode,source:SOURCE,receipt,checks:{plan:true,historyMetadata:true,uploadCompleted:true,privateAmountsDenied:true,companyRetention:true}}));
 }finally{
  if(worker)await worker.end({timeout:5});await storage.client.end({timeout:5});await client.client.end({timeout:5});
 }
}
main().catch(error=>{
 const message=error instanceof Error?error.message:'Unknown fixture failure';
 console.error('EXACT_924_CHILD_FAILED '+JSON.stringify({code:sqlState(error),message:message.replace(/postgres(?:ql)?:\/\/\S+/g,'[database URL]').slice(0,600)}));process.exitCode=1;
});
