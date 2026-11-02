import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { transpileModule,ModuleKind } from 'typescript';
import { describe,it,expect,vi } from 'vitest';
import { readBoundedBody } from '../lib/bounded-body';
function fixture(){
 let generation=1,foreign=false,badState=false;
 const commit=vi.fn(),browser=vi.fn(async(url:string)=>{
  if(foreign)return {type:'success',url:'other://auth/callback?code='+ 'c'.repeat(43)+'&state=fixturestate00000000000000000000'};
  return {type:'success',url:'aihr://auth/callback?'+new URLSearchParams({code:'c'.repeat(43),state:badState?'wrong':'fixturestate00000000000000000000'})};
 });
 const fetcher=vi.fn(async(url:string)=>url.endsWith('/native')?Response.json({url:'https://hr.test/login/entra/start?ticket='+ 't'.repeat(43)}):Response.json({step:'complete',access_token:'aihr_'+ 'a'.repeat(43),refresh_token:'aihr_refresh_'+ 'r'.repeat(43),expires_in:900}));
 const mod={exports:{} as {signInWithMicrosoft:(organization:string,owner:number)=>Promise<boolean>}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/entra-auth.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,{module:mod,exports:mod.exports,URL,URLSearchParams,TextDecoder,AbortSignal,require(name:string){
  if(name==='expo-crypto')return {getRandomBytesAsync:async()=>new Uint8Array(32).fill(1),digestStringAsync:async(_:string,value:string)=>createHash('sha256').update(value).digest('base64'),randomUUID:()=> 'fixturestate00000000000000000000',CryptoDigestAlgorithm:{SHA256:'sha256'},CryptoEncoding:{BASE64:'base64'}};
  if(name==='expo-web-browser')return {openAuthSessionAsync:browser};
  if(name==='expo/fetch')return {fetch:fetcher};
  if(name==='./config')return {config:{apiUrl:'https://hr.test',authProvider:'internal'},configProblem:()=>null};
  if(name==='./auth')return {assertAuthGeneration:(owner:number)=>{if(owner!==generation)throw Error('Changed installation');},completeInternalSignIn:commit,redirectUri:()=> 'aihr://auth/callback'};
  if(name==='../../lib/bounded-body')return {readBoundedBody};
  throw Error(name);
 }});
 return {send:()=>mod.exports.signInWithMicrosoft('acme',1),fetcher,browser,commit,change:()=>{generation++;},foreign:()=>{foreign=true;},badState:()=>{badState=true;}};
}
describe('native Microsoft server federation transport',()=>{
 it('opens only the selected HR launcher and exchanges its proof without browser cookies or a Microsoft secret',async()=>{
  const f=fixture();expect(await f.send()).toBe(true);expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.browser.mock.calls[0][0]).toMatch(/^https:\/\/hr.test\/login\/entra\/start/);
  expect(f.fetcher.mock.calls[0][0]).toBe('https://hr.test/login/entra/native');expect(f.fetcher.mock.calls[1][0]).toBe('https://hr.test/login/entra/exchange');expect(f.commit).toHaveBeenCalledOnce();
 });
 it('rejects a callback with a foreign scheme or mismatched state before exchange',async()=>{
  for(const bad of ['foreign','badState'] as const){const f=fixture();f[bad]();await expect(f.send()).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.commit).not.toHaveBeenCalled();}
 });
 it('refuses late browser completion after the workplace changes',async()=>{
  const f=fixture();f.browser.mockImplementationOnce(async()=>{f.change();return {type:'success',url:'aihr://auth/callback'};});await expect(f.send()).rejects.toThrow();expect(f.commit).not.toHaveBeenCalled();
 });
 it('does not follow a launcher URL to another host',async()=>{
  const f=fixture();f.fetcher.mockResolvedValueOnce(Response.json({url:'https://evil.test/login/entra/start'}));await expect(f.send()).rejects.toThrow();expect(f.browser).not.toHaveBeenCalled();
 });
});
