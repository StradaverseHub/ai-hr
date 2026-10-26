/** Isolated transport factory tests authored UNRUN. Mock operations establish dispatch boundaries
 * only; they are not session, canonical-effect, browser, or database security proof. */
import { describe, expect, it, vi } from 'vitest';
import { createOwnLeaveBrowserHandler, type OwnLeaveOriginPolicy } from '../lib/assistant-actions/own-leave-http';
const PUBLIC='https://hr.fixture.test';
function fixture(policy:OwnLeaveOriginPolicy={publicOrigin:PUBLIC}){
 const authenticate=vi.fn(async()=>({opaque:'fictional session'})),operation=vi.fn(async()=>({kind:'review_index',reviews:[]}));
 const handler=createOwnLeaveBrowserHandler({authenticate,list:operation,prepare:operation,reopen:operation,confirm:operation,discard:operation},policy);
 return{handler,authenticate,operation};
}
function request(origin=PUBLIC,extra:Record<string,string>={},url='http://127.0.0.1:3000/api/assistant/own-leave'){
 return new Request(url,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin',...extra},body:JSON.stringify({operation:'list'})});
}
describe('configured deployment origin for unmounted own-leave transport',()=>{
 it('accepts the configured public HTTPS origin behind an internal HTTP listener without trusting reflected Host or forwarded headers',async()=>{
  const f=fixture();const response=await f.handler(request(PUBLIC,{host:'attacker.fixture.test','x-forwarded-host':'attacker.fixture.test','x-forwarded-proto':'http'}));
  expect(response.status).toBe(200);expect(f.authenticate).toHaveBeenCalledOnce();expect(f.operation).toHaveBeenCalledOnce();
 });
 it('rejects a matching attacker Origin/Host pair instead of making the reflected Host an allow-list',async()=>{
  const f=fixture();const response=await f.handler(request('https://attacker.fixture.test',{host:'attacker.fixture.test'},'https://attacker.fixture.test/api/assistant/own-leave'));
  expect(response.status).toBe(403);expect(f.authenticate).not.toHaveBeenCalled();expect(f.operation).not.toHaveBeenCalled();
 });
 it.each([undefined,'','not a URL','file:///private','https://hr.fixture.test/','https://user@hr.fixture.test'])('fails closed before authentication for absent or noncanonical configured origin %s',async publicOrigin=>{
  const f=fixture({publicOrigin});expect((await f.handler(request())).status).toBe(403);expect(f.authenticate).not.toHaveBeenCalled();expect(f.operation).not.toHaveBeenCalled();
 });
 it.each(['null','http://hr.fixture.test','https://hr.fixture.test:444','https://hr.fixture.test/','https://other.fixture.test'])('refuses nonexact browser origin %s',async origin=>{
  const f=fixture();expect((await f.handler(request(origin))).status).toBe(403);expect(f.authenticate).not.toHaveBeenCalled();
 });
 it('captures server construction policy and cannot be retargeted through a retained object',async()=>{
  const policy={publicOrigin:PUBLIC},f=fixture(policy);policy.publicOrigin='https://attacker.fixture.test';
  expect((await f.handler(request(PUBLIC))).status).toBe(200);expect((await f.handler(request(policy.publicOrigin))).status).toBe(403);expect(f.authenticate).toHaveBeenCalledOnce();
 });
 it('retains cross-site and bearer refusal before authentication even with the correct configured origin',async()=>{
  const extras:Record<string,string>[]=[{'sec-fetch-site':'cross-site'},{authorization:'Bearer fictional'}];
  for(const extra of extras){const f=fixture();expect((await f.handler(request(PUBLIC,extra))).status).toBe(403);expect(f.authenticate).not.toHaveBeenCalled();}
 });
});
