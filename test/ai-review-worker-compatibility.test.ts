/** Immutable historical worker sources against current web commands and the migrated schema.
 * This proves ordinary overlap while draining jobs. Release requires the matching worker package,
 * including the new admission and infrastructure-failure semantics. GHA disposable DB only. */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {commitEmployeeImport} from '../core/import';
import {updatePerson} from '../core/org';
import {commitSectionImport,validateSectionImport} from '../core/import-sections';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
const WORKER_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e';
// Observed staging web and worker source before the architecture release. Freeze the
// historical compatibility pins here so future replacements cannot relabel their bytes.
const STAGING_BASELINE='a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac';
const archived=(ref:string,path:string)=>execFileSync('git',['show',ref+':'+path]);

// The dependency security update is an exact reviewed graph, not permission for arbitrary drift.
// The archived worker below retains its original package/lock while executing copied current deps.
const REVIEWED_SECURITY_GRAPH={source:'c58c30efd6bc81b20bb4b5a82b026b93c7297760',baseline:'8b676f25c006dd9a95dfd30bb6005e558923980a',
 lockSha256:'0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
 baselineLockSha256:'959230b1c75266db4c15f8df1c9aa4317e74f887d8899f4c05aace77b5fe9a62'} as const;
// Copied from the actual corrected V2 controller policy, not a fixture-only root expansion.
// This source fixture never substitutes for that controller's authenticated extracted-packet boot proof.
const PACKET_POLICY={controller:'567ec0908a24e21078e458ec1e93e696cafeb0a8',formatSha256:'07fa30e623f192ed8231ed42de4a606ed8251539db95389ec7ad6b50ff166369',
 roots:['package.json','pnpm-lock.yaml','tsconfig.json','app','assets','components','content','core','data','db','deploy','i18n','lib','localization','messages','packs','public','scripts','types','node_modules']};
const unchanged=['db/client.ts','core/bank-import-job.ts','lib/bank-import-source.server.ts','lib/bank-import-job.ts'];
// The staged baseline differs from 968 only in the reviewed type union and tax-reader setting.
// Each child still receives and verifies its complete immutable db/client.
const WORKER_AGENT_ENABLEMENT = "export type AgentEnablement = { feature: 'readiness_reminders' | 'claims_triage'; userId: string; eventId: string };";
const WEB_AGENT_ENABLEMENT = "export type AgentEnablement = { feature: 'readiness_reminders' | 'claims_triage' | 'approval_chasers' | 'review_chasers' | 'clock_reminders' | 'document_reminders' | 'lifecycle_chasers'; userId: string; eventId: string };";
// 929ea296 (PR126): web transactions declare the correction-aware income-tax reader. Without it a reader fails
// closed only on payslips that carry a tax-basis correction; the old worker's owners never read payslip.
const WEB_TAX_BASIS_READER = ", set_config('app.payroll_tax_basis_reader', '1', true)";

// Only the exact independently reviewed Bank changes may differ in the new web source.
// The executed old worker still receives its own immutable original bytes below.
const PRIOR_REVIEWED_BANK_SOURCE='9a1b613d8f7208e59ca389b0f72a67970a023a36';
// 3abe changes only buildProfile's passport check: required trio/order becomes the pack's
// nationality-aware validator. Bank jobs select bank_statutory at validation AND commit; the
// archived968 bytes remain unchanged and the real foreign-subject/cross-source cases below prove it.
const REVIEWED_BANK_SOURCE='3abe7f046b9445447010e86503aa86ad7deb97a7';
const PRIOR_PROFILE_PASSPORT_CHECK=`    if (!merged.passportNumber || !merged.passportIssueDate || !merged.passportExpiryDate) {
      errors.push(
        'passport_number, passport_issue_date and passport_expiry_date must all be on file together — this employee has none stored, so all three are needed',
      );
    } else if (merged.passportExpiryDate < merged.passportIssueDate) {
      errors.push('passport_expiry_date must be on or after passport_issue_date');`;
const REVIEWED_PROFILE_PASSPORT_CHECK=`    if (!subject.pack.statutory.validatePassport({personId:subject.personId,...merged},row.personPatch?.fields?.nationality??subject.personRow.nationality)) {
      errors.push('passport_number is required for non-Malaysian employees; check supplied passport dates and country code');`;
const reviewedChanges=['core/bank-import-worker.ts','core/import-sections.ts','core/import-history.ts'];
const payrollQueueWorkerPins = {
 'scripts/bank-import-runner.ts': '87be8d289901a19e8b1e74e8e7013b6f634416aa3cf5fe621d2b0b5c159f1e5f',
 'core/bank-import-worker.ts': '0d84069e170914694314c207aea7917cc652c54068c4181a6e884b748f47ef46',
} as const;
// The web package migration entry changed for guarded CI provisioning, not for the worker tick.
// Pin all three reviewed owners byte-for-byte; no arbitrary command omission or script allowlist.
const WORKER_MIGRATION_COMMAND='drizzle-kit migrate';
const WEB_MIGRATION_COMMAND='node --import tsx scripts/migrate-with-focused-prerequisites.ts';
const REVIEWED_MIGRATION_INPUTS=[
 {path:'scripts/migrate-with-focused-prerequisites.ts',sha256:'3050abc60faa490cdab416f9aeffc80b0b042daf3891ce2e34fbb42071bc7eec'},
 {path:'scripts/lib/discard-premigration.ts',sha256:'61f528c2570c90204e739a37652e7e79d6c3fc5905bbf849209d20c66709492a'},
 {path:'test/helpers/personnel-draft-discard-ci-role-fixture.ts',sha256:'32aaff3dc2f8a80bfe3e69769422b234e0f607a5dad7c0f4b4cb27e5946a3c54'},
] as const;
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
it.each([['legacy',WORKER_SOURCE],['staged',STAGING_BASELINE]] as const)(
 'runs immutable %s worker source against the migrated database and current web commands',async(label,workerSource)=>{
 expect(execFileSync('git',['diff','--name-only',WORKER_SOURCE,'HEAD','--',...unchanged.filter(path=>path!=='db/client.ts')],{encoding:'utf8'}).trim()).toBe('');
 const workerClient=archived(WORKER_SOURCE,'db/client.ts').toString('utf8'),webClient=archived(STAGING_BASELINE,'db/client.ts').toString('utf8');
 expect(workerClient.split(WORKER_AGENT_ENABLEMENT)).toHaveLength(2);
 expect(webClient.split(WEB_AGENT_ENABLEMENT)).toHaveLength(2);
 // No arbitrary type/comment stripping: ANY other runtime, import, context, transaction or type delta fails.
 expect(webClient.split(WEB_TAX_BASIS_READER)).toHaveLength(2);
 expect(webClient.replace(WEB_AGENT_ENABLEMENT,WORKER_AGENT_ENABLEMENT).replace(WEB_TAX_BASIS_READER,'')).toBe(workerClient);
 for(const path of unchanged.filter(path=>path!=='db/client.ts'))expect(execFileSync('git',['show',WORKER_SOURCE+':'+path],{encoding:'utf8'}),path+' never reads payslip').not.toMatch(/payslip/i);
 expect(execFileSync('git',['diff','--name-only',WORKER_SOURCE,STAGING_BASELINE,'--',...reviewedChanges],{encoding:'utf8'}).trim().split('\n').sort()).toEqual([...reviewedChanges].sort());
 expect(execFileSync('git',['diff','--name-only',REVIEWED_BANK_SOURCE,STAGING_BASELINE,'--',...reviewedChanges.filter(path=>path!=='core/bank-import-worker.ts')],{encoding:'utf8'}).trim()).toBe('');
 for(const [path,hash] of Object.entries(payrollQueueWorkerPins))expect(createHash('sha256').update(archived(STAGING_BASELINE,path)).digest('hex'),path).toBe(hash);
 const priorSections=execFileSync('git',['show',PRIOR_REVIEWED_BANK_SOURCE+':core/import-sections.ts'],{encoding:'utf8'});
 expect(priorSections.split(PRIOR_PROFILE_PASSPORT_CHECK)).toHaveLength(2);
 expect(execFileSync('git',['show',REVIEWED_BANK_SOURCE+':core/import-sections.ts'],{encoding:'utf8'})).toBe(priorSections.replace(PRIOR_PROFILE_PASSPORT_CHECK,REVIEWED_PROFILE_PASSPORT_CHECK));
 for(const path of reviewedChanges.filter(path=>path!=='core/import-sections.ts'))expect(execFileSync('git',['show',REVIEWED_BANK_SOURCE+':'+path],{encoding:'utf8'})).toBe(execFileSync('git',['show',PRIOR_REVIEWED_BANK_SOURCE+':'+path],{encoding:'utf8'}));
 // PR61 adds the explicit validator/server marker deltas. The later guarded migration entry
 // still delegates to the same drizzle-kit engine; the archived worker is started directly below.
 // Normalize only this one EXACT reviewed comparison value; every other package key remains checked.
 const oldPackage=JSON.parse(execFileSync('git',['show',WORKER_SOURCE+':package.json'],{encoding:'utf8'}));
 const webPackage=JSON.parse(readFileSync('package.json','utf8'));
 expect(oldPackage.scripts['db:migrate']).toBe(WORKER_MIGRATION_COMMAND);
 expect(webPackage.scripts['db:migrate']).toBe(WEB_MIGRATION_COMMAND);
 for(const input of REVIEWED_MIGRATION_INPUTS)expect(createHash('sha256').update(readFileSync(input.path)).digest('hex'),input.path).toBe(input.sha256);
 expect(oldPackage).toMatchObject({dependencies:{next:'16.3.8',nodemailer:'10.1.0'},devDependencies:{'eslint-config-next':'16.3.8'}});
 expect({...webPackage,scripts:{...webPackage.scripts,'db:migrate':WORKER_MIGRATION_COMMAND}}).toEqual({...oldPackage,
  dependencies:{...oldPackage.dependencies,'server-only':'0.0.1',next:'16.4.1',nodemailer:'10.1.4'},
  devDependencies:{...oldPackage.devDependencies,ajv:'8.20.0','eslint-config-next':'16.4.1'}});
 const securityLock=execFileSync('git',['show',REVIEWED_SECURITY_GRAPH.source+':pnpm-lock.yaml'],{encoding:'utf8'});
 expect(createHash('sha256').update(securityLock).digest('hex')).toBe(REVIEWED_SECURITY_GRAPH.lockSha256);
 expect(readFileSync('pnpm-lock.yaml','utf8'),'only the exact reviewed security dependency graph').toBe(securityLock);
 expect(execFileSync('git',['rev-parse',REVIEWED_SECURITY_GRAPH.source+'^'],{encoding:'utf8'}).trim()).toBe(REVIEWED_SECURITY_GRAPH.baseline);
 const baselineLock=execFileSync('git',['show',REVIEWED_SECURITY_GRAPH.baseline+':pnpm-lock.yaml'],{encoding:'utf8'});
 expect(createHash('sha256').update(baselineLock).digest('hex')).toBe(REVIEWED_SECURITY_GRAPH.baselineLockSha256);
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
 // Retain the original historical comparison against the exact pre-security baseline.
 let lock=baselineLock;
 for(const block of additions){expect(lock.split(block)).toHaveLength(2);lock=lock.replace(block,'');}
 expect(lock).toBe(execFileSync('git',['show',WORKER_SOURCE+':pnpm-lock.yaml'],{encoding:'utf8'}));

 const directory=mkdtempSync(join(tmpdir(),'aihr-worker-compat-'));
 try{
  const available=new Set(execFileSync('git',['ls-tree','--name-only',workerSource],{encoding:'utf8'}).trim().split('\n'));
  const roots=PACKET_POLICY.roots.filter(path=>available.has(path));
  expect(roots).toEqual(expect.arrayContaining(['package.json','pnpm-lock.yaml','tsconfig.json','core','db','i18n','localization','lib','scripts','packs']));
  const archive=execFileSync('git',['archive',workerSource,...roots],{maxBuffer:128*1024**2});
  execFileSync('tar',['-xf','-','-C',directory],{input:archive,maxBuffer:1024**2});
  for(const path of ['package.json','pnpm-lock.yaml',...new Set([...unchanged,...reviewedChanges,...Object.keys(payrollQueueWorkerPins)])])expect(readFileSync(join(directory,path)).equals(execFileSync('git',['show',WORKER_SOURCE+':'+path])),'Executed old worker retains original '+path).toBe(true);
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
  await updatePerson(ctx,{personId:employee.personId,fullName:'Fictional compatibility employee',primaryEmail:'ai-worker-compat@example.test',nationality:'Singaporean'});
  // Exercise the new WEB Profile branch, not a Bank job pretending to be a Passport import.
  const passportRecords=parseCsvRecords('employee_code,passport_number\nAICOMPAT,FOREIGN-COMPAT-ONLY').records;
  expect((await validateSectionImport(ctx,{section:'profile',records:passportRecords})).rows[0]).toMatchObject({ok:true,changes:['passport_number']});
  expect(await commitSectionImport(ctx,{section:'profile',records:passportRecords})).toMatchObject({updated:1,failed:[]});
  const passport=async()=>{const [row]=await owner.db.select({number:s.employeeStatutoryMy.passportNumber,issue:s.employeeStatutoryMy.passportIssueDate,expiry:s.employeeStatutoryMy.passportExpiryDate,remark:s.employeeStatutoryMy.passportRemark,country:s.employeeStatutoryMy.passportIssuingCountry,countryCode:s.employeeStatutoryMy.passportIssuingCountryCode}).from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employee.personId));return row;};
  const passportBefore=await passport();expect(passportBefore).toMatchObject({number:'FOREIGN-COMPAT-ONLY',issue:null,expiry:null});
  const [schema]=await owner.db.execute<{quota_table:string;ledger:number}>(sql`select to_regclass('app.assistant_question_budget')::text as quota_table,(select count(*)::int from drizzle.__drizzle_migrations) as ledger`);
  expect(schema.quota_table).toBe('app.assistant_question_budget');expect(schema.ledger).toBeGreaterThanOrEqual(563);
  const bytes=Buffer.from('employee_code,tax_number,bank_name,bank_account_no\nAICOMPAT,T-AI-COMPAT,Maybank,000123456789');
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
  expect((await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employee.personId)))[0]).toMatchObject({taxNumber:'T-AI-COMPAT',bankName:'Maybank',bankAccountNo:'000123456789'});
  expect(await passport()).toEqual(passportBefore);
  const history=await owner.db.select().from(s.importAttemptItem).where(eq(s.importAttemptItem.attemptId,done.attemptId!));expect(history).toHaveLength(1);
  // A new process against the durable completed job cannot duplicate its canonical effect or receipt.
  tick();expect((await getBankImportJob(ctx,admission.job.id)).job).toMatchObject({state:'completed',saved:1,processed:1});
  expect(await owner.db.select().from(s.importAttemptItem).where(eq(s.importAttemptItem.attemptId,done.attemptId!))).toEqual(history);
  // Recognized Profile columns are refused as a WHOLE file, never ignored or written through Bank.
  const personsBefore=await owner.db.select().from(s.person).where(eq(s.person.id,employee.personId));
  const statutoryBefore=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employee.personId));
  const attemptsBefore=await owner.db.select().from(s.importAttempt).where(eq(s.importAttempt.tenantId,base.tenantId)).orderBy(s.importAttempt.id);
  for(const [name,text] of [
   ['passport-only.csv','employee_code,passport_number\nAICOMPAT,REJECTED-PASSPORT'],
   ['bank-plus-passport.csv','employee_code,tax_number,bank_name,bank_account_no,passport_number\nAICOMPAT,REJECTED-TAX,Maybank,9999999999,REJECTED-PASSPORT'],
  ]){
   const content=Buffer.from(text),rejected=await createBankImportJob(ctx,{name,bytes:content.length,hash:createHash('sha256').update(content).digest('hex')});
   await uploadBankImportChunk(ctx,rejected.job.id,0,content);await bankImportCommand(ctx,rejected.job.id,'validate');
   tick();expect((await getBankImportJob(ctx,rejected.job.id)).job).toMatchObject({state:'validating',total:1,saved:0});
   tick();expect((await getBankImportJob(ctx,rejected.job.id)).job).toMatchObject({state:'failed',saved:0,processed:0,attemptId:null});
   await expect(bankImportCommand(ctx,rejected.job.id,'confirm')).rejects.toThrow('Wait for validation');
   expect(await owner.db.select().from(s.person).where(eq(s.person.id,employee.personId))).toEqual(personsBefore);
   expect(await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,employee.personId))).toEqual(statutoryBefore);
   expect(await owner.db.select().from(s.importAttempt).where(eq(s.importAttempt.tenantId,base.tenantId)).orderBy(s.importAttempt.id)).toEqual(attemptsBefore);
   expect(await owner.db.select().from(s.importAttemptItem).where(eq(s.importAttemptItem.attemptId,done.attemptId!))).toEqual(history);
  }
  const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'worker-cross-version-'+label+'.json'),JSON.stringify({
   kind:'GIT_SOURCE_CROSS_VERSION_FIXTURE_NOT_PACKET_OR_LIVE_ACCEPTANCE',workerSource,webSource:process.env.AIHR_CI_HEAD,reviewedHistoricalBaseline:STAGING_BASELINE,matchingWorkerRequired:true,
   reviewedCurrentDependencyGraph:REVIEWED_SECURITY_GRAPH,executedDependencyOrigin:'copied-current-reviewed-node_modules-not-historical-worker-packet',
   correctedRootPolicy:PACKET_POLICY,actualPacketExecuted:false,authenticatedCorrectedPacketProofRequired:true,
   schemaEntries:schema.ledger,unchangedSourcePaths:unchanged.filter(path=>path!=='db/client.ts'),reviewedHistoricalClientDelta:{path:'db/client.ts',legacySource:WORKER_SOURCE,stagedSource:STAGING_BASELINE,legacyDeclaration:WORKER_AGENT_ENABLEMENT,stagedDeclaration:WEB_AGENT_ENABLEMENT,taxBasisReaderAdded:true,allOtherBytesIdentical:true},reviewedChangedPathContracts:{source:REVIEWED_BANK_SOURCE,paths:reviewedChanges,executedWorkerBytes:workerSource},reviewedWebMigrationEntryChange:{workerCommand:WORKER_MIGRATION_COMMAND,webCommand:WEB_MIGRATION_COMMAND,inputs:REVIEWED_MIGRATION_INPUTS,executedArchivedPackageAndLock:workerSource,workerTickUsesPackageMigrationCommand:false},sourceArchiveSha256:createHash('sha256').update(archive).digest('hex'),
   newWebAdmission:true,humanCommandFixture:true,canonicalWrite:true,tenantDenial:true,newProcessReplay:true,historyItems:history.length,
   reviewedWebPassportChange:{priorSource:PRIOR_REVIEWED_BANK_SOURCE,source:REVIEWED_BANK_SOURCE,changedBranch:'buildProfile',webProfileNumberOnlyApplied:true,archivedWorkerBankTaxPreservedNumberOnlyPassport:true,passportOnlyAndMixedBankSourcesRefused:true,refusedSourcesCreatedNoAttemptOrPersonnelMutation:true},
   protectedServiceVerified:false,liveRestartVerified:false,deploymentAuthorized:false,
  },null,2)+'\n');}
 }finally{rmSync(directory,{recursive:true,force:true});}
},180000);
