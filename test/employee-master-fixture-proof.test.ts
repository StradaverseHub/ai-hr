import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {decidePayrollPermission} from '../lib/payroll-permissions';
import type {createDb} from '../db/client';
import {REPORT_SETUP_TABLES,readEmployeeMasterFixtureProof,reportFixtureCanonical,reportFixtureDigest,reportFixtureUrls} from '../scripts/employee-master-fixture-proof.mjs';
const primary='12345678-1111-4111-8111-123456789abc',foreign='12345678-2222-4222-8222-123456789abc';
const valid={ALLOW_DEMO_SESSION:'true',TEST_DB_NAMESPACE:'board18reports',DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_board18_reports_browser',MIGRATION_DATABASE_URL:'postgres://postgres@localhost:5433/ai_hr_board18_reports_browser'};
describe('Reports18 exact disposable target boundary',()=>{
 it('accepts a local passwordless restricted role without changing its authority',()=>{expect(reportFixtureUrls(valid).app.username).toBe('ai_hr_app');});
 it.each([
  {DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr'},
  {DATABASE_URL:'postgres://ai_hr_app@remote.test:5433/ai_hr_board18_reports_browser'},
  {DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_board18_reports_browser'},
  {MIGRATION_DATABASE_URL:valid.DATABASE_URL},
  {DATABASE_URL:valid.DATABASE_URL+'?options=anything'},
  {DATABASE_URL:valid.DATABASE_URL+'#fragment'},
  {MIGRATION_DATABASE_URL:'postgres://postgres@[::1]:5433/ai_hr_board18_reports_browser'},
  {NODE_ENV:'production'},{AUTH_PROVIDER:'internal'},{WORKOS_API_KEY:'real'},
  {KEYCLOAK_CLIENT_SECRET:'real'},{DEV_TENANT_ID:primary},{DEV_USER_ID:primary},{TEST_DB_NAMESPACE:'other'},{ALLOW_DEMO_SESSION:'false'},
 ])('refuses unsafe or ambiguous target override %j',override=>{expect(()=>reportFixtureUrls({...valid,...override})).toThrow();});
 it('keeps A/B allowed when the actual override tier denies only the no-salary role',()=>{
  const overrides=[{role:'hr_admin',allowed:true,companyScoped:false},{role:'super_admin',allowed:false,companyScoped:false}];
  expect(decidePayrollPermission({key:'report.read.compensation',callerRoles:['hr_admin'],overrides})).toBe(true);
  expect(decidePayrollPermission({key:'report.read.compensation',callerRoles:['super_admin'],overrides})).toBe(false);
 });
 it('hashes object-key order canonically while retaining ordered register identities',()=>{
  expect(reportFixtureDigest({a:1,b:{c:2,d:3}})).toBe(reportFixtureDigest({b:{d:3,c:2},a:1}));
  expect(reportFixtureDigest([{id:'a'},{id:'b'}])).not.toBe(reportFixtureDigest([{id:'b'},{id:'a'}]));
  expect(reportFixtureCanonical({text:'000123',value:123})).toContain('"000123"');
 });
});
// Unit reader supplies only an explicit client. No DB owner/session is mocked as authorised.
function reader(options:{database?:string;readOnly?:string;isolation?:string;extraTenant?:boolean;overflow?:boolean}={}){
 const statements:string[]=[];
 const tx=Object.assign(async(strings:TemplateStringsArray)=>{
  const sql=strings.join('?');statements.push(sql);
  if(sql.includes('current_database'))return [{database:options.database??'ai_hr_board18_reports_browser',read_only:options.readOnly??'on',isolation:options.isolation??'repeatable read'}];
  if(sql.includes('public.tenant'))return [{id:'00000000-0000-0000-0000-000000000000',name:'System'},{id:primary,name:'Reports18 fictional primary tenant'},{id:foreign,name:'Reports18 fictional foreign tenant'},...(options.extraTenant?[{id:'unowned',name:'foreign data'}]:[])];
  return [];
 },{unsafe:async(sql:string,values:unknown[])=>{statements.push(sql);expect(values).toEqual([primary,foreign]);return options.overflow?Array.from({length:10001},()=>({row:{}})):[];}});
 const client={begin:async(mode:string,callback:(sql:typeof tx)=>Promise<unknown>)=>{expect(mode).toBe('isolation level repeatable read read only');return callback(tx);}};
 return {value:{client} as unknown as Pick<ReturnType<typeof createDb>,'client'>,statements};
}
describe('read-only Reports setup proof',()=>{
 it('uses one explicit read-only snapshot and closed source inventory without touching saved browser work',async()=>{
  const mock=reader(),proof=await readEmployeeMasterFixtureProof(mock.value,{tenantId:primary,foreignTenantId:foreign});
  expect(proof.version).toBe(1);expect(proof.metadataDigest).toMatch(/^[a-f0-9]{64}$/);expect(proof.tables.map(row=>row.table)).toContain('domain_event:personnel-source-only');
  for(const sql of mock.statements)expect(sql.trim()).toMatch(/^select /i);
  expect(REPORT_SETUP_TABLES).not.toContain('custom_report');expect(mock.statements.join(' ')).not.toMatch(/custom_report|internal_auth|notification_pref|app_external_identity/i);
 });
 it.each([{database:'ai_hr'},{readOnly:'off'},{isolation:'read committed'},{extraTenant:true},{overflow:true}])('refuses a false snapshot or unbounded inventory %j',async options=>{
  const mock=reader(options);await expect(readEmployeeMasterFixtureProof(mock.value,{tenantId:primary,foreignTenantId:foreign})).rejects.toThrow();
 });
 it('refuses invalid or same tenant identities before any SQL',async()=>{
  const mock=reader();await expect(readEmployeeMasterFixtureProof(mock.value,{tenantId:primary,foreignTenantId:primary})).rejects.toThrow();expect(mock.statements).toEqual([]);
 });
});

describe('Reports fixture executable safety contract',()=>{
 it('holds fresh-only setup behind the exact coordinator and imports no report/delivery executor',()=>{
  const source=readFileSync(path.join(process.cwd(),'scripts/dev-fixture-employee-master.mts'),'utf8');
  const imports=source.indexOf("await import('../db/client')"),sourceCandidate=source.indexOf('const sourceCandidate=candidate()');
  expect(imports).toBeGreaterThanOrEqual(0);expect(sourceCandidate).toBeGreaterThanOrEqual(0);
  expect(sourceCandidate).toBeLessThan(imports);expect(imports).toBeGreaterThan(1000);
  const guards=source.slice(0,imports);expect(guards.length).toBeGreaterThan(1000);
  expect(guards).toContain('REPORT_FIXTURE_COORDINATOR_PID');
  for(const name of ['board18reports-browser-a','board18reports-browser-b','board18reports-browser-db'])expect(guards).toContain(name);
  const priorStart=source.indexOf('if(previousText){'),tenantsEnd=source.indexOf('const tenants=');
  expect(priorStart).toBeGreaterThanOrEqual(0);expect(tenantsEnd).toBeGreaterThanOrEqual(0);
  expect(tenantsEnd).toBeGreaterThan(priorStart);expect(tenantsEnd-priorStart).toBeGreaterThan(300);
  const prior=source.slice(priorStart,tenantsEnd);expect(prior.length).toBeGreaterThan(300);
  expect(prior).toContain('await readEmployeeMasterFixtureProof');expect(prior).toContain('return;');
  expect(prior).not.toMatch(/owner\.db\.(insert|update|delete)|provisionTenant|hireEmployee/);
  expect([...source.matchAll(/owner\.db\.insert\(s\.(\w+)\)/g)].map(match=>match[1])).toEqual(['appUser','roleAssignment','appUser']);
  expect(source).not.toMatch(/owner\.db\.(update|delete)|TRUNCATE|DROP DATABASE|saveEmployeeMasterReport|runEmployeeMasterReport|internal_auth_record|notification_pref|sendSmtp/);
  expect(source).toContain('assertReportFixtureConnections(await readReportFixtureConnections(client,owner.client)');
  const connection=readFileSync(path.join(process.cwd(),'scripts/report-fixture-connection.mjs'),'utf8');
  expect(connection.match(/host\(inet_server_addr\(\)\) as server_addr/g)).toHaveLength(2);
  for(const guard of ['owner.server_addr!==app.server_addr','owner.server_port!==app.server_port','owner.database_oid!==app.database_oid',"['127.0.0.1','::1'].includes(app.server_addr)","app?.name!=='ai_hr_app'",'app.rolsuper','app.rolbypassrls'])expect(connection).toContain(guard);
 });
});
