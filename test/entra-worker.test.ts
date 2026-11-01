import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {client} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {saveConnector} from '../lib/entra/store';
import {sourceId,type EntraConfig} from '../lib/entra/model';
import {runEntraWorker} from '../lib/entra/worker';
import {createEntraSession,readEntraSession} from '../lib/entra/sessions';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function setup(mode:'cloud'|'hybrid',hiredOn='2020-01-01'){
 const config:EntraConfig={tenantId:base.tenantId,organization:'worker',directoryTenantId:randomUUID(),clientId:randomUUID(),clientSecret:'private',provisioningClientId:randomUUID(),provisioningClientSecret:'private',servicePrincipalId:randomUUID(),jobId:'job-1',mode,domain:'company.test',sourceAnchorAttribute:mode==='hybrid'?'onPremisesExtensionAttributes.extensionAttribute15':'extension_'+'a'.repeat(32)+'_hrSourceId',enabled:true,provisioningEnabled:true,immutableMatchingConfirmed:true,revision:randomUUID()};
 await saveConnector(adminCtx(base),config,null);
 const employee=await hireEmployee(adminCtx(base),{person:{fullName:'Worker Employee',primaryEmail:'worker@contact.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn});
 const object=randomUUID(),state={active:true,synced:mode==='cloud',missing:false};
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/token'))return Response.json({access_token:'graph-fixture'});
  if(url.endsWith('/bulkUpload'))return new Response(null,{status:202,headers:{location:'https://graph.microsoft.com/v1.0/auditLogs/provisioning/?$filter=jobId%20eq%20%27job-1%27'}});
  if(url.includes('/auditLogs/provisioning'))return Response.json({value:[{jobId:config.jobId,tenantId:config.directoryTenantId,activityDateTime:new Date().toISOString(),servicePrincipal:{id:config.servicePrincipalId},sourceIdentity:{id:sourceId(base.tenantId,employee.personId)},provisioningStatusInfo:{status:'success'},targetIdentity:{id:object}}]});
  if(url.includes('/users/')){
   if(state.missing)return new Response(null,{status:404});
   return Response.json({id:object,displayName:'Worker Employee',accountEnabled:state.active,onPremisesSyncEnabled:state.synced,...(mode==='hybrid'?{onPremisesExtensionAttributes:{extensionAttribute15:sourceId(base.tenantId,employee.personId)}}:{[config.sourceAnchorAttribute]:sourceId(base.tenantId,employee.personId)})});
  }
  throw Error('Unexpected external endpoint');
 });
 const status=async()=>String((await owner.client`select status from entra_workforce where person_id=${employee.personId}`)[0].status);
 const next=async()=>{await owner.client`update entra_workforce set next_at=now() where person_id=${employee.personId}`;await runEntraWorker(1,fetcher);};
 return {config,employee,object,state,fetcher,status,next};
}
describe('actual durable worker with mocked Microsoft boundary',()=>{
 it('provisions a cloud employee, confirms the exact object, and blocks retained HR access on termination before directory processing',async()=>{
  const f=await setup('cloud');await f.next();expect(await f.status()).toBe('submitted');await f.next();expect(await f.status()).toBe('ready');
  const tokens=await createEntraSession(f.config,f.object,true);expect(await readEntraSession(tokens.access_token,true)).not.toBeNull();
  const date=new Date(todayInKualaLumpur()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-1);
  await owner.client`update employment set terminated_on=${date.toISOString().slice(0,10)} where person_id=${f.employee.personId}`;
  expect(await readEntraSession(tokens.access_token,true)).toBeNull();
  await f.next();const calls=f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/bulkUpload'));expect(JSON.parse(String(calls.at(-1)![1]?.body)).Operations[0].data.active).toBe(false);
  f.state.active=false;await f.next();expect(await f.status()).toBe('disabled');
 });
 it('does not declare hybrid readiness until the exact AD-sourced Entra object is synced',async()=>{
  const f=await setup('hybrid');await f.next();await f.next();expect(await f.status()).toBe('awaiting-sync');
  expect(await owner.client`select id from app_user where person_id=${f.employee.personId}`).toHaveLength(0);
  f.state.synced=true;await f.next();expect(await f.status()).toBe('ready');
 });
 it('holds an upload with an uncertain outcome instead of creating again',async()=>{
  const f=await setup('cloud');f.fetcher.mockImplementationOnce(async()=>Response.json({access_token:'token'})).mockImplementationOnce(async()=>{throw Error('Connection lost after sending');});
  await f.next();expect(await f.status()).toBe('uncertain');const count=f.fetcher.mock.calls.length;await f.next();expect(f.fetcher.mock.calls.length).toBe(count);expect(await f.status()).toBe('uncertain');
 });
 it('provisions directory accounts independently of Microsoft sign-in without creating an HR login',async()=>{
  const f=await setup('cloud');await saveConnector(adminCtx(base),{...f.config,enabled:false,revision:randomUUID()},f.config.revision);
  await f.next();await f.next();expect(await f.status()).toBe('ready');
  expect(await owner.client`select id from app_user where person_id=${f.employee.personId}`).toHaveLength(0);
 });

 it('preprovisions a future hire disabled without granting an HR login before their start date',async()=>{
  const date=new Date(todayInKualaLumpur()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+10);
  const f=await setup('cloud',date.toISOString().slice(0,10));f.state.active=false;
  await f.next();await f.next();expect(await f.status()).toBe('disabled');
  expect(await owner.client`select id from app_user where person_id=${f.employee.personId}`).toHaveLength(0);
 });

});
