import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>vi.unstubAllEnvs());
it('compares 10 and 20 application connections on the same runner with 500 employee sessions',async()=>{
 for(const max of [10,20]){
  vi.resetModules();vi.stubEnv('AIHR_DB_POOL_MAX',String(max));
  const harness=await import('./harness');
  const application=await import('../db/client');
  expect(application.client.options.max).toBe(max);
  const {runClaimsLoad}=await import('./fixtures/claims-load');
  try{await harness.migrateTestDb();await runClaimsLoad('-pool'+max);}
  finally{
   await harness.closeAll();
   // Remove only the two closed clients owned by this iteration from the HMR cache.
   const cache=(globalThis as unknown as {__aihrPgPools?:Map<string,unknown>}).__aihrPgPools;
   for(const [key,value]of cache??[])if(value===application.client||value===harness.owner.client)cache!.delete(key);
  }
 }
},480000);
