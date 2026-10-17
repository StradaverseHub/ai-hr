import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {original18BrowserTarget} from '../scripts/original18-browser-target.mjs';
import {REPORTS_MIGRATION_ATTEMPT,REPORTS_RECOVERY_NAME,validateReportsRecoveryFiles,validateReportsRecoveryNames,validateReportsMigrationSnapshot,readReportsRecoverySourceProof} from '../scripts/reports-migration-only-recovery.mjs';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const inventory=JSON.parse(readFileSync(new URL('../scripts/reports-migration-only-inventory.json',import.meta.url),'utf8'));
const journal=(JSON.parse(readFileSync(new URL('../db/migrations/meta/_journal.json',import.meta.url),'utf8')).entries as {tag:string;when:number}[]).map(row=>({...row,sha256:hash(readFileSync(new URL('../db/migrations/'+row.tag+'.sql',import.meta.url)))}));
function snapshot(){
 const shared={name:'ai_hr_app',database:REPORTS_MIGRATION_ATTEMPT.database,server_addr:'127.0.0.1',server_port:5433,database_oid:REPORTS_MIGRATION_ATTEMPT.databaseOid};
 return {connections:{application:{...shared,rolsuper:false,rolbypassrls:false},migration:{...shared,name:'postgres'}},readOnly:'on',isolation:'repeatable read',tenants:[{id:'00000000-0000-0000-0000-000000000000',name:'System (auth audit)',workosOrgId:'org_system_auth_audit'}],applied:journal.map(row=>({hash:row.sha256,created_at:String(row.when)})),inventory:structuredClone(inventory)};
}
describe('one reviewed Reports migration-only recovery',()=>{
 it('requires the explicit Reports-only mode and leaves ordinary fresh/resume mode unchanged',()=>{
  expect(original18BrowserTarget(['--scenario=reports','--recover-migration-only-reports'])).toMatchObject({recoverMigrationOnly:true,resume:false,fresh:true});
  expect(original18BrowserTarget(['--scenario=reports'])).not.toHaveProperty('recoverMigrationOnly');
  expect(original18BrowserTarget(['--scenario=reports','--resume'])).toMatchObject({resume:true});
  for(const args of [['--scenario=labels','--recover-migration-only-reports'],['--scenario=reports','--resume','--recover-migration-only-reports'],['--scenario=reports','--recover-migration-only-reports','--recover-migration-only-reports']])expect(()=>original18BrowserTarget(args)).toThrow();
 });
 it('pins every original attempt/log byte declaration without replacing old evidence',()=>{
  expect(()=>validateReportsRecoveryFiles(structuredClone(REPORTS_MIGRATION_ATTEMPT.files))).not.toThrow();
  for(const index of [0,1,2,3]){const files=REPORTS_MIGRATION_ATTEMPT.files.map(row=>({...row,sha256:String(row.sha256)}));files[index].sha256='f'.repeat(64);expect(()=>validateReportsRecoveryFiles(files)).toThrow();}
 });
 it('refuses completed/partial setup, unknown attempts or any earlier recovery admission',()=>{
  const original=REPORTS_MIGRATION_ATTEMPT.files.map(row=>row.fileName);
  expect(()=>validateReportsRecoveryNames(original)).not.toThrow();
  for(const forbidden of ['fixture-manifest.json','browser-manifest.json','browser.pid','browser-stopped.json',REPORTS_RECOVERY_NAME,'browser-resume-unknown.json','other-browser-fixture-second.log','other-browser-fixture-first.log','other-browser-migrate.log'])expect(()=>validateReportsRecoveryNames([...original,forbidden]),forbidden).toThrow();
 });
 it('requires the exact whole 289-table migration-only snapshot, preserving six seeded reference tables',()=>{
  const actual=snapshot();expect(actual.inventory).toHaveLength(289);
  expect(actual.inventory.filter((row:{rows:number})=>row.rows).map((row:{name:string})=>row.name)).toEqual(['dashboard_card_config','module','payroll_import_code','profile_option','setting_definition','tenant']);
  expect(()=>validateReportsMigrationSnapshot(actual,journal)).not.toThrow();
  for(const table of ['app_user','app_internal_auth_record','company','person','employment','custom_report','custom_report_run']){const changed=snapshot();const row=changed.inventory.find((item:{name:string})=>item.name===table);expect(row,table).toBeDefined();row.rows=1;expect(()=>validateReportsMigrationSnapshot(changed,journal)).toThrow();}
  const reference=snapshot();reference.inventory.find((row:{name:string})=>row.name==='profile_option').digest='f'.repeat(64);expect(()=>validateReportsMigrationSnapshot(reference,journal)).toThrow();
  const unknown=snapshot();unknown.inventory.push({name:'unknown_table',rows:0,digest:'f'.repeat(64)});expect(()=>validateReportsMigrationSnapshot(unknown,journal)).toThrow();
 });
 it('refuses changed journal hashes/order/count, System identity, database identity or non-read-only snapshots',()=>{
  for(const mode of ['hash','order','count','tenant','OID','read-only']){
   const actual=snapshot();
   if(mode==='hash')actual.applied[0].hash='f'.repeat(64);
   if(mode==='order')actual.applied.reverse();
   if(mode==='count')actual.applied.pop();
   if(mode==='tenant')actual.tenants[0].name='Other';
   if(mode==='OID')actual.connections.application.database_oid='1';
   if(mode==='read-only')actual.readOnly='off';
   expect(()=>validateReportsMigrationSnapshot(actual,journal),mode).toThrow();
  }
 });
 it('reads actual Git source pins with enough buffer for the real schema',async()=>{
  const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{maxBuffer:16000000}).toString().trim();
  const proof=await readReportsRecoverySourceProof(root,head);
  expect(proof.some((row:{path:string})=>row.path==='scripts/report-fixture-connection.mjs')).toBe(true);
  expect(proof.find((row:{path:string})=>row.path==='db/schema.ts')).toMatchObject({oldSha256:proof.find((row:{path:string})=>row.path==='db/schema.ts').sha256});
 });
 it('retains existing fresh refusal and writes one recovery admission before only canonical fixture runs',()=>{
  const source=readFileSync(new URL('../scripts/dev-browser-original18.mjs',import.meta.url),'utf8');
  expect(source).toContain("'--recover-migration-only-reports'");
  const start=source.indexOf('      if(options.recoverMigrationOnly){'),end=source.indexOf('      }else{',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const branch=source.slice(start,end);expect(branch.length).toBeGreaterThan(500);
  expect(branch).toContain('await proveRoles()');expect(branch).toContain('writeNew(recovery.name,recovery.value)');
  for(const forbidden of ['CREATE DATABASE','await run(','drizzle-kit','db/seed'])expect(branch).not.toContain(forbidden);
  expect(source).toContain("if(['preparation-attempt.json','fixture-manifest.json','browser-manifest.json','browser-stopped.json','browser.pid'].some");
  expect(source).toContain('recoveryAdmission:reportsRecovery,migrationRunsThisCandidate:0,seedRunsThisCandidate:0');
 });
});
