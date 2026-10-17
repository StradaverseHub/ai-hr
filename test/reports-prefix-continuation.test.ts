import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {original18BrowserTarget} from '../scripts/original18-browser-target.mjs';
import {REPORTS_PREFIX_ADMISSION,REPORTS_PREFIX_ORIGINAL_FILES,validateReportsPrefixNames,validateReportsPrefixSnapshot,validateReportsPrefixAdmission} from '../scripts/reports-prefix-continuation.mjs';
const read=(name:string)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const hash=(bytes:string)=>createHash('sha256').update(bytes).digest('hex');
const inventory=JSON.parse(read('scripts/reports-prefix-inventory.json')) as {name:string;rows:number;digest:string}[];
const journal=(JSON.parse(read('db/migrations/meta/_journal.json')).entries as {tag:string;when:number}[]).map(row=>({...row,sha256:hash(read('db/migrations/'+row.tag+'.sql'))}));
const bound={root:'/fictional/owned-worktree',candidate:'a'.repeat(40),coordinatorPid:1234};
function snapshot(){const shared={name:'ai_hr_app',database:'ai_hr_board18_reports_browser',server_addr:'127.0.0.1',server_port:5433,database_oid:'218928'};return {connections:{application:{...shared,rolsuper:false,rolbypassrls:false},migration:{...shared,name:'postgres'}},readOnly:'on',isolation:'repeatable read',fullVisibility:true,inventory:structuredClone(inventory),applied:journal.map(row=>({hash:row.sha256,created_at:String(row.when)}))};}
function admission(){return {format:1,kind:'reviewed-reports-prefix-continuation',...bound,originalCandidate:'c260108d3ca8d9ad28954450a5162eeed1c7a1ed',database:'ai_hr_board18_reports_browser',databaseOid:'218928',namespace:'board18reports',port:3197,inventorySha256:hash(read('scripts/reports-prefix-inventory.json')),bindingsSha256:hash(read('scripts/reports-prefix-bindings.json')),originalFiles:REPORTS_PREFIX_ORIGINAL_FILES.map(row=>({...row})),migrationRuns:0,seedRuns:0,provisioningRuns:0,companyCreationRuns:0,fixtureOutcome:'UNRUN',applicationAcceptance:'UNVERIFIED'};}
describe('one reviewed Reports provisioned-prefix continuation',()=>{
 it('admits only explicit Reports continuation, preserving ordinary fresh/resume modes',()=>{
  expect(original18BrowserTarget(['--scenario=reports','--continue-reports-prefix'])).toMatchObject({continueReportsPrefix:true,resume:false});
  expect(original18BrowserTarget(['--scenario=reports'])).not.toHaveProperty('continueReportsPrefix');
  expect(original18BrowserTarget(['--scenario=reports','--resume'])).not.toHaveProperty('continueReportsPrefix');
  for(const args of [['--scenario=labels','--continue-reports-prefix'],['--scenario=reports','--continue-reports-prefix','--resume'],['--scenario=reports','--continue-reports-prefix','--recover-migration-only-reports'],['--scenario=reports','--continue-reports-prefix','--continue-reports-prefix']])expect(()=>original18BrowserTarget(args)).toThrow();
 });
 it('preserves exact captured bootstrap and organisation rows while requiring every business/actor table unchanged',()=>{
  expect(inventory).toHaveLength(289);
  for(const [name,rows] of [['tenant',3],['company',6],['department',5],['person',2],['app_user',4],['role_assignment',2],['employment',0]] as const)expect(inventory.find(row=>row.name===name)?.rows,name).toBe(rows);
  expect(()=>validateReportsPrefixSnapshot(snapshot(),journal)).not.toThrow();
  for(const name of ['tenant','company','department','person','app_user','role_assignment','employment','custom_report','custom_report_run']){
   for(const field of ['rows','digest']){const changed=snapshot(),row=changed.inventory.find(row=>row.name===name)!;expect(row,name).toBeDefined();if(field==='rows')row.rows++;else row.digest='f'.repeat(64);expect(()=>validateReportsPrefixSnapshot(changed,journal),name+field).toThrow();}
  }
  const changed=snapshot();changed.inventory.push({name:'unknown_table',rows:0,digest:'f'.repeat(64)});expect(()=>validateReportsPrefixSnapshot(changed,journal)).toThrow();
 });
 it('requires ordered authentic applied migrations, full read-only visibility and the same loopback role/OID',()=>{
  const first=journal.findIndex(row=>row.tag==='0230_delegation_scope_reason');expect(first).toBeGreaterThanOrEqual(0);expect(journal[first+1].tag).toBe('0240_employment_blacklist');expect(journal[first].when).toBeGreaterThan(journal[first+1].when);
  for(const mode of ['order','hash','count','when','OID','readOnly','isolation','visibility','role','address']){const changed=snapshot();
   if(mode==='order')[changed.applied[first],changed.applied[first+1]]=[changed.applied[first+1],changed.applied[first]];
   if(mode==='hash')changed.applied[first].hash='f'.repeat(64);if(mode==='count')changed.applied.pop();if(mode==='when')changed.applied[first].created_at='1';
   if(mode==='OID')changed.connections.application.database_oid='1';if(mode==='readOnly')changed.readOnly='off';if(mode==='isolation')changed.isolation='read committed';if(mode==='visibility')changed.fullVisibility=false;if(mode==='role')changed.connections.application.rolbypassrls=true;if(mode==='address')changed.connections.application.server_addr='203.0.113.1';
   expect(()=>validateReportsPrefixSnapshot(changed,journal),mode).toThrow();
  }
 });
 it('binds one immutable admission to current source, coordinator, preserved evidence and zero setup claims',()=>{
  expect(()=>validateReportsPrefixAdmission(admission(),bound)).not.toThrow();
  for(const field of ['root','candidate','coordinatorPid','originalCandidate','database','databaseOid','namespace','port','inventorySha256','bindingsSha256','migrationRuns','seedRuns','provisioningRuns','companyCreationRuns','fixtureOutcome','applicationAcceptance']){
   const changed:Record<string,unknown>=admission();changed[field]=typeof changed[field]==='number'?999:'drift';expect(()=>validateReportsPrefixAdmission(changed,bound),field).toThrow();
  }
  const changed=admission();changed.originalFiles[0]={...changed.originalFiles[0],sha256:'f'.repeat(64)};expect(()=>validateReportsPrefixAdmission(changed,bound)).toThrow();
  expect(()=>validateReportsPrefixAdmission(admission(),{...bound,coordinatorPid:1})).toThrow();
 });
 it('rejects a consumed admission, completed setup or another preparation attempt before writers',()=>{
  const originals=REPORTS_PREFIX_ORIGINAL_FILES.map(row=>row.fileName);expect(()=>validateReportsPrefixNames(originals)).not.toThrow();
  for(const extra of [REPORTS_PREFIX_ADMISSION,'fixture-manifest.json','browser-manifest.json','browser.pid','browser-stopped.json','browser-resume-any.json','other-browser-fixture-first.log','other-browser-fixture-second.log','other-browser-migrate.log','other-drizzle.config.ts'])expect(()=>validateReportsPrefixNames([...originals,extra]),extra).toThrow();
 });
 it('keeps continuation before canonical writers and second invocation a completed read-only proof',()=>{
  const fixture=read('scripts/dev-fixture-employee-master.mts'),runner=read('scripts/dev-browser-original18.mjs'),helper=read('scripts/reports-prefix-continuation.mjs');
  expect(fixture.indexOf('readReportsFixturePrefix(')).toBeLessThan(fixture.indexOf('const primary=prefix?'));
  const restore=fixture.slice(fixture.indexOf(' async function restoreProvision('),fixture.indexOf(" stage=prefix?'prefix-context'"));
  expect(restore).toContain('const ctx=await context(user)');for(const forbidden of ['insert(', 'update(', 'provisionTenant(', 'createCompany('])expect(restore).not.toContain(forbidden);
  expect(fixture).toContain('if(prefix){companies[key]=prefix.bindings.companies[key];continue;}');
  expect(fixture).toContain("if(continuingPrefix)throw new Error('Prefix continuation already completed");
  expect(runner).toContain("reportsPrefix&&label==='browser-fixture-first'?['--continue-reviewed-prefix']:[]");
  expect(runner).toContain("fixtureInvocationKinds:['bounded-prefix-continuation','read-only-completed-fixture-proof']");
  const start=runner.indexOf('      }else if(options.continueReportsPrefix){'),end=runner.indexOf('      }else{',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const branch=runner.slice(start,end);expect(branch).toContain('await proveRoles()');expect(branch).toContain('writeNew(continuation.name,continuation.value)');for(const forbidden of ['CREATE DATABASE','await run(','db/seed','drizzle-kit'])expect(branch).not.toContain(forbidden);
  expect(helper).toContain("order by id");expect(helper).toContain("maxBuffer:16000000");expect(helper).toContain("isolation level repeatable read read only");
 });
});
