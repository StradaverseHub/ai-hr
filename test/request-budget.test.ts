import {createHash} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {client} from '../db/client';
import {createRequestAdmission,createScopedAdmission,RequestBudgetExceeded,takeRequestBudget,trustedRequestSource} from '../lib/request-budget';
import {mobileRoute} from '../lib/mobile-api/handler';
import {AuthRequiredError} from '../lib/auth-errors';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
beforeAll(migrateTestDb);
beforeEach(resetDb);
afterAll(closeAll);
afterEach(()=>vi.unstubAllEnvs());
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

describe('shared request token buckets',()=>{
  it('serializes first-use concurrency across independent calls and refills by elapsed time',async()=>{
    const key=hash('concurrent');
    const results=await Promise.all(Array.from({length:8},()=>client.unsafe('select app.consume_request_budget($1,3,60) wait',[key])));
    expect(results.filter(rows=>rows[0].wait===0)).toHaveLength(3);
    expect(results.filter(rows=>rows[0].wait>0)).toHaveLength(5);
    await owner.db.execute(sql`update app_request_budget set updated_at=clock_timestamp()-interval '60 seconds' where budget_key=${key}`);
    expect((await client.unsafe('select app.consume_request_budget($1,3,60) wait',[key]))[0].wait).toBe(0);
  });
  it('isolates actor/tenant budgets and exposes no raw identity or direct table access',async()=>{
    await takeRequestBudget(['actor','tenant-A','user-A'],1,60);
    await expect(takeRequestBudget(['actor','tenant-A','user-A'],1,60)).rejects.toBeInstanceOf(RequestBudgetExceeded);
    await expect(takeRequestBudget(['actor','tenant-A','user-B'],1,60)).resolves.toBeUndefined();
    await expect(takeRequestBudget(['actor','tenant-B','user-A'],1,60)).resolves.toBeUndefined();
    const rows=await owner.db.execute(sql`select budget_key from app_request_budget`);
    expect(rows.length).toBe(3);for(const row of rows)expect(row.budget_key).toMatch(/^[a-f0-9]{64}$/);
    await expect(client.unsafe('select * from app_request_budget')).rejects.toThrow(/permission denied/i);
  });
  it('rejects malformed/function-abuse inputs and reclaims expired rows',async()=>{
    await expect(client.unsafe("select app.consume_request_budget('raw-identity',1,60)")).rejects.toThrow('Invalid request budget');
    await takeRequestBudget(['expired'],1,60);
    await owner.db.execute(sql`update app_request_budget set expires_at=clock_timestamp()-interval '1 second'`);
    await takeRequestBudget(['new'],1,60);
    expect((await owner.db.execute(sql`select count(*)::int n from app_request_budget`))[0].n).toBe(1);
  });
});

describe('request boundaries',()=>{
  it('does not amplify expected authentication or rate refusals into failure logs',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const unauthorized=await mobileRoute(z.object({ok:z.boolean()}),async()=>({ok:true}),async()=>{throw new AuthRequiredError('SYNTHETIC_PRIVATE_AUTH_DETAIL');},async()=>{})(new Request('https://hr.test/api/mobile/v1/me'));
      expect(unauthorized.status).toBe(401);expect(unauthorized.headers.has('x-aihr-support-id')).toBe(false);
      const limited=await mobileRoute(z.object({ok:z.boolean()}),async()=>({ok:true}),async()=>({tenantId:'tenant',userId:'actor'}),async()=>{throw new RequestBudgetExceeded(10);})(new Request('https://hr.test/api/mobile/v1/me'));
      expect(limited.status).toBe(429);expect(limited.headers.has('x-aihr-support-id')).toBe(false);expect(log).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
  it.each(['session','handler','contract','admission'] as const)('does not log private failure details at the %s boundary',async(stage)=>{
    const secret='SYNTHETIC_PRIVATE_HR_VALUE',failure=Object.assign(new Error(secret),{parameters:[secret],cause:{credential:secret}});
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const schema=stage==='contract'?z.object({ok:z.boolean().refine(()=>false,{message:secret})}):z.object({ok:z.boolean()});
      const resolve=async()=>{if(stage==='session')throw failure;return {tenantId:'tenant',userId:'actor'};};
      const execute=async()=>{if(stage==='handler')throw failure;return {ok:true};};
      const response=await mobileRoute(schema,execute,resolve,async()=>{if(stage==='admission')throw failure;})(new Request('https://hr.test/api/mobile/v1/clock?private='+secret));
      const logged=log.mock.calls.flatMap(args=>args.map(value=>String(value)+' '+JSON.stringify(value))).join(' ');
      expect(logged).not.toContain(secret);expect(response.status).toBe(stage==='session'||stage==='admission'?503:500);
      const reference=response.headers.get('x-aihr-support-id');expect(reference).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      expect(log.mock.calls).toEqual([['[mobile-api]',{event:'request_failed',stage,supportId:reference}]]);
      expect(logged).toContain(reference!);expect(await response.json()).toEqual({error:stage==='session'||stage==='admission'?'unavailable':'internal'});
    }finally{log.mockRestore();}
  });
  it('ignores spoofable forwarding/source headers unless the operator enables the trusted ingress',()=>{
    const req=new Request('https://hr.test',{headers:{'x-forwarded-for':'198.51.100.8','x-aihr-request-source':'198.51.100.9'}});
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE','0');expect(trustedRequestSource(req)).toBeNull();
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE','1');expect(trustedRequestSource(req)).toBe('198.51.100.9');
    expect(()=>trustedRequestSource(new Request('https://hr.test',{headers:{'x-aihr-request-source':'198.51.100.9, 198.51.100.8'}}))).toThrow('Trusted request source unavailable');
    expect(()=>trustedRequestSource(new Request('https://hr.test'))).toThrow('Trusted request source unavailable');
    expect(trustedRequestSource(new Request('https://hr.test',{headers:{'x-aihr-request-source':'2001:db8::1'}}))).toBe('2001:db8::1');
  });
  it('refuses missing trusted ingress identity before session resolution or endpoint work',async()=>{
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE','1');
    const resolve=vi.fn(async()=>({tenantId:'tenant',userId:'actor'})),execute=vi.fn(async()=>({ok:true})),budget=vi.fn();
    const response=await mobileRoute(z.object({ok:z.boolean()}),execute,resolve,budget)(new Request('https://hr.test/api/mobile/v1/me'));
    expect(response.status).toBe(503);expect(resolve).not.toHaveBeenCalled();expect(budget).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
  });
  it('bounds outstanding work and releases admission exactly once',()=>{
    const admit=createRequestAdmission(1),release=admit();expect(()=>admit()).toThrow(RequestBudgetExceeded);release();release();const second=admit();expect(()=>admit()).toThrow(RequestBudgetExceeded);second();
  });
  it('isolates concurrent scopes and removes their admission state after release',()=>{
    const admit=createScopedAdmission(1),a=admit('A'),b=admit('B');
    expect(()=>admit('A')).toThrow(RequestBudgetExceeded);a();a();const next=admit('A');
    expect(()=>admit('A')).toThrow(RequestBudgetExceeded);next();b();
  });
  it('refuses excess API work before the handler and keeps the published v1 error vocabulary',async()=>{
    const execute=vi.fn(async()=>({ok:true})),budget=vi.fn(async()=>{throw new RequestBudgetExceeded(20);});
    const route=mobileRoute(z.object({ok:z.boolean()}),execute,async()=>({tenantId:'tenant',userId:'actor'}),budget);
    const response=await route(new Request('https://hr.test/api/mobile/v1/me'));
    expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('20');expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({error:'unavailable'});expect(execute).not.toHaveBeenCalled();
  });
  it('fails closed when the shared budget store is unavailable and releases local admission',async()=>{
    const execute=vi.fn(async()=>({ok:true}));
    const route=mobileRoute(z.object({ok:z.boolean()}),execute,async()=>({tenantId:'tenant',userId:'actor'}),async()=>{throw new Error('private DB fault');});
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{for(let n=0;n<30;n++){const response=await route(new Request('https://hr.test/api/mobile/v1/me'));expect(response.status).toBe(503);expect(await response.text()).not.toContain('private DB fault');}}
    finally{spy.mockRestore();}expect(execute).not.toHaveBeenCalled();
  });
});
