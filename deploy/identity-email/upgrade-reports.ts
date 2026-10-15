/** Root-only upgrade of the existing managed mail installation. It never enables consent or sends mail. */
import {readFile,writeFile,rename,mkdir,copyFile,lstat,chmod,chown,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
import postgres from 'postgres';
import {masterReportDatabaseGrants} from './database';
import {reportRenderDatabase} from './render-config';
declare const REPORT_EMAIL_AGENT_BASE64:string;declare const REPORT_EMAIL_AGENT_SHA256:string;
declare const REPORT_RENDERER_BASE64:string;declare const REPORT_RENDERER_SHA256:string;
const envPath='/etc/aihr-keycloak/email-agent.env',runtime='/usr/local/lib/aihr-identity-email',dropin='/etc/systemd/system/aihr-identity-email.service.d';
async function trusted(path:string,directory=false){const s=await lstat(path);if(s.uid!==0||(s.mode&0o022)!==0||(directory?!s.isDirectory():!s.isFile()))throw new Error('Untrusted private installation path.');}
function parseEnv(input:string){const result:Record<string,string>={};for(const line of input.split('\n')){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at<1)throw new Error('Invalid private environment.');const key=line.slice(0,at);if(key in result)throw new Error('Duplicate private environment.');result[key]=line.slice(at+1);}return result;}
function status():Promise<boolean>{return new Promise(resolve=>{const req=request({socketPath:'/run/aihr-identity-email.sock',path:'/v1/reports',method:'POST',headers:{'content-type':'application/json'},timeout:15_000},res=>{let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096)res.destroy();});res.on('end',()=>{try{const result=JSON.parse(body);resolve(res.statusCode===200&&result.version===1);}catch{resolve(false);}});res.on('error',()=>resolve(false));});req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));req.end('{"op":"status"}');});}
async function main(){
 if(process.getuid?.()!==0)throw new Error('Root required.');
 for(const path of ['/usr','/usr/local','/usr/local/lib',runtime,'/etc/aihr-keycloak','/etc/systemd/system','/var','/var/lib','/var/backups'])await trusted(path,true);
 for(const path of [runtime+'/node',runtime+'/agent.cjs',envPath])await trusted(path);
 const text=await readFile(envPath,'utf8'),env=parseEnv(text),privateDb=new URL(env.IDENTITY_EMAIL_DATABASE_URL??'');
 if(!['127.0.0.1','localhost'].includes(privateDb.hostname)||privateDb.username!=='aihr_identity_email'||(privateDb.port&&privateDb.port!=='5432')||!/^\/[a-zA-Z0-9_-]+$/.test(privateDb.pathname))throw new Error('Unexpected private database.');
 if(!env.WORKFLOW_EMAIL_ISSUER||!env.WORKFLOW_EMAIL_ORIGIN||!env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET)throw new Error('Install the accepted workflow-mail prerequisite first.');
 const renderUrl=reportRenderDatabase(process.env.AIHR_REPORT_RENDER_DATABASE_URL??'',privateDb.toString());
 const probe=postgres(renderUrl.toString(),{max:1,connect_timeout:5});
 try{const [role]=await probe`select r.rolname from pg_roles r where r.rolname=current_user and r.rolname='ai_hr_app' and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication and not exists(select 1 from pg_class c where c.relowner=r.oid) and not exists(select 1 from pg_namespace n where n.nspowner=r.oid) and not exists(select 1 from pg_auth_members m where m.member=r.oid)`;if(!role)throw new Error('Render role is privileged.');}finally{await probe.end();}
 const agent=Buffer.from(REPORT_EMAIL_AGENT_BASE64,'base64'),renderer=Buffer.from(REPORT_RENDERER_BASE64,'base64'),hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
 if(hash(agent)!==REPORT_EMAIL_AGENT_SHA256||hash(renderer)!==REPORT_RENDERER_SHA256)throw new Error('Invalid reviewed report bundles.');
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup='/var/backups/aihr-identity-email/reports-'+stamp;
 await mkdir('/var/backups/aihr-identity-email',{recursive:true,mode:0o700});await trusted('/var/backups/aihr-identity-email',true);await mkdir(backup,{mode:0o700});
 await copyFile(envPath,backup+'/email-agent.env');await chmod(backup+'/email-agent.env',0o600);await copyFile(runtime+'/agent.cjs',backup+'/agent.cjs');
 let priorRenderer=false,priorDropin=false;
 try{await trusted(runtime+'/report-renderer.cjs');await copyFile(runtime+'/report-renderer.cjs',backup+'/report-renderer.cjs');priorRenderer=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{await trusted(dropin,true);await trusted(dropin+'/reports.conf');await copyFile(dropin+'/reports.conf',backup+'/reports.conf');priorDropin=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // The root-owned grant program can execute only functions installed by migration0549, never web SQL.
 execFileSync('runuser',['-u','postgres','--','psql','-d',decodeURIComponent(privateDb.pathname.slice(1)),'-v','ON_ERROR_STOP=1','-q'],{input:masterReportDatabaseGrants().join(';\n')+';\n',stdio:['pipe','ignore','pipe']});
 const uid=Number(execFileSync('id',['-u','aihr-identity-email'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g','aihr-identity-email'],{encoding:'utf8'}).trim());
 const state=await lstat('/var/lib/aihr-identity-email');if(!state.isDirectory()||state.uid!==uid||(state.mode&0o022)!==0)throw new Error('Untrusted private state directory.');
 try{await mkdir('/var/lib/aihr-identity-email/render',{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 // The parent is service-owned. Never follow its child symlink while applying privileged chmod/chown.
 const renderDirectory=await open('/var/lib/aihr-identity-email/render',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{const stat=await renderDirectory.stat();if(!stat.isDirectory()||![0,uid].includes(stat.uid))throw new Error('Untrusted private render directory.');await renderDirectory.chown(uid,gid);await renderDirectory.chmod(0o700);}finally{await renderDirectory.close();}
 await mkdir(dropin,{recursive:true,mode:0o755});await trusted(dropin,true);
 const updated=text.split('\n').filter(line=>line&&!line.startsWith('REPORT_RENDER_DATABASE_URL=')).concat('REPORT_RENDER_DATABASE_URL='+renderUrl.toString()).join('\n')+'\n';
 execFileSync('systemctl',['stop','aihr-identity-email.socket','aihr-identity-email.service']);
 try{
  await writeFile(envPath+'.report-new',updated,{mode:0o600,flag:'wx'});await chown(envPath+'.report-new',0,0);await rename(envPath+'.report-new',envPath);
  for(const [name,bytes]of [['agent',agent],['report-renderer',renderer]] as const){await writeFile(runtime+'/'+name+'.report-new',bytes,{mode:0o644,flag:'wx'});await chown(runtime+'/'+name+'.report-new',0,0);await rename(runtime+'/'+name+'.report-new',runtime+'/'+name+'.cjs');}
  // Aggregate bound includes one renderer (384MB heap) and mail buffers; actual peak must be measured.
  await writeFile(dropin+'/reports.conf','[Service]\nMemoryMax=768M\nMemoryHigh=640M\nTasksMax=64\n',{mode:0o644});await chown(dropin+'/reports.conf',0,0);
  execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['start','aihr-identity-email.socket']);if(!await status())throw new Error('Report endpoint did not respond.');
 }catch(error){
  const {unlink}=await import('node:fs/promises');await copyFile(backup+'/email-agent.env',envPath);await chmod(envPath,0o600);await copyFile(backup+'/agent.cjs',runtime+'/agent.cjs');
  if(priorRenderer)await copyFile(backup+'/report-renderer.cjs',runtime+'/report-renderer.cjs');else try{await unlink(runtime+'/report-renderer.cjs');}catch{}
  if(priorDropin)await copyFile(backup+'/reports.conf',dropin+'/reports.conf');else try{await unlink(dropin+'/reports.conf');}catch{}
  execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['start','aihr-identity-email.socket']);execFileSync('systemctl',['restart','aihr-identity-email.service']);throw error;
 }
 console.log('Managed report source installed. No mail sent, schedules enabled or consent changed.');console.log('Private rollback snapshot: '+backup);
}
main().catch(()=>{console.error('Report mail upgrade failed; inspect the private service log and rollback snapshot. Credentials were not printed.');process.exitCode=1;});
