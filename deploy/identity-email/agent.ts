import {createSingleReportHandler} from './report-handler';
/** Root-installed settings service. The web process never receives its realm management credential. */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, link } from 'node:fs/promises';
import postgres from 'postgres';
import { sendWorkflowSmtp,sendEmployeeMasterSmtp } from './smtp';
import { activeWorkflowRelay, createNotificationEmailService, type WorkflowMailTarget } from './notifications';
import { createEmailService, type EmailState } from './service';
import { EmailSettingsError } from '../../lib/identity/email-model';
import { IDENTITY_EMAIL_TEST_REALM } from '../../lib/identity/bootstrap';
import {z} from 'zod';
import {createMasterReportDeliveryService} from './reports';
import {masterDeliveryRequest} from '../../lib/employee-master-delivery-model';
import {masterRenderContext} from './render-context';
import {prepareMasterReportFile,authorizeMasterReportFile,removeMasterReportFile,reportRendererReady} from './render-process';
import { recordEmailAudit } from './database';
const required=(name:string)=>{const value=process.env[name];if(!value) throw new Error('Missing private identity service configuration');return value;};
const database=postgres(required('IDENTITY_EMAIL_DATABASE_URL'),{max:1,connect_timeout:5,idle_timeout:20});
const clientSecret=required('IDENTITY_EMAIL_CLIENT_SECRET'),revisionKey=required('IDENTITY_EMAIL_REVISION_KEY'),testRecipient=required('IDENTITY_EMAIL_TEST_RECIPIENT');
const base='http://127.0.0.1:8080/identity';
async function admin(path:string,method='GET',body?:unknown,testRealm=false) {
 const realm=testRealm?IDENTITY_EMAIL_TEST_REALM:'ai-hr';
 const tokenResponse=await fetch(base+'/realms/'+realm+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:'aihr-email-settings',client_secret:clientSecret}),redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!tokenResponse.ok) throw new EmailSettingsError('unavailable');
 const token=await tokenResponse.json() as {access_token?:string};if(!token.access_token) throw new EmailSettingsError('unavailable');
 const response=await fetch(base+'/admin/realms/'+realm+path,{method,headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25_000)});
 if(!response.ok) throw new EmailSettingsError('unavailable');
 return response.status===204?{}:response.json();
}
const statePath='/var/lib/aihr-identity-email/state.json';
const service=createEmailService({revisionKey,testRecipient,now:()=>new Date(),
 authorize:async a=>{const rows=await database`select * from identity_email.operator_info(${a.issuer},${a.subject},${a.userId}::uuid,${a.tenantId}::uuid)`;return rows[0]?.test_email??null;},
 audit:(a,action,meta)=>recordEmailAudit(database,a,action,meta as Record<string,postgres.JSONValue>),
 realm:(method,body)=>admin('',method,body),test:async smtp=>{await admin('/testSMTPConnection','POST',smtp,true);},
 load:async()=>{try{return JSON.parse(await readFile(statePath,'utf8')) as EmailState;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') return {drafts:{},active:null};throw e;}},
 store:async state=>{await writeFile(statePath+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});await rename(statePath+'.tmp',statePath);},
 vault:async(key,password)=>{
  if(!/^smtp-[0-9a-f-]{36}$/.test(key)) throw new EmailSettingsError('invalid');
  const path='/var/lib/aihr-identity-email/vault/ai-hr_'+key;
  await writeFile(path,password,{mode:0o640,flag:'wx'});
  await link(path,'/var/lib/aihr-identity-email/vault/'+IDENTITY_EMAIL_TEST_REALM+'_'+key);
 },
});
// Lookup uses the existing realm-scoped identity administration client, copied only by the root upgrade.
// It is not a read-only credential: the trusted identity service already administers this realm's SMTP.
async function verifyWorkflowRecipient(target:Pick<WorkflowMailTarget,'subject'|'email'>):Promise<'verified'|'changed'|'unavailable'> {
 const clientId=process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_ID,secret=process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET;
 if(!clientId||!secret||!/^[a-zA-Z0-9_-]{1,128}$/.test(target.subject))return 'unavailable';
 try{
  const response=await fetch(base+'/realms/ai-hr/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:secret}),redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)return 'unavailable';
  const credential=await response.json() as {access_token?:string};if(!credential.access_token)return 'unavailable';
  const account=await fetch(base+'/admin/realms/ai-hr/users/'+target.subject,{headers:{authorization:'Bearer '+credential.access_token},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(account.status===404)return 'changed';if(!account.ok)return 'unavailable';
  const a=await account.json() as {id?:string;email?:string;enabled?:boolean;emailVerified?:boolean;federationLink?:string;serviceAccountClientId?:string;requiredActions?:string[]};
  return a.id===target.subject&&a.enabled===true&&a.emailVerified===true&&a.email?.toLowerCase()===target.email.toLowerCase()&&!a.federationLink&&!a.serviceAccountClientId&&(!a.requiredActions||a.requiredActions.length===0)?'verified':'changed';
 }catch{return 'unavailable';}
}
async function workflowRelay(){
 const state=JSON.parse(await readFile(statePath,'utf8')) as EmailState;
 return activeWorkflowRelay(state,await admin('') as {smtpServer?:Record<string,string>});
}
const notifications=createNotificationEmailService({
 origin:process.env.WORKFLOW_EMAIL_ORIGIN||'https://unconfigured.invalid',
 ready:async()=>{
  if(!process.env.WORKFLOW_EMAIL_ISSUER||!process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET||!process.env.WORKFLOW_EMAIL_ORIGIN)return false;
  try{const relay=await workflowRelay();if(!relay)return false;if(relay.config.auth){if(!/^smtp-[0-9a-f-]{36}$/.test(relay.vaultKey||''))return false;await readFile('/var/lib/aihr-identity-email/vault/ai-hr_'+relay.vaultKey);}return true;}catch{return false;}
 },
 target:async(id,token)=>{
  const rows=await database<WorkflowMailTarget[]>`select * from identity_email.delivery_target(${id}::uuid,${token}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER||''})`;
  return rows.length===1?rows[0]:null;
 },
 assessmentTasks:async(id,token)=>{
  const rows=await database<{required:boolean;summary:unknown}[]>`select * from identity_email.delivery_summary(${id}::uuid,${token}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER||''})`;
  return rows.length===1&&!rows[0].required?undefined:rows[0]?.summary??null;
 },
 verifyRecipient:verifyWorkflowRecipient,
 start:async(id,token,target)=>(await database`select identity_email.start_delivery(${id}::uuid,${token}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER||''},${database.json(target)}::jsonb) as started`)[0]?.started===true,
 finish:async(id,token,outcome,error)=>(await database`select identity_email.finish_delivery(${id}::uuid,${token}::uuid,${outcome},${error}) as finished`)[0]?.finished===true,
 send:async(target,mail)=>{
  const relay=await workflowRelay();if(!relay)throw new Error('Managed relay changed');
  const c=relay.config;
  if(c.auth&&!/^smtp-[0-9a-f-]{36}$/.test(relay.vaultKey||''))throw new Error('Managed relay unavailable');
  const password=c.auth?await readFile('/var/lib/aihr-identity-email/vault/ai-hr_'+relay.vaultKey,'utf8'):undefined;
  await sendWorkflowSmtp(c,password,target,mail);
 },
});
const reportTarget=masterRenderContext.extend({email:z.email().max(320),subject:z.string().min(1).max(512)}).strict();
const reports=createMasterReportDeliveryService({
 origin:process.env.WORKFLOW_EMAIL_ORIGIN||'https://unconfigured.invalid',
 ready:async()=>{if(!await reportRendererReady())return false;try{return (await notifications({op:'status'})).ready===true;}catch{return false;}},
 target:async(id,token)=>{const [row]=await database`select identity_email.report_target(${id}::uuid,${token}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER||''}) as target`;const parsed=reportTarget.safeParse(row?.target);return parsed.success?parsed.data:null;},
 verifyRecipient:verifyWorkflowRecipient,
 prepare:prepareMasterReportFile,
 authorize:authorizeMasterReportFile,
 start:async(id,token,target)=>{return (await database`select identity_email.start_report(${id}::uuid,${token}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER||''},${database.json(target)}::jsonb) as started`)[0]?.started===true;},
 finish:async(id,token,outcome,reason,metadata)=>(await database`select identity_email.finish_report(${id}::uuid,${token}::uuid,${outcome},${reason},${metadata?.rowCount??null}::integer,${metadata?.scopeIds??null}::uuid[]) as finished`)[0]?.finished===true,
 send:async(target,attachment,messageId)=>{const relay=await workflowRelay();if(!relay)throw new Error('Managed relay unavailable.');const config=relay.config;if(config.auth&&!/^smtp-[0-9a-f-]{36}$/.test(relay.vaultKey||''))throw new Error('Managed relay unavailable.');const password=config.auth?await readFile('/var/lib/aihr-identity-email/vault/ai-hr_'+relay.vaultKey,'utf8'):undefined;await sendEmployeeMasterSmtp(config,password,target,attachment,messageId);},
});
// A concurrent lease is refused immediately, leaving its pending reclaim to the durable queue.
const handleReport=createSingleReportHandler(reports,removeMasterReportFile);
let privateQueue:Promise<unknown>=Promise.resolve();
const handlePrivateRequest=(path:string,input:unknown)=>{
 if(path==='/v1/reports')return handleReport(input);
 const result=privateQueue.then(()=>path==='/v1/notifications'?notifications(input):service(input));
 privateQueue=result.catch(()=>{});return result;
};
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
 if(req.method!=='POST'||!['/v1/settings','/v1/notifications','/v1/reports'].includes(req.url||'')){res.writeHead(404).end('{}');return;}
 let size=0;const chunks:Buffer[]=[];
 try{
  for await(const chunk of req){size+=chunk.length;if(size>16_384)throw new EmailSettingsError('invalid');chunks.push(chunk);}
  const result=await handlePrivateRequest(req.url!,JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200).end(JSON.stringify(result));
 }catch(e){const code=e instanceof EmailSettingsError?e.code:'unavailable';res.writeHead(code==='forbidden'?403:400).end(JSON.stringify({error:code}));}
});
server.requestTimeout=210_000;server.headersTimeout=5_000;
if(process.env.LISTEN_FDS!=='1'||process.env.LISTEN_PID!==String(process.pid)) throw new Error('Systemd socket activation is required');
server.listen({fd:3});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>{database.end().then(()=>process.exit(0));}));
