/** Root-installed settings service. The web process never receives its realm management credential. */
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import postgres from 'postgres';
import { createEmailService, type EmailState } from './service';
import { EmailSettingsError } from '../../lib/identity/email-model';
const required=(name:string)=>{const value=process.env[name];if(!value) throw new Error('Missing private identity service configuration');return value;};
const database=postgres(required('IDENTITY_EMAIL_DATABASE_URL'),{max:1,connect_timeout:5,idle_timeout:20});
const clientSecret=required('IDENTITY_EMAIL_CLIENT_SECRET'),revisionKey=required('IDENTITY_EMAIL_REVISION_KEY'),testRecipient=required('IDENTITY_EMAIL_TEST_RECIPIENT');
const base='http://127.0.0.1:8080/identity',prefix='/admin/realms/ai-hr';
async function admin(path:string,method='GET',body?:unknown) {
 const tokenResponse=await fetch(base+'/realms/ai-hr/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:'aihr-email-settings',client_secret:clientSecret}),redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!tokenResponse.ok) throw new EmailSettingsError('unavailable');
 const token=await tokenResponse.json() as {access_token?:string};if(!token.access_token) throw new EmailSettingsError('unavailable');
 const response=await fetch(base+prefix+path,{method,headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25_000)});
 if(!response.ok) throw new EmailSettingsError('unavailable');
 return response.status===204?{}:response.json();
}
const statePath='/var/lib/aihr-identity-email/state.json';
const service=createEmailService({revisionKey,testRecipient,now:()=>new Date(),
 authorize:async a=>{const rows=await database`select * from app.identity_email_operator_info(${a.issuer},${a.subject},${a.userId}::uuid,${a.tenantId}::uuid)`;return rows[0]?.test_email??null;},
 audit:async(a,action,meta)=>{await database`select app.record_identity_email_event(${a.issuer},${a.subject},${a.userId}::uuid,${a.tenantId}::uuid,${action},${JSON.stringify(meta)}::jsonb)`;},
 realm:(method,body)=>admin('',method,body),test:async smtp=>{await admin('/testSMTPConnection','POST',smtp);},
 load:async()=>{try{return JSON.parse(await readFile(statePath,'utf8')) as EmailState;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') return {drafts:{},active:null};throw e;}},
 store:async state=>{await writeFile(statePath+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});await rename(statePath+'.tmp',statePath);},
 vault:async(key,password)=>{if(!/^smtp-[0-9a-f-]{36}$/.test(key)) throw new EmailSettingsError('invalid');await writeFile('/var/lib/aihr-identity-email/vault/ai-hr_'+key,password,{mode:0o640,flag:'wx'});},
});
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
 if(req.method!=='POST'||req.url!=='/v1/settings'){res.writeHead(404).end('{}');return;}
 let size=0;const chunks:Buffer[]=[];
 try{
  for await(const chunk of req){size+=chunk.length;if(size>16_384)throw new EmailSettingsError('invalid');chunks.push(chunk);}
  const result=await service(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200).end(JSON.stringify(result));
 }catch(e){const code=e instanceof EmailSettingsError?e.code:'unavailable';res.writeHead(code==='forbidden'?403:400).end(JSON.stringify({error:code}));}
});
server.requestTimeout=40_000;server.headersTimeout=5_000;
if(process.env.LISTEN_FDS!=='1'||process.env.LISTEN_PID!==String(process.pid)) throw new Error('Systemd socket activation is required');
server.listen({fd:3});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>{database.end().then(()=>process.exit(0));}));
