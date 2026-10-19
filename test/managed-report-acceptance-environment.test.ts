/** Pure fixture authority projection checks. No credentials, database, VM or scheduling admission. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {LEGACY_MODULE_ENV_GATES,LEGACY_SETTING_ENV_GATES} from '../packs/catalog';
import {reportAcceptanceEnvironmentProjection} from '../scripts/managed-report-acceptance-model';

const authority=['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY','DATABASE_URL'] as const;
const gates=[...new Set([...Object.values(LEGACY_MODULE_ENV_GATES),...Object.values(LEGACY_SETTING_ENV_GATES)])].filter((name):name is string=>typeof name==='string'&&name.length>0);
const web:Record<string,string>={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://localhost:3543',AUTH_SESSION_KEY:'fictional-session-key',DATABASE_URL:'postgres://fictional-app@127.0.0.1/fictional-db'};
const migration='postgres://fictional-owner@127.0.0.1/fictional-db';
// Apply the returned plan to an isolated env-shaped object, just as the source-pinned caller does.
function project(target:Record<string,string|undefined>,activeWeb:Record<string,string>=web){
 const plan=reportAcceptanceEnvironmentProjection({...target},activeWeb,migration);
 for(const name of plan.clear)Reflect.deleteProperty(target,name);
 Object.assign(target,plan.assign);
 return target;
}

describe('managed report fixture caller snapshot and environment projection',()=>{
 it.each(authority)('refuses a caller override of %s before any mutation and without printing values',name=>{
  const override='fictional-private-override-'+name;
  const target={...web,[name]:override,DEV_TENANT_ID:'caller-demo',UNRELATED:'keep'};
  const before={...target};
  expect(()=>project(target)).toThrow('Caller cannot override active web Auth/database authority.');
  try{project(target);}catch(error){expect((error as Error).message).not.toContain(override);}
  expect(target).toEqual(before);
 });
 it.each([{},web])('accepts absent or matching caller authority and uses the reviewed web values',caller=>{
  const frozenCaller=Object.freeze({...caller}),frozenWeb=Object.freeze({...web});
  const plan=reportAcceptanceEnvironmentProjection(frozenCaller,frozenWeb,migration);
  for(const name of authority)expect(plan.assign[name]).toBe(web[name]);
  expect(frozenCaller).toEqual(caller);expect(frozenWeb).toEqual(web);
 });
 it('clears every catalog gate missing from the active web, including a caller-enabled audit chain',()=>{
  expect(gates.length).toBeGreaterThan(0);expect(gates).toContain('AUDIT_HASH_CHAIN_ENABLED');
  const target:Record<string,string|undefined>=Object.fromEntries(gates.map(name=>[name,'true']));
  target.UNRELATED='keep';const identity=target;
  const plan=reportAcceptanceEnvironmentProjection({...target},web,migration);
  expect([...plan.clear].sort()).toEqual([...gates,'EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','DEV_TENANT_ID','DEV_USER_ID'].sort());
  expect(project(target)).toBe(identity);
  for(const name of gates)expect(Object.hasOwn(target,name),name).toBe(false);
  expect(target.UNRELATED).toBe('keep');
 });
 it.each(['false','true','nonboolean-reviewed-value'])('copies every present catalog input exactly as %s without interpreting entitlement',value=>{
  const activeWeb={...web,...Object.fromEntries(gates.map(name=>[name,value]))};
  const target:Record<string,string|undefined>={};project(target,activeWeb);
  for(const name of gates)expect(target[name],name).toBe(value);
 });
 it('keeps absent and present gate states distinct in the same projection',()=>{
  expect(gates).toEqual(expect.arrayContaining(['AUDIT_HASH_CHAIN_ENABLED','NOTIFICATIONS_ENABLED']));
  const activeWeb={...web,AUDIT_HASH_CHAIN_ENABLED:'false'},target:Record<string,string|undefined>={AUDIT_HASH_CHAIN_ENABLED:'true',NOTIFICATIONS_ENABLED:'true'};
  project(target,activeWeb);expect(target.AUDIT_HASH_CHAIN_ENABLED).toBe('false');expect(Object.hasOwn(target,'NOTIFICATIONS_ENABLED')).toBe(false);
 });
 it('retains env identity and unrelated caller inputs, clears demo identities and uses only reviewed authority',()=>{
  const target:Record<string,string|undefined>={UNRELATED:'keep',DEV_TENANT_ID:'demo-tenant',DEV_USER_ID:'demo-user',ALLOW_DEMO_SESSION:'true',NODE_ENV:'development',MIGRATION_DATABASE_URL:'caller-owner'};
  const identity=target;project(target,{...web,UNRELATED:'web-must-not-copy',EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:'true',UNREVIEWED_AUTH_BYPASS:'true'});
  expect(target).toBe(identity);expect(target.UNRELATED).toBe('keep');
  expect(Object.hasOwn(target,'DEV_TENANT_ID')).toBe(false);expect(Object.hasOwn(target,'DEV_USER_ID')).toBe(false);
  expect(target.ALLOW_DEMO_SESSION).toBe('false');expect(target.NODE_ENV).toBe('production');expect(target.MIGRATION_DATABASE_URL).toBe(migration);
  expect(target.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe('true');expect(Object.hasOwn(target,'UNREVIEWED_AUTH_BYPASS')).toBe(false);
 });
 it.each([undefined,'false','TRUE','1',' true','true ','true'])('derives a closed scheduling literal from actual-web value %s',value=>{
  const activeWeb={...web,...(value===undefined?{}:{EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value})};
  const target:Record<string,string|undefined>={};const plan=reportAcceptanceEnvironmentProjection(target,activeWeb,migration);
  expect(plan.clear).toContain('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED');project(target,activeWeb);
  expect(target.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe(value==='true'?'true':'false');
 });
 it.each(['true','false'])('accepts only a matching canonical caller capability %s',value=>{
  const target:Record<string,string|undefined>={EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value};project(target,{...web,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value});expect(target.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe(value);
 });
 it.each([{web:'true',caller:'false'},{web:'false',caller:'true'},{web:undefined,caller:'true'},{web:'TRUE',caller:'TRUE'},{web:'true',caller:' true'},{web:'false',caller:''}])('refuses a caller capability override before mutation %j',value=>{
  const activeWeb={...web,...(value.web===undefined?{}:{EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value.web})},target={UNRELATED:'keep',DEV_USER_ID:'untouched',EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value.caller},before={...target};
  expect(()=>project(target,activeWeb)).toThrow('Caller cannot override active web report scheduling capability.');expect(target).toEqual(before);
 });
 it('preserves an explicitly supplied active web NODE_ENV rather than the caller value',()=>{
  const target={NODE_ENV:'caller-value'};project(target,{...web,NODE_ENV:'development'});expect(target.NODE_ENV).toBe('development');
 });
 it('validates a copied caller snapshot and applies the plan before importing database runtime',()=>{
  const source=readFileSync(join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
  const start=source.indexOf(' const environment=reportAcceptanceEnvironmentProjection({...process.env},web,migration.toString());');
  const clear=source.indexOf('for(const name of environment.clear)Reflect.deleteProperty(process.env,name);',start);
  const assign=source.indexOf('Object.assign(process.env,environment.assign);',start);
  const database=source.indexOf("const dbModule=await import('../db/client')",start);
  expect(start).toBeGreaterThanOrEqual(0);expect(clear).toBeGreaterThan(start);expect(assign).toBeGreaterThan(clear);expect(database).toBeGreaterThan(assign);
 });
});
