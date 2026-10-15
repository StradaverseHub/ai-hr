/** Root-only upgrade of the existing managed mail installation. Never enables consent or sends mail. */
import {readFile,writeFile,rename,mkdir,copyFile,lstat,chmod,chown,open,unlink,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
import postgres from 'postgres';
import {masterReportDatabaseGrants} from './database';
import {reportRenderDatabase} from './render-config';
declare const REPORT_EMAIL_AGENT_BASE64:string;declare const REPORT_EMAIL_AGENT_SHA256:string;
declare const REPORT_RENDERER_BASE64:string;declare const REPORT_RENDERER_SHA256:string;
declare const REPORT_RENDERER_PEER_BASE64:string;declare const REPORT_RENDERER_PEER_SHA256:string;
declare const REPORT_RENDERER_PROBE_BASE64:string;declare const REPORT_RENDERER_PROBE_SHA256:string;
declare const REPORT_RENDERER_UNIT_BASE64:string;declare const REPORT_RENDERER_SOCKET_BASE64:string;declare const REPORT_MAIL_SLICE_BASE64:string;
const envPath='/etc/aihr-keycloak/email-agent.env',rendererEnv='/etc/aihr-keycloak/report-renderer.env',runtime='/usr/local/lib/aihr-identity-email',dropin='/etc/systemd/system/aihr-identity-email.service.d',units='/etc/systemd/system';
const rendererState='/var/lib/aihr-report-renderer',rendererDirectory=rendererState+'/render';
async function trusted(path:string,directory=false){const s=await lstat(path);if(s.uid!==0||(s.mode&0o022)!==0||(directory?!s.isDirectory():!s.isFile()))throw new Error('Untrusted private installation path.');}
function parseEnv(input:string){const result:Record<string,string>={};for(const line of input.split('\n')){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at<1)throw new Error('Invalid private environment.');const key=line.slice(0,at);if(key in result)throw new Error('Duplicate private environment.');result[key]=line.slice(at+1);}return result;}
const command=(program:string,args:string[],input?:string)=>execFileSync(program,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30_000});
const systemctl=(...args:string[])=>command('systemctl',args);
const encodedEnv=(value:string)=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
async function install(path:string,value:Uint8Array|string,mode:number){const next=path+'.report-new';await writeFile(next,value,{mode,flag:'wx'});try{await chown(next,0,0);await rename(next,path);}catch(error){await unlink(next);throw error;}}
function status():Promise<boolean>{return new Promise(resolve=>{const req=request({socketPath:'/run/aihr-identity-email.sock',path:'/v1/reports',method:'POST',headers:{'content-type':'application/json'},timeout:30_000},res=>{let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096)res.destroy();});res.on('end',()=>{try{const result=JSON.parse(body);resolve(res.statusCode===200&&result.version===1&&result.ready===true);}catch{resolve(false);}});res.on('error',()=>resolve(false));});req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));req.end('{"op":"status"}');});}
// Runs with the real mail UID. Root must not bypass the renderer's kernel peer-identity check.
const healthClient=`import socket,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(25);s.connect('/run/aihr-report-renderer.sock');s.sendall(b'{"phase":"status"}');s.shutdown(socket.SHUT_WR)
b=b''
while True:
 c=s.recv(4096)
 if not c:break
 b+=c
 if len(b)>4096:raise RuntimeError('oversized response')
r=json.loads(b);assert r=={'ok':True,'ready':True}
`;
async function main(){
 if(process.getuid?.()!==0)throw new Error('Root required.');
 for(const path of ['/usr','/usr/local','/usr/local/lib',runtime,'/etc/aihr-keycloak',units,'/var','/var/lib','/var/backups'])await trusted(path,true);
 for(const path of [runtime+'/node',runtime+'/agent.cjs',envPath,await realpath('/usr/bin/python3')])await trusted(path);
 const text=await readFile(envPath,'utf8'),env=parseEnv(text),privateDb=new URL(env.IDENTITY_EMAIL_DATABASE_URL??'');
 if(!['127.0.0.1','localhost'].includes(privateDb.hostname)||privateDb.username!=='aihr_identity_email'||(privateDb.port&&privateDb.port!=='5432')||!/^\/[a-zA-Z0-9_-]+$/.test(privateDb.pathname))throw new Error('Unexpected private database.');
 if(!env.WORKFLOW_EMAIL_ISSUER||!env.WORKFLOW_EMAIL_ORIGIN||!env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET)throw new Error('Install the accepted workflow-mail prerequisite first.');
 const renderUrl=reportRenderDatabase(process.env.AIHR_REPORT_RENDER_DATABASE_URL??'',privateDb.toString());
 const probe=postgres(renderUrl.toString(),{max:1,connect_timeout:5});
 try{const [role]=await probe`select r.rolname from pg_roles r where r.rolname=current_user and r.rolname='ai_hr_app' and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication and not exists(select 1 from pg_class c where c.relowner=r.oid) and not exists(select 1 from pg_namespace n where n.nspowner=r.oid) and not exists(select 1 from pg_auth_members m where m.member=r.oid)`;if(!role)throw new Error('Render role is privileged.');}finally{await probe.end();}
 const agent=Buffer.from(REPORT_EMAIL_AGENT_BASE64,'base64'),renderer=Buffer.from(REPORT_RENDERER_BASE64,'base64'),peer=Buffer.from(REPORT_RENDERER_PEER_BASE64,'base64'),isolationProbe=Buffer.from(REPORT_RENDERER_PROBE_BASE64,'base64'),hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
 if(hash(agent)!==REPORT_EMAIL_AGENT_SHA256||hash(renderer)!==REPORT_RENDERER_SHA256||hash(peer)!==REPORT_RENDERER_PEER_SHA256||hash(isolationProbe)!==REPORT_RENDERER_PROBE_SHA256)throw new Error('Invalid reviewed report bundles.');
 const mailUid=Number(command('id',['-u','aihr-identity-email']).trim());
 try{command('getent',['group','aihr-report-files']);}catch{command('groupadd',['--system','aihr-report-files']);}
 try{command('id',['-u','aihr-report-renderer']);}catch{command('useradd',['--system','--gid','aihr-report-files','--home-dir',rendererState,'--shell','/usr/sbin/nologin','aihr-report-renderer']);}
 const rendererUid=Number(command('id',['-u','aihr-report-renderer']).trim()),filesGid=Number(command('getent',['group','aihr-report-files']).split(':')[2]);
 const rendererGroups=command('id',['-G','aihr-report-renderer']).trim().split(/\s+/).map(Number),passwd=command('getent',['passwd','aihr-report-renderer']).trim().split(':');
 if(!Number.isSafeInteger(rendererUid)||rendererUid<=0||rendererUid===mailUid||!Number.isSafeInteger(filesGid)||rendererGroups.some(id=>id!==filesGid)||passwd[6]!=='/usr/sbin/nologin')throw new Error('Renderer identity is not isolated.');
 // Root owns the parent; mail has only group read/traverse, never write or cleanup authority.
 try{await mkdir(rendererState,{mode:0o750});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 await trusted(rendererState,true);await chown(rendererState,0,filesGid);await chmod(rendererState,0o750);
 try{await mkdir(rendererDirectory,{mode:0o750});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const directory=await open(rendererDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{const s=await directory.stat();if(!s.isDirectory()||![0,rendererUid].includes(s.uid))throw new Error('Untrusted renderer directory.');await directory.chown(rendererUid,filesGid);await directory.chmod(0o750);}finally{await directory.close();}
 await mkdir(dropin,{recursive:true,mode:0o755});await trusted(dropin,true);
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup='/var/backups/aihr-identity-email/reports-'+stamp;
 await mkdir('/var/backups/aihr-identity-email',{recursive:true,mode:0o700});await trusted('/var/backups/aihr-identity-email',true);await mkdir(backup,{mode:0o700});
 const changes:[string,Uint8Array|string,number][]=[
  [envPath,text.split('\n').filter(line=>line&&!/^(REPORT_RENDER_DATABASE_URL|REPORT_RENDERER_UID)=/.test(line)).concat('REPORT_RENDERER_UID='+rendererUid).join('\n')+'\n',0o600],
  [rendererEnv,'DATABASE_URL='+encodedEnv(renderUrl.toString())+'\nWORKFLOW_EMAIL_ISSUER='+env.WORKFLOW_EMAIL_ISSUER+'\n',0o600],
  [runtime+'/agent.cjs',agent,0o644],[runtime+'/report-renderer.cjs',renderer,0o644],[runtime+'/renderer-peer.py',peer,0o644],[runtime+'/verify-report-isolation.py',isolationProbe,0o644],
  [units+'/aihr-report-renderer@.service',Buffer.from(REPORT_RENDERER_UNIT_BASE64,'base64'),0o644],
  [units+'/aihr-report-renderer.socket',Buffer.from(REPORT_RENDERER_SOCKET_BASE64,'base64'),0o644],
  [units+'/aihrmanagedmail.slice',Buffer.from(REPORT_MAIL_SLICE_BASE64,'base64'),0o644],
  [dropin+'/reports.conf','[Service]\nSlice=aihrmanagedmail.slice\nSupplementaryGroups=aihr-report-files\nMemoryMax=192M\n',0o644],
 ];
 const previous=new Map<string,string|null>();
 for(let i=0;i<changes.length;i++){const path=changes[i][0],copy=backup+'/'+i;try{await trusted(path);await copyFile(path,copy);await chmod(copy,0o600);previous.set(path,copy);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;previous.set(path,null);}}
 await writeFile(backup+'/manifest.json',JSON.stringify([...previous]),{mode:0o600});
 // Owner-only queue/claim stay inaccessible to the transport role; no direct HR table grants.
 command('runuser',['-u','postgres','--','psql','-d',decodeURIComponent(privateDb.pathname.slice(1)),'-v','ON_ERROR_STOP=1','-q'],masterReportDatabaseGrants().join(';\n')+';\n');
 systemctl('stop','aihr-identity-email.socket','aihr-identity-email.service');
 try{
  // Units may be absent on first installation. Stop an existing renderer before replacing files.
  try{systemctl('stop','aihr-report-renderer.socket','aihr-report-renderer@*.service');}catch{}
  for(const [path,value,mode]of changes)await install(path,value,mode);
  systemctl('daemon-reload');systemctl('enable','aihr-report-renderer.socket');systemctl('start','aihr-report-renderer.socket');
  command('runuser',['-u','aihr-identity-email','--','/usr/bin/python3','-I','-c',healthClient]);
  systemctl('start','aihr-identity-email.socket');if(!await status())throw new Error('Report services are not ready.');
 }catch(error){
  try{systemctl('stop','aihr-report-renderer.socket','aihr-report-renderer@*.service','aihr-identity-email.socket','aihr-identity-email.service');}catch{}
  for(const [path,,mode]of changes){const copy=previous.get(path);if(copy)await install(path,await readFile(copy),mode);else try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  if(!previous.get(units+'/aihr-report-renderer.socket'))try{systemctl('disable','aihr-report-renderer.socket');}catch{}
  systemctl('daemon-reload');if(previous.get(units+'/aihr-report-renderer.socket'))systemctl('start','aihr-report-renderer.socket');systemctl('start','aihr-identity-email.socket');systemctl('restart','aihr-identity-email.service');throw error;
 }
 console.log('Managed report services installed. No mail sent, schedules enabled or consent changed.');console.log('Private rollback snapshot: '+backup);
}
main().catch(()=>{console.error('Report mail upgrade failed; inspect the private service log and rollback snapshot. Credentials were not printed.');process.exitCode=1;});
