/** Immutable Bank worker Git source vs the new AI-review schema/web contract. GHA disposable DB only.
 * This supplies compatibility evidence for an owner decision, never permission to retain/update a live service. */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
const WORKER_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e';
// Copied from the actual corrected V2 controller policy, not a fixture-only root expansion.
// This source fixture never substitutes for that controller's authenticated extracted-packet boot proof.
const PACKET_POLICY={controller:'567ec0908a24e21078e458ec1e93e696cafeb0a8',formatSha256:'07fa30e623f192ed8231ed42de4a606ed8251539db95389ec7ad6b50ff166369',
 roots:['package.json','pnpm-lock.yaml','tsconfig.json','app','assets','components','content','core','data','db','deploy','i18n','lib','localization','messages','packs','public','scripts','types','node_modules']};
const unchanged=['db/client.ts','scripts/bank-import-runner.ts','core/bank-import-job.ts','lib/bank-import-source.server.ts','lib/bank-import-job.ts'];
// Only the exact independently reviewed Bank changes may differ in the new web source.
// The executed old worker still receives its own immutable original bytes below.
const REVIEWED_BANK_SOURCE='9a1b613d8f7208e59ca389b0f72a67970a023a36';
const reviewedChanges=['core/bank-import-worker.ts','core/import-sections.ts','core/import-history.ts'];
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
it('runs immutable 968 worker Git source under the corrected V2 root policy against the AI schema and web contract',async()=>{
 expect(execFileSync('git',['diff','--name-only',WORKER_SOURCE,'HEAD','--',...unchanged],{encoding:'utf8'}).trim()).toBe('');
 expect(execFileSync('git',['diff','--name-only',WORKER_SOURCE,'HEAD','--',...reviewedChanges],{encoding:'utf8'}).trim().split('\n').sort()).toEqual([...reviewedChanges].sort());
 expect(execFileSync('git',['diff','--name-only',REVIEWED_BANK_SOURCE,'HEAD','--',...reviewedChanges],{encoding:'utf8'}).trim()).toBe('');
 // PR61 adds a pinned provider-schema validator for tests only. Prove the complete old package
 // and lock graph remain identical after removing ONLY the explicit validator and server-boundary marker deltas.
 const oldPackage=JSON.parse(execFileSync('git',['show',WORKER_SOURCE+':package.json'],{encoding:'utf8'}));
 expect(JSON.parse(readFileSync('package.json','utf8'))).toEqual({...oldPackage,dependencies:{...oldPackage.dependencies,'server-only':'0.0.1'},devDependencies:{...oldPackage.devDependencies,ajv:'8.20.0'}});
 const additions=[
  '      server-only:\n        specifier: 0.0.1\n        version: 0.0.1\n',
  '  server-only@0.0.1:\n    resolution: {integrity: sha512-qepMx2JxAa5jjfzxG79yPPq+8BuFToHd1hm7kI+Z4zAq1ftQiP7HcxMhDDItrbtwVeLg/cY2JnKnrcFkmiswNA==}\n\n',
  '  server-only@0.0.1: {}\n\n',
  '      ajv:\n        specifier: 8.20.0\n        version: 8.20.0\n',
  '  ajv@8.20.0:\n    resolution: {integrity: sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==}\n\n',
  '  fast-uri@3.1.9:\n    resolution: {integrity: sha512-hS/0Wt3Ya043oKXs0sIxrMpKQITXhMLIrVAKKXi4gozGC9v7YRWVnXIZzjNPTO02M9BdxLCWqK1yRXgNziVyJQ==}\n\n',
  '  json-schema-traverse@1.0.0:\n    resolution: {integrity: sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==}\n\n',
  '  ajv@8.20.0:\n    dependencies:\n      fast-deep-equal: 3.1.3\n      fast-uri: 3.1.9\n      json-schema-traverse: 1.0.0\n      require-from-string: 2.0.2\n\n',
  '  fast-uri@3.1.9: {}\n\n',
  '  json-schema-traverse@1.0.0: {}\n\n',
 ];
 let lock=readFileSync('pnpm-lock.yaml','utf8');
 for(const block of additions){expect(lock.split(block)).toHaveLength(2);lock=lock.replace(block,'');}
 expect(lock).toBe(execFileSync('git',['show',WORKER_SOURCE+':pnpm-lock.yaml'],{encoding:'utf8'}));

 const directory=mkdtempSync(join(tmpdir(),'aihr-worker-compat-'));
 try{
  const available=new Set(execFileSync('git',['ls-tree','--name-only',WORKER_SOURCE],{encoding:'utf8'}).trim().split('\n'));
  const roots=PACKET_POLICY.roots.filter(path=>available.has(path));
  expect(roots).toEqual(expect.arrayContaining(['package.json','pnpm-lock.yaml','tsconfig.json','core','db','i18n','localization','lib','scripts','packs']));
  const archive=execFileSync('git',['archive',WORKER_SOURCE,...roots],{maxBuffer:128*1024**2});
  execFileSync('tar',['-xf','-','-C',directory],{input:archive,maxBuffer:1024**2});
  for(const path of [...unchanged,...reviewedChanges])expect(readFileSync(join(directory,path)).equals(execFileSync('git',['show',WORKER_SOURCE+':'+path])),'Executed old worker retains original '+path).toBe(true);
  // Real isolated dependency files, preserving internal pnpm links. No external module symlink,
  // installation files, frozen worker source or vendor network is modified by this disposable fixture.
  execFileSync('cp',['-a',...(process.platform==='linux'?['--reflink=auto']:[]),join(process.cwd(),'node_modules'),join(directory,'node_modules')],{timeout:60000,maxBuffer:1024**2});
  const tick=()=>{
   const result=spawnSync(process.execPath,['--import','tsx','scripts/bank-import-runner.ts','--once'],{
    cwd:directory,encoding:'utf8',timeout:30000,env:{...process.env,TSX_DISABLE_CACHE:'1',DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL},
   });
   expect(result.status,result.stderr||String(result.error??'')).toBe(0);
  };
  const base=await seedBase(),ctx=adminCtx(base);
  const imported=await commitEmployeeImport(ctx,{companyId:base.companyId,records:parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nFictional compatibility employee,ai-worker-compat@example.test,Finance,2026-01-05,900101105555,5000,AICOMPAT').records});
  expect(imported.imported,JSON.stringify(imported.failed)).toBe(1);
  const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.employeeCode,'AICOMPAT'));
  const [schema]=await owner.db.execute<{quota_table:string;ledger:number}>(sql`select to_regclass('app.assistant_question_budget')::text as quota_table,(select count(*)::int from drizzle.__drizzle_migrations) as ledger`);
  expect(schema.quota_table).toBe('app.assistant_question_budget');expect(schema.ledger).toBeGreaterThanOrEqual(563);
  const bytes=Buffer.from('employee_code,tax_number\nAICOMPAT,T-AI-COMPAT');
  const admission=await createBankImportJob(ctx,{name:'fictional-compat.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
  await uploadBankImportChunk(ctx,admission.job.id,0,bytes);await bankImportCommand(ctx,admission.job.id,'validate');
  tick();expect((await getBankImportJob(ctx,admission.job.id)).job).toMatchObject({state:'validating',total:1,saved:0});
  tick();expect((await getBankImportJob(ctx,admission.job.id)).job).toMatchObject({state:'validating',validated:1,valid:1,saved:0});
  // A separate native tick observes that validation has drained before offering human confirmation.
  tick();expect((await getBankImportJob(ctx,admission.job.id)).job).toMatchObject({state:'ready',valid:1,saved:0});
  await expect(getBankImportJob(adminCtx(await seedBase()),admission.job.id)).rejects.toThrow('unavailable');
  await bankImportCommand(ctx,admission.job.id,'confirm');tick();tick();
  const done=(await getBankImportJob(ctx,admission.job.id)).job;
  expect(done).toMatchObject({state:'completed',total:1,processed:1,saved:1,failed:0});
  expect((await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employee.personId)))[0].taxNumber).toBe('T-AI-COMPAT');
  const history=await owner.db.select().from(s.importAttemptItem).where(eq(s.importAttemptItem.attemptId,done.attemptId!));expect(history).toHaveLength(1);
  // A new process against the durable completed job cannot duplicate its canonical effect or receipt.
  tick();expect((await getBankImportJob(ctx,admission.job.id)).job).toMatchObject({state:'completed',saved:1,processed:1});
  expect(await owner.db.select().from(s.importAttemptItem).where(eq(s.importAttemptItem.attemptId,done.attemptId!))).toEqual(history);
  const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'worker-cross-version.json'),JSON.stringify({
   kind:'GIT_SOURCE_CROSS_VERSION_FIXTURE_NOT_PACKET_OR_LIVE_ACCEPTANCE',workerSource:WORKER_SOURCE,webSource:process.env.AIHR_CI_HEAD,
   correctedRootPolicy:PACKET_POLICY,actualPacketExecuted:false,authenticatedCorrectedPacketProofRequired:true,
   schemaEntries:schema.ledger,unchangedSourcePaths:unchanged,reviewedChangedPathContracts:{source:REVIEWED_BANK_SOURCE,paths:reviewedChanges,executedWorkerBytes:WORKER_SOURCE},sourceArchiveSha256:createHash('sha256').update(archive).digest('hex'),
   newWebAdmission:true,humanCommandFixture:true,canonicalWrite:true,tenantDenial:true,newProcessReplay:true,historyItems:history.length,
   protectedServiceVerified:false,liveRestartVerified:false,deploymentAuthorized:false,
  },null,2)+'\n');}
 }finally{rmSync(directory,{recursive:true,force:true});}
},180000);
