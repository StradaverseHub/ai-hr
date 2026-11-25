/** ADR 0181 Phase 3, decision 3: the per-process viewer menu cache (lib/viewer-menu-cache.ts). */
import {describe,expect,it,vi} from 'vitest';
import {ViewerMenuCache,sessionClaimsDigest,viewerMenuCacheEnabled} from '../lib/viewer-menu-cache';

const clock=()=>{let t=1_000_000;return {now:()=>t,advance:(ms:number)=>{t+=ms;}};};
const read=<T,>(value:T,cacheable=true)=>vi.fn(async()=>({value,cacheable}));

describe('viewer menu cache',()=>{
 it('serves an entry until it is 60 s old, then reads again',async()=>{
  const c=clock(),cache=new ViewerMenuCache(60_000,10,c.now);
  const first=read({menu:1});
  expect(await cache.get('k',first)).toEqual({menu:1});
  c.advance(59_999);
  const second=read({menu:2});
  expect(await cache.get('k',second)).toEqual({menu:1});
  expect(second).not.toHaveBeenCalled();
  c.advance(1);
  expect(await cache.get('k',second)).toEqual({menu:2});
  expect(second).toHaveBeenCalledTimes(1);
 });
 it('keeps at most its bound, dropping the least recently used',async()=>{
  const c=clock(),cache=new ViewerMenuCache(60_000,2,c.now);
  await cache.get('a',read('a'));await cache.get('b',read('b'));
  await cache.get('a',read('stale'));// touches a
  await cache.get('c',read('c'));
  expect(cache.size).toBe(2);
  // a was used after b, so b went out first: a and c are still served, b is read again.
  expect(await cache.get('a',read('x'))).toBe('a');
  expect(await cache.get('c',read('y'))).toBe('c');
  const again=read('b2');
  expect(await cache.get('b',again)).toBe('b2');
  expect(again).toHaveBeenCalledTimes(1);
 });
 it('shares one read between concurrent misses of the same key',async()=>{
  const cache=new ViewerMenuCache();
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const slow=vi.fn(async()=>{await gate;return {value:'shared',cacheable:true};});
  const both=Promise.all([cache.get('k',slow),cache.get('k',slow)]);
  release();
  expect(await both).toEqual(['shared','shared']);
  expect(slow).toHaveBeenCalledTimes(1);
 });
 it('keeps neither a failed nor a degraded read',async()=>{
  const cache=new ViewerMenuCache();
  await expect(cache.get('k',async()=>{throw new Error('offline');})).rejects.toThrow('offline');
  expect(cache.size).toBe(0);
  expect(await cache.get('k',read('degraded',false))).toBe('degraded');
  expect(cache.size).toBe(0);
  const next=read('fresh');
  expect(await cache.get('k',next)).toBe('fresh');
  expect(next).toHaveBeenCalledTimes(1);
 });
 it('digests the session claims independently of key order, and differently for any changed grant',()=>{
  const a={userId:'u',roles:['manager'],grants:[{role:'manager',companyId:null}]};
  expect(sessionClaimsDigest(a)).toBe(sessionClaimsDigest({grants:[{companyId:null,role:'manager'}],roles:['manager'],userId:'u'}));
  expect(sessionClaimsDigest(a)).not.toBe(sessionClaimsDigest({...a,grants:[{role:'manager',companyId:'c'}]}));
  expect(sessionClaimsDigest(a)).not.toBe(sessionClaimsDigest({...a,roles:['manager','hr_admin']}));
 });
 it('is switched off only by AIHR_VIEWER_MENU_CACHE=off',()=>{
  const before=process.env.AIHR_VIEWER_MENU_CACHE;
  try{
   delete process.env.AIHR_VIEWER_MENU_CACHE;expect(viewerMenuCacheEnabled()).toBe(true);
   process.env.AIHR_VIEWER_MENU_CACHE='off';expect(viewerMenuCacheEnabled()).toBe(false);
  }finally{if(before===undefined)delete process.env.AIHR_VIEWER_MENU_CACHE;else process.env.AIHR_VIEWER_MENU_CACHE=before;}
 });
});
