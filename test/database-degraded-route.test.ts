import {describe,expect,it,vi} from 'vitest';
import {DatabaseAdmissionError} from '../db/admission';
import {inIdempotentDatabaseRead} from '../db/workload';

vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>(key:string)=>`${namespace}.${key}`}));
import {capacityAwareRead,capacityAwareRoute} from '../lib/database-degraded';
import {DATABASE_RETRY_AFTER_SECONDS} from '../lib/database-capacity';

describe('API responses when database capacity is exhausted',()=>{
 it('answers 503 with Retry-After and translated text instead of a bare 500',async()=>{
  const route=capacityAwareRoute(async()=>{throw new DatabaseAdmissionError('queue-timeout');});
  const response=await route();
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe(String(DATABASE_RETRY_AFTER_SECONDS));
  expect(await response.json()).toEqual({error:'temporarily_unavailable',message:'common.degraded.apiMessage'});
 });
 it('maps a cancelled statement the same way',async()=>{
  const response=await capacityAwareRoute(async()=>{throw Object.assign(new Error('wrapped'),{cause:Object.assign(new Error('x'),{code:'57014'})});})();
  expect(response.status).toBe(503);
 });
 it('lets any other failure reach the framework unchanged',async()=>{
  await expect(capacityAwareRoute(async()=>{throw new Error('private bug');})()).rejects.toThrow('private bug');
 });
 it('runs read routes inside the idempotent scope that makes transactions retry, and write routes outside it',async()=>{
  let readScope=false,writeScope=true;
  await capacityAwareRead(async()=>{readScope=inIdempotentDatabaseRead();return new Response('ok');})();
  await capacityAwareRoute(async()=>{writeScope=inIdempotentDatabaseRead();return new Response('ok');})();
  expect(readScope).toBe(true);
  expect(writeScope).toBe(false);
 });
 it('forwards route arguments',async()=>{
  const handler=vi.fn(async(_req:Request,_ctx:{params:Promise<{id:string}>})=>new Response('ok'));
  const route=capacityAwareRoute(handler);
  const request=new Request('http://example.invalid/x'),context={params:Promise.resolve({id:'a'})};
  await route(request,context);
  expect(handler).toHaveBeenCalledWith(request,context);
 });
});
