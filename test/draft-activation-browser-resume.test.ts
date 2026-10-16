import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {draftActivationBrowserOptions,DRAFT_ACTIVATION_BROWSER_TARGET,draftActivationResumeReceiptName,validateDraftActivationResumeReceipts} from '../scripts/draft-activation-browser-resume.mjs';
const root='/fictional/draft-worktree/',prepared='a'.repeat(40),later='b'.repeat(40);
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
type Bag={root:string;fixture:Record<string,unknown>;browser:Record<string,unknown>;stopped:Record<string,unknown>;resumeRecords:Record<string,Record<string,unknown>>};
function receipts():Bag {
 const bound={root,database:DRAFT_ACTIVATION_BROWSER_TARGET.database,namespace:DRAFT_ACTIVATION_BROWSER_TARGET.namespace,port:3204};
 const companies={Main:id(1),Foreign:id(2)},locales=['en','ms','zh','ta','th','vi'];
 const roles={HR:'hr_admin',Manager:'manager',Employee:'employee',ForeignHR:'hr_admin',ForeignEmployee:'employee'};
 const people=Object.fromEntries(Object.entries(roles).map(([key,role],i)=>[key,{userId:id(10+i),personId:id(20+i),employmentId:id(30+i),employeeCode:'ACT15-'+key.toUpperCase(),companyId:key.startsWith('Foreign')?companies.Foreign:companies.Main,login:'activation15-fixture:'+key,role}]));
 const cases=['valid','optionalBlank','invalidIdentity','missingRequired','stalePolicy','locale_en','locale_ms','locale_zh','locale_ta','locale_th','locale_vi','deleteCancel','deleteConfirm','foreign'];
 const drafts=Object.fromEntries(cases.map((key,i)=>[key,{id:id(100+i),employeeCode:'ACT15-G'+String(i+1),companyId:key==='foreign'?companies.Foreign:companies.Main,reservedConfigId:id(3),reservedNumber:i+1,currentStep:6,data:{profile:{fullName:'Fictional '+key}},dataSha256:'c'.repeat(64),routes:Object.fromEntries(locales.map(locale=>[locale,'/admin/personnel/new?draft='+id(100+i)]))}]));
 const fixture={...bound,tenantId:'11111111-1111-1111-1111-111111111111',locales,companies,people,drafts};
 return {root,fixture,browser:{...bound,candidate:prepared,fixtureRuns:2,fixture:structuredClone(fixture)},stopped:{candidate:prepared,database:bound.database,port:3204,ownedServerStopped:true,stoppedAt:'2026-10-15T20:01:42.265Z'},resumeRecords:{}};
}
function resume(r:Bag,candidate=later,stamp='1792117812536',failed=false):Bag {
 const binding=validateDraftActivationResumeReceipts(r),name='browser-resume-'+candidate+'-'+stamp+'.json';
 const record={...binding,candidate,root,database:DRAFT_ACTIVATION_BROWSER_TARGET.database,namespace:DRAFT_ACTIVATION_BROWSER_TARGET.namespace,port:3204,preparationManifest:'browser-manifest.json',priorStoppedReceipt:structuredClone(r.stopped),fixtureRunsThisCandidate:0,resumedAt:'2026-10-16T03:00:00.000Z',applicationAcceptance:'UNVERIFIED'};
 return {...r,resumeRecords:{...r.resumeRecords,[name]:record},stopped:{candidate,preparationCandidate:prepared,root,database:DRAFT_ACTIVATION_BROWSER_TARGET.database,namespace:DRAFT_ACTIVATION_BROWSER_TARGET.namespace,port:3204,resumeReceipt:name,serverPid:4321,ownedServerStopped:true,cleanupSucceeded:true,outcome:failed?'failed':'stopped',exitCode:failed?1:0,stoppedAt:'2026-10-16T03:01:00.000Z'}};
}
describe('preserved Draft browser resume',()=>{
 it('accepts only explicit closed coordinator/worker flags, with no fixture child flag',()=>{
  expect(draftActivationBrowserOptions([])).toEqual({resume:false,heldLockWorker:false});
  expect(draftActivationBrowserOptions(['--resume'])).toEqual({resume:true,heldLockWorker:false});
  expect(draftActivationBrowserOptions(['--held-lock-worker','--resume'],{allowWorker:true})).toEqual({resume:true,heldLockWorker:true});
  for(const args of [['--held-lock-worker'],['--resume','--resume'],['--held-lock-worker','--held-lock-worker'],['--attempt=b2'],['--port=3204'],['../'],['--defer-payroll'],['--resume=true']])expect(()=>draftActivationBrowserOptions(args)).toThrow();
 });
 it('accepts original legacy cleanup and the actual Draft-specific shape without requiring mutable Draft rows or an OT date',()=>{
  const r=receipts(),binding=validateDraftActivationResumeReceipts(r);
  expect(binding).toMatchObject({preparationCandidate:prepared,resumedFromCandidate:prepared});
  expect(binding.preparationBrowserDigest).toMatch(/^[0-9a-f]{64}$/);expect(binding.preparationFixtureDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(r.fixture).not.toHaveProperty('date');expect(r.fixture).not.toHaveProperty('setupOnly');expect(r.fixture).not.toHaveProperty('foreignTenant');
  expect(validateDraftActivationResumeReceipts(resume(resume(r),'d'.repeat(40),'1792117812537',true))).toMatchObject({preparationCandidate:prepared,resumedFromCandidate:'d'.repeat(40)});
 });
 it.each(['root','database','namespace','port','tenantId','locales','companies','people','drafts'] as const)('refuses fixture %s drift even when copied into the browser declaration',key=>{
  const r=receipts();r.fixture[key]=null;r.browser.fixture=structuredClone(r.fixture);expect(()=>validateDraftActivationResumeReceipts(r)).toThrow();
 });
 it('refuses a mismatched original fixture, zero clean runs, wrong actor/company and wrong Draft route',()=>{
  const mismatched=receipts();mismatched.browser.fixture={};expect(()=>validateDraftActivationResumeReceipts(mismatched)).toThrow();
  const noRuns=receipts();noRuns.browser.fixtureRuns=0;expect(()=>validateDraftActivationResumeReceipts(noRuns)).toThrow();
  for(const mutate of [
   (f:Record<string,unknown>)=>{const people=f.people as Record<string,Record<string,unknown>>;people.HR.companyId=id(2);},
   (f:Record<string,unknown>)=>{const people=f.people as Record<string,Record<string,unknown>>;people.HR.login='other';},
   (f:Record<string,unknown>)=>{const drafts=f.drafts as Record<string,Record<string,unknown>>;(drafts.deleteConfirm.routes as Record<string,unknown>).en='/admin/personnel/new?draft='+id(999);},
  ]) {const r=receipts();mutate(r.fixture);r.browser.fixture=structuredClone(r.fixture);expect(()=>validateDraftActivationResumeReceipts(r)).toThrow();}
 });
 it.each(['candidate','database','port','ownedServerStopped','stoppedAt'] as const)('refuses missing original stop %s',key=>{const r=receipts();delete r.stopped[key];expect(()=>validateDraftActivationResumeReceipts(r)).toThrow();});
 it('accepts only the exact old stop shape or a complete new cleanup receipt for original preparation',()=>{
  const r=receipts();expect(()=>validateDraftActivationResumeReceipts({...r,stopped:{...r.stopped,serverPid:4321}})).toThrow();
  const complete={...r.stopped,root,namespace:DRAFT_ACTIVATION_BROWSER_TARGET.namespace,preparationCandidate:prepared,serverPid:4321,cleanupSucceeded:true,outcome:'stopped',exitCode:0};
  expect(validateDraftActivationResumeReceipts({...r,stopped:complete})).toMatchObject({resumedFromCandidate:prepared});
  expect(()=>validateDraftActivationResumeReceipts({...r,stopped:{...complete,cleanupSucceeded:false}})).toThrow();
 });
 it('accounts for failed cleanup without claiming PASS and refuses an unaccounted newer resume',()=>{
  const r=resume(receipts(),later,'1792117812536',true);expect(validateDraftActivationResumeReceipts(r)).toMatchObject({resumedFromCandidate:later});
  const orphan={...r,stopped:receipts().stopped};expect(()=>validateDraftActivationResumeReceipts(orphan)).toThrow();
  for(const changed of [{cleanupSucceeded:false},{outcome:undefined},{exitCode:0},{serverPid:undefined},{namespace:'other'},{resumeReceipt:'../escape.json'}])expect(()=>validateDraftActivationResumeReceipts({...r,stopped:{...r.stopped,...changed}})).toThrow();
 });
 it('binds every prior resume to its actual stop, original manifests and zero setup calls',()=>{
  const r=resume(receipts()),name=String(r.stopped.resumeReceipt),original=r.resumeRecords[name];
  for(const changed of [{resumedFromCandidate:'f'.repeat(40)},{priorStoppedReceipt:null},{priorStoppedReceipt:{...r.stopped}},{fixtureRunsThisCandidate:2},{preparationBrowserDigest:'0'.repeat(64)},{preparationFixtureDigest:'0'.repeat(64)},{applicationAcceptance:'PASS'},{resumedAt:''}])expect(()=>validateDraftActivationResumeReceipts({...r,resumeRecords:{[name]:{...original,...changed}}})).toThrow();
  const many=Object.fromEntries(Array.from({length:65},(_,i)=>['browser-resume-'+later+'-'+(1792117812536+i)+'.json',original]));expect(()=>validateDraftActivationResumeReceipts({...r,resumeRecords:many})).toThrow();
  expect(draftActivationResumeReceiptName('../browser-resume-'+later+'-1792117812536.json',later)).toBe(false);
  expect(draftActivationResumeReceiptName('browser-resume-'+later+'-1792117812536.json',prepared)).toBe(false);
 });
 it('keeps all setup in the default branch and publishes current cleanup only after owned groups and handles close',()=>{
  const source=readFileSync(new URL('../scripts/dev-browser-draft-activation.mjs',import.meta.url),'utf8'),start=source.indexOf('    if(options.resume) {'),end=source.indexOf('    } else {',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const branch=source.slice(start,end);expect(branch.length).toBeGreaterThan(1000);
  for(const forbidden of ['CREATE DATABASE','await run(','dev-fixture-draft-activation','drizzle-kit',"writeFileSync(path.join(out,'browser-manifest.json')"])expect(branch).not.toContain(forbidden);
  for(const required of ["'db/migrations','packs/catalog.ts','db/schema.ts'",'proveStoppedGroup(stopped)','rolbypassrls','fixtureRunsThisCandidate:0','System (auth audit)'])expect(branch).toContain(required);
  expect(source).toContain("...(options.resume?['--resume']:[])");expect(source).toContain('watchdog=setTimeout(requestStop,45*60*1000)');
  const finalStart=source.lastIndexOf('  finally {');expect(finalStart).toBeGreaterThan(end);const final=source.slice(finalStart),groups=final.indexOf('await stopOwned(activeJob);await stopOwned(server)'),handles=final.indexOf('if(postgresApp)await postgresApp.end()'),publish=final.indexOf('fs.writeFileSync(temporary');
  expect(groups).toBeGreaterThan(0);expect(handles).toBeGreaterThan(groups);expect(publish).toBeGreaterThan(handles);expect(final).toContain("outcome:runFailed?'failed':'stopped'");expect(final).toContain('cleanupSucceeded:true');expect(final).toContain("fs.renameSync(temporary,path.join(out,'browser-stopped.json'))");
  expect(source.slice(0,finalStart)).not.toContain("writeFileSync(path.join(out,'browser-stopped.json')");
  const defaultBranch=source.slice(end,source.indexOf('    env.DEV_USER_ID=preparedFixture',end));expect(defaultBranch).toContain('drizzle-kit');expect(defaultBranch).toContain('db/seed.ts');expect(defaultBranch).toContain("['browser-fixture-first','browser-fixture-second']");
 });
});
