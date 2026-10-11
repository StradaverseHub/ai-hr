import {createServer,type Server,type RequestListener} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {identityEmailRequest} from '../lib/identity/email-ipc';
let server:Server|undefined,dir:string|undefined;
afterEach(async()=>{vi.unstubAllEnvs();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));if(dir)await rm(dir,{recursive:true,force:true});});
async function socket(handler:RequestListener){
 dir=await mkdtemp(join(tmpdir(),'aihr-email-ipc-'));const path=join(dir,'settings.sock');server=createServer(handler);await new Promise<void>(resolve=>server!.listen(path,resolve));vi.stubEnv('IDENTITY_EMAIL_SOCKET',path);
}
describe('private email Unix socket protocol',()=>{
 it('uses only the fixed settings endpoint and transports JSON on the Unix socket',async()=>{
  await socket(async(req,res)=>{expect(req.url).toBe('/v1/settings');expect(req.method).toBe('POST');let body='';for await(const chunk of req)body+=chunk;expect(JSON.parse(body)).toEqual({op:'readiness'});res.end(JSON.stringify({ready:false}));});
  expect(await identityEmailRequest({op:'readiness'})).toEqual({ready:false});
 });
 it('does not expose a provider response or unknown credential-bearing error',async()=>{
  await socket((_req,res)=>{res.writeHead(500).end(JSON.stringify({error:'password-secret',details:'secret'}));});
  await expect(identityEmailRequest({op:'readiness'})).rejects.toMatchObject({code:'unavailable',message:'Identity email settings: unavailable'});
 });
 it('rejects oversized service responses',async()=>{
  await socket((_req,res)=>res.end('x'.repeat(70_000)));
  await expect(identityEmailRequest({op:'readiness'})).rejects.toMatchObject({code:'unavailable'});
 });
});
