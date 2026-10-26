/** Isolated runtime composition tests, authored UNRUN. Actual HTTP factory is exercised while the
 * cookie authenticator/DB command owners are substituted; this is not live auth or effect proof. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({origin:undefined as string|undefined,throws:false,
 authenticate:vi.fn(async()=>({ctx:{opaque:'fictional'},locale:'en'})),
 operation:vi.fn(async()=>({kind:'unavailable'})),policies:[] as ({publicOrigin:string|undefined}|undefined)[]}));
vi.mock('server-only',()=>({}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>{if(fixture.throws)throw Error('PRIVATE configured identity diagnostics');return fixture.origin;}}));
vi.mock('../core/assistant-actions/own-leave-server',()=>({authenticateOwnLeaveBrowserSession:fixture.authenticate}));
vi.mock('../core/assistant-actions/own-leave-browser',async()=>{
 const {createOwnLeaveBrowserHandler}=await import('../lib/assistant-actions/own-leave-http');
 return{createOwnLeaveBrowserCommandHandler:(authenticate:()=>Promise<unknown>,policy?:{publicOrigin:string|undefined})=>{
  fixture.policies.push(policy);
  return createOwnLeaveBrowserHandler({authenticate,list:fixture.operation,prepare:fixture.operation,reopen:fixture.operation,confirm:fixture.operation,discard:fixture.operation},policy);
 }};
});
import {handleConfiguredOwnLeaveBrowserCommand} from '../core/assistant-actions/own-leave-runtime';
import * as route from '../app/api/assistant/own-leave/route';
beforeEach(()=>{vi.clearAllMocks();fixture.origin=undefined;fixture.throws=false;fixture.policies.length=0;});
function request(origin:string,url='https://attacker.fixture.test/api/assistant/own-leave'){
 return new Request(url,{method:'POST',headers:{origin,host:new URL(url).host,'x-forwarded-host':new URL(url).host,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify({operation:'list'})});
}
describe('configured own-leave candidate route composition',()=>{
 it('exports only the configured Node POST owner without a GET effect handler',()=>{expect(route.runtime).toBe('nodejs');expect(route.POST).toBe(handleConfiguredOwnLeaveBrowserCommand);expect(Object.keys(route).sort()).toEqual(['POST','dynamic','runtime']);});
 it('refuses a forged actor packet before authentication through the actual POST export',async()=>{fixture.origin='https://first.fixture.test';const response=await route.POST(new Request(fixture.origin+'/api/assistant/own-leave',{method:'POST',headers:{origin:fixture.origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify({operation:'list',ctx:{userId:'posted-user'}})}));expect(response.status).toBe(400);expect(fixture.authenticate).not.toHaveBeenCalled();expect(fixture.operation).not.toHaveBeenCalled();});
 it('bounds authentication failure through the candidate route without private diagnostics',async()=>{fixture.origin='https://first.fixture.test';fixture.authenticate.mockRejectedValueOnce(Error('PRIVATE_SESSION_DATABASE_DETAIL'));const response=await route.POST(request(fixture.origin));expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'unavailable'});expect(fixture.operation).not.toHaveBeenCalled();});
 it.each(['missing','throw','malformed'] as const)('fails closed with an explicit undefined/invalid policy for %s config, without reflected Host fallback or authentication',async mode=>{
  if(mode==='throw')fixture.throws=true;
  if(mode==='malformed')fixture.origin='not a public origin';
  const response=await handleConfiguredOwnLeaveBrowserCommand(request('https://attacker.fixture.test'));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'unavailable'});
  expect(fixture.policies).toEqual([{publicOrigin:mode==='malformed'?'not a public origin':undefined}]);
  expect(fixture.authenticate).not.toHaveBeenCalled();expect(fixture.operation).not.toHaveBeenCalled();
 });
 it('reads the configured origin per request and binds only the canonical authenticator',async()=>{
  fixture.origin='https://first.fixture.test';expect((await handleConfiguredOwnLeaveBrowserCommand(request(fixture.origin,'http://127.0.0.1:3000/api/assistant/own-leave'))).status).toBe(200);
  fixture.origin='https://second.fixture.test';expect((await handleConfiguredOwnLeaveBrowserCommand(request('https://first.fixture.test'))).status).toBe(403);
  expect(fixture.policies).toEqual([{publicOrigin:'https://first.fixture.test'},{publicOrigin:'https://second.fixture.test'}]);expect(fixture.authenticate).toHaveBeenCalledOnce();expect(fixture.operation).toHaveBeenCalledOnce();
 });
});
