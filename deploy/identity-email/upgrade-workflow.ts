/** Self-contained root upgrade. Build with scripts/build-workflow-email-upgrade.ts; stage/hash before running. */
import { readFile,writeFile,rename,mkdir,copyFile,lstat,chmod,chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { workflowEmailDatabaseGrants } from './database';
import { notificationEmailLink } from '../../lib/notification-email-model';
declare const WORKFLOW_EMAIL_AGENT_BASE64:string;
declare const WORKFLOW_EMAIL_AGENT_SHA256:string;
const envPath='/etc/aihr-keycloak/email-agent.env',runtime='/usr/local/lib/aihr-identity-email';
async function trusted(path:string,directory=false){const s=await lstat(path);if(s.uid!==0||(s.mode&0o022)!==0||(directory?!s.isDirectory():!s.isFile()))throw new Error('Untrusted private installation path');}
function parseEnv(input:string){const result:Record<string,string>={};for(const line of input.split('\n')){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at<1)throw new Error('Invalid private environment');const key=line.slice(0,at),value=line.slice(at+1);if(key in result)throw new Error('Duplicate private environment setting');result[key]=value;}return result;}
function status():Promise<boolean>{return new Promise(resolve=>{const req=request({socketPath:'/run/aihr-identity-email.sock',path:'/v1/notifications',method:'POST',headers:{'content-type':'application/json'},timeout:12_000},res=>{let body='';res.on('data',c=>{body+=c;if(body.length>4096)res.destroy();});res.on('end',()=>{try{resolve(res.statusCode===200&&JSON.parse(body).version===1);}catch{resolve(false);}});res.on('error',()=>resolve(false));});req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));req.end('{"op":"status"}');});}
async function main(){
 if(process.getuid?.()!==0)throw new Error('Root required');
 for(const path of ['/usr','/usr/local','/usr/local/lib',runtime,'/etc/aihr-keycloak'])await trusted(path,true);
 for(const path of [runtime+'/node',runtime+'/agent.cjs',envPath,'/etc/aihr-keycloak/app.env'])await trusted(path);
 const bytes=Buffer.from(WORKFLOW_EMAIL_AGENT_BASE64,'base64');if(createHash('sha256').update(bytes).digest('hex')!==WORKFLOW_EMAIL_AGENT_SHA256)throw new Error('Invalid embedded service bundle');
 const privateText=await readFile(envPath,'utf8'),mailEnv=parseEnv(privateText),auth=parseEnv(await readFile('/etc/aihr-keycloak/app.env','utf8'));
 notificationEmailLink(auth.AUTH_PUBLIC_ORIGIN,'/');
 if(auth.KEYCLOAK_ISSUER!==auth.AUTH_PUBLIC_ORIGIN+'/identity/realms/ai-hr'||auth.KEYCLOAK_ADMIN_CLIENT_ID!=='aihr-invitations'||!auth.KEYCLOAK_ADMIN_CLIENT_SECRET)throw new Error('Unexpected private identity configuration');
 const db=new URL(mailEnv.IDENTITY_EMAIL_DATABASE_URL);
 if(!['127.0.0.1','localhost'].includes(db.hostname)||db.username!=='aihr_identity_email'||(db.port&&db.port!=='5432')||!/^\/[a-zA-Z0-9_-]+$/.test(db.pathname))throw new Error('Unexpected private database');
 // Reuse the existing realm-scoped administration client; this is deliberately not claimed read-only.
 const tokenResponse=await fetch('http://127.0.0.1:8080/identity/realms/ai-hr/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:auth.KEYCLOAK_ADMIN_CLIENT_ID,client_secret:auth.KEYCLOAK_ADMIN_CLIENT_SECRET}),redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!tokenResponse.ok)throw new Error('Lookup credential unavailable');const token=await tokenResponse.json() as {access_token?:string};if(!token.access_token)throw new Error('Invalid lookup credential');
 const probe=await fetch('http://127.0.0.1:8080/identity/admin/realms/ai-hr/users?max=1',{headers:{authorization:'Bearer '+token.access_token},redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!probe.ok)throw new Error('Lookup permission unavailable');
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup='/var/backups/aihr-identity-email/workflow-'+stamp;
 for(const path of ['/var','/var/backups'])await trusted(path,true);
 try{await mkdir('/var/backups/aihr-identity-email',{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await trusted('/var/backups/aihr-identity-email',true);await chmod('/var/backups/aihr-identity-email',0o700);
 await mkdir(backup,{mode:0o700});await trusted(backup,true);
 await copyFile(envPath,backup+'/email-agent.env');await chmod(backup+'/email-agent.env',0o600);
 await copyFile(runtime+'/agent.cjs',backup+'/agent.cjs');
 const database=decodeURIComponent(db.pathname.slice(1));
 execFileSync('runuser',['-u','postgres','--','psql','-d',database,'-v','ON_ERROR_STOP=1','-q'],{input:workflowEmailDatabaseGrants().join(';\n')+';\n',stdio:['pipe','ignore','pipe']});
 const additions={WORKFLOW_EMAIL_ISSUER:auth.KEYCLOAK_ISSUER,WORKFLOW_EMAIL_ORIGIN:auth.AUTH_PUBLIC_ORIGIN,
   WORKFLOW_EMAIL_LOOKUP_CLIENT_ID:auth.KEYCLOAK_ADMIN_CLIENT_ID,WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET:auth.KEYCLOAK_ADMIN_CLIENT_SECRET};
 const kept=privateText.split('\n').filter(l=>l&&!Object.keys(additions).some(k=>l.startsWith(k+'=')));
 const updated=[...kept,...Object.entries(additions).map(([k,v])=>k+'='+v)].join('\n')+'\n';
 execFileSync('systemctl',['stop','aihr-identity-email.socket','aihr-identity-email.service']);
 try{
  await writeFile(envPath+'.workflow-new',updated,{mode:0o600,flag:'wx'});await chown(envPath+'.workflow-new',0,0);await rename(envPath+'.workflow-new',envPath);
  await writeFile(runtime+'/agent.workflow-new',bytes,{mode:0o644,flag:'wx'});await chown(runtime+'/agent.workflow-new',0,0);await rename(runtime+'/agent.workflow-new',runtime+'/agent.cjs');
  execFileSync('systemctl',['start','aihr-identity-email.socket']);
  if(!await status())throw new Error('Upgraded private service did not respond');
 }catch(e){
  await copyFile(backup+'/email-agent.env',envPath);await chmod(envPath,0o600);await copyFile(backup+'/agent.cjs',runtime+'/agent.cjs');
  execFileSync('systemctl',['start','aihr-identity-email.socket']);execFileSync('systemctl',['restart','aihr-identity-email.service']);throw e;
 }
 console.log('Workflow email service upgraded. No mail sent, categories enabled or authentication cutover performed.');
 console.log('Private rollback snapshot: '+backup);
}
main().catch(()=>{console.error('Workflow email upgrade failed; inspect the private service log and rollback snapshot. No credentials were printed.');process.exitCode=1;});
