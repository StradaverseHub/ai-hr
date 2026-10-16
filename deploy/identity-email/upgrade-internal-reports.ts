/** Explicit root-only internal-mode installation. No mail, consent, queue or Auth record is created. */
import {readFile,writeFile,mkdir,lstat,chmod,chown,copyFile,rename,unlink,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {validateInternalReportCa,INTERNAL_REPORT_CA_MAX_BYTES} from './internal-report-ca';
import {execFileSync} from 'node:child_process';
import postgres from 'postgres';
import {withInternalReportGrantOwner} from './internal-report-grant-owner';
import {installedWebPrincipal,installedInternalConfiguration,internalReportSenderDatabase,internalReportRunnerDatabase,internalReportRunnerEnvironment,internalReportSenderGrants,forbiddenSenderFunctionsSql} from './internal-report-install-model';
declare const INTERNAL_REPORT_FILES:Record<string,{base64:string;sha256:string;mode:number}>;
const runtime='/usr/local/lib/aihr-identity-email',config='/etc/aihr-internal-report',units='/etc/systemd/system';
const command=(program:string,args:string[],input?:string)=>execFileSync(program,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30_000});
const systemctl=(...args:string[])=>command('systemctl',args);
const envLine=(key:string,value:string)=>{
 if(/[\r\n\0]/.test(value))throw new Error('Invalid private environment value.');
 return key+'="'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"\n';
};
async function trusted(path:string,directory=false){const s=await lstat(path);if(s.uid!==0||(s.mode&0o022)!==0||(directory?!s.isDirectory():!s.isFile()))throw new Error('Untrusted installation path.');}
async function rootChain(path:string){let current='';for(const part of path.split('/').filter(Boolean)){current+='/'+part;await trusted(current,current!==path);}}
async function atomic(path:string,bytes:Uint8Array|string,mode:number){const next=path+'.internal-report-new';await writeFile(next,bytes,{flag:'wx',mode});try{await chown(next,0,0);await chmod(next,mode);await rename(next,path);}finally{try{await unlink(next);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
const health=`import socket,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(45);s.connect('/run/aihr-report-auth.sock');s.sendall(b'{"phase":"status"}');s.shutdown(socket.SHUT_WR);b=b''
while True:
 c=s.recv(4096)
 if not c:break
 b+=c
 if len(b)>4096:raise RuntimeError('invalid reply')
r=json.loads(b);assert set(r)=={'available'} and type(r['available']) is bool
`;
async function main(){
 if(process.getuid?.()!==0||process.platform!=='linux'||process.argv.slice(2).join(' ')!=='--install-internal-reports')throw new Error('Explicit root Linux installation required.');
 const unit=process.env.AIHR_INTERNAL_REPORT_WEB_UNIT??'';
 if(!/^[a-zA-Z0-9_.@-]+\.service$/.test(unit))throw new Error('Name the existing deployed web unit.');
 const show=(key:string)=>systemctl('show',unit,'--property='+key,'--value').trim();
 if(show('LoadState')!=='loaded'||show('ActiveState')!=='active')throw new Error('Existing web unit must be active.');
 const user=show('User'),group=show('Group')||command('id',['-gn',user]).trim();
 const principal=installedWebPrincipal({unit,user,group,uid:Number(command('id',['-u',user]).trim()),gid:Number(command('getent',['group',group]).split(':')[2]),pid:Number(show('MainPID')),dynamicUser:show('DynamicUser')});
 if((await stat('/proc/'+principal.pid)).uid!==principal.uid||!(await readFile('/proc/'+principal.pid+'/cgroup','utf8')).split('\n').some(line=>line.endsWith('/'+unit)))throw new Error('Running web process identity mismatch.');
 // The running unit's actual environment is authoritative; never source a caller env/build-tree file.
 const webEnv:Record<string,string>={};for(const line of (await readFile('/proc/'+principal.pid+'/environ','utf8')).split('\0')){const at=line.indexOf('=');if(at>0)webEnv[line.slice(0,at)]=line.slice(at+1);}
 if(Number(show('MainPID'))!==principal.pid)throw new Error('Web process changed during inspection.');
 const web=installedInternalConfiguration(webEnv),senderDb=internalReportSenderDatabase(process.env.AIHR_INTERNAL_REPORT_SENDER_DATABASE_URL??'',web.database);
 const runnerDb=internalReportRunnerDatabase(process.env.AIHR_INTERNAL_REPORT_RUNNER_DATABASE_URL??'',web.database);
 const ownerProbe=postgres(runnerDb.toString(),{max:1,connect_timeout:5,connection:{statement_timeout:5000}});
 try{const [owner]=await ownerProbe`select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner where n.nspname='public' and c.relname='custom_report_occurrence' and r.rolname=current_user`;if(!owner)throw new Error('Runner URL is not the genuine existing report table owner.');}finally{await ownerProbe.end();}
 let ca:Uint8Array|undefined;
 // Trust follows ONLY the actual running web's selected public CA, never caller/IPC input.
 if(webEnv.NODE_EXTRA_CA_CERTS){
  const caPath=webEnv.NODE_EXTRA_CA_CERTS;if(!caPath.startsWith('/'))throw new Error('SMTP CA must be an absolute trusted file.');await rootChain(caPath);
  const handle=await open(caPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(0)||(before.mode&BigInt(0o022))!==BigInt(0)||before.nlink!==BigInt(1)||before.size<BigInt(1)||before.size>BigInt(INTERNAL_REPORT_CA_MAX_BYTES))throw new Error('Unsafe public SMTP CA file.');
   const bytes=Buffer.alloc(Number(before.size)+1);let count=0;while(count<bytes.length){const {bytesRead}=await handle.read(bytes,count,bytes.length-count,count);if(bytesRead===0)break;count+=bytesRead;}
   const after=await handle.stat({bigint:true});if(count!==Number(before.size)||['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].some(key=>before[key as keyof typeof before]!==after[key as keyof typeof after]))throw new Error('SMTP CA changed during inspection.');
   ca=validateInternalReportCa(bytes.subarray(0,count));
  }finally{await handle.close();}
 }
 const node=process.env.AIHR_INTERNAL_REPORT_NODE??'';
 if(!node.startsWith('/')||node.includes('\n'))throw new Error('Supply a reviewed root-owned supported Node runtime.');await rootChain(node);
 const version=command(node,['--version']).trim().match(/^v(\d+)\.(\d+)\./);if(!version||!(Number(version[1])===22&&Number(version[2])>=13||Number(version[1])===24))throw new Error('Internal Auth requires Node22.13+ or24 LTS.');
 for(const path of ['/usr','/usr/local','/usr/local/lib','/etc',units,'/var','/var/lib','/var/backups'])await trusted(path,true);
 for(const path of [runtime,config]){await mkdir(path,{recursive:true,mode:path===config?0o700:0o755});await trusted(path,true);}
 await chmod(config,0o700);await rootChain(await realpath('/usr/bin/python3'));
 const ensureGroup=(name:string)=>{try{command('getent',['group',name]);}catch{command('groupadd',['--system',name]);}return Number(command('getent',['group',name]).split(':')[2]);};
 const filesGid=ensureGroup('aihr-report-files'),clientsGid=ensureGroup('aihr-report-clients');
 try{command('id',['-u','aihr-identity-email']);}catch{command('useradd',['--system','--gid','aihr-report-files','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','aihr-identity-email']);}
 try{command('id',['-u','aihr-report-renderer']);}catch{command('useradd',['--system','--gid','aihr-report-files','--home-dir','/var/lib/aihr-report-renderer','--shell','/usr/sbin/nologin','aihr-report-renderer']);}
 const mailUid=Number(command('id',['-u','aihr-identity-email']).trim()),rendererUid=Number(command('id',['-u','aihr-report-renderer']).trim());
 if(![mailUid,rendererUid].every(uid=>Number.isSafeInteger(uid)&&uid>0)||new Set([mailUid,rendererUid,principal.uid]).size!==3)throw new Error('Worker identities must be distinct.');
 if(command('id',['-G',principal.user]).trim().split(/\s+/).map(Number).some(gid=>gid===filesGid||gid===clientsGid))throw new Error('Web principal must not join global report reader/client groups.');
 if(command('id',['-G','aihr-report-renderer']).trim().split(/\s+/).map(Number).some(gid=>gid!==filesGid))throw new Error('Renderer has unrelated group authority.');
 const rendererState='/var/lib/aihr-report-renderer',directory=rendererState+'/render';
 await mkdir(rendererState,{recursive:true,mode:0o750});await trusted(rendererState,true);await chown(rendererState,0,filesGid);await chmod(rendererState,0o750);
 await mkdir(directory,{mode:0o750}).catch(error=>{if(error.code!=='EEXIST')throw error;});const dir=await lstat(directory);if(!dir.isDirectory()||![0,rendererUid].includes(dir.uid)||(dir.mode&0o022)!==0)throw new Error('Untrusted artifact directory.');await chown(directory,rendererUid,filesGid);await chmod(directory,0o750);
 const appProbe=postgres(web.database,{max:1,connect_timeout:5});
 try{const [role]=await appProbe`select r.rolname from pg_roles r where r.rolname=current_user and r.rolname='ai_hr_app' and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication and not exists(select 1 from pg_auth_members m where m.member=r.oid) and not exists(select 1 from pg_class c where c.relowner=r.oid) and not exists(select 1 from pg_namespace n where n.nspowner=r.oid) and not exists(select 1 from pg_database d where d.datdba=r.oid)`;
  const [prerequisite]=await appProbe`select to_regprocedure('app.internal_auth_report_start(uuid,uuid,text,jsonb,jsonb)') is not null as installed`;if(!role||!prerequisite?.installed)throw new Error('Canonical app role or reviewed552 prerequisite unavailable.');
 }finally{await appProbe.end();}
 const senderProbe=postgres(senderDb.toString(),{max:1,connect_timeout:5});
 try{const [role]=await senderProbe`select r.rolname from pg_roles r where r.rolname=current_user and r.rolname='aihr_identity_email' and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication and not exists(select 1 from pg_auth_members m where m.member=r.oid) and not exists(select 1 from pg_class c where c.relowner=r.oid) and not exists(select 1 from pg_namespace n where n.nspowner=r.oid) and not exists(select 1 from pg_database d where d.datdba=r.oid)`;if(!role)throw new Error('Sender role is privileged.');}finally{await senderProbe.end();}
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const requiredNames=['internal-report-schedule.cjs','internal-report-tick','internal-report-agent.cjs','report-auth-broker.cjs','report-renderer.cjs','report-auth-peer.py','renderer-peer.py','verify-internal-report-isolation.py','aihr-report-auth.socket','aihr-report-auth@.service','aihr-internal-report.socket','aihr-internal-report.service','aihr-report-renderer.socket','aihr-report-renderer@.service','aihrmanagedmail.slice','aihrmanagedmail-dispatch.slice'];
 if(JSON.stringify(Object.keys(INTERNAL_REPORT_FILES).sort())!==JSON.stringify(requiredNames.sort()))throw new Error('Incomplete reviewed internal installation bundle.');
 const changes:[string,Uint8Array|string,number][]=[];
 for(const [name,record]of Object.entries(INTERNAL_REPORT_FILES)){
  if(!/^[-a-zA-Z0-9_.@]+$/.test(name))throw new Error('Invalid reviewed bundle name.');
  let bytes=Buffer.from(record.base64,'base64');if(hash(bytes)!==record.sha256||![0o644,0o755].includes(record.mode))throw new Error('Reviewed bundle mismatch.');
  const isUnit=name.endsWith('.service')||name.endsWith('.socket')||name.endsWith('.slice');
  if(isUnit)bytes=Buffer.from(bytes.toString().replaceAll('@WEB_USER@',principal.user).replaceAll('@WEB_GROUP@',principal.group));
  changes.push([(isUnit?units:runtime)+'/'+name,bytes,record.mode]);
 }
 changes.push([runtime+'/internal-node',await readFile(node),0o755]);
 if(ca)changes.push([runtime+'/internal-smtp-ca.pem',ca,0o644]);
 changes.push([config+'/broker.env',envLine('AUTH_PROVIDER','internal')+envLine('AUTH_PUBLIC_ORIGIN',web.origin)+envLine('AUTH_SESSION_KEY',web.key)+envLine('DATABASE_URL',web.database)+envLine('REPORT_AUTH_BROKER_WEB_UID',String(principal.uid)),0o600]);
 changes.push([config+'/runner.env',internalReportRunnerEnvironment({origin:web.origin,appDatabase:web.database,ownerDatabase:runnerDb.toString()}),0o600]);
 changes.push([config+'/sender.env',envLine('AUTH_PROVIDER','internal')+envLine('AUTH_PUBLIC_ORIGIN',web.origin)+envLine('IDENTITY_EMAIL_DATABASE_URL',senderDb.toString())+envLine('REPORT_RENDERER_UID',String(rendererUid))+(ca?envLine('NODE_EXTRA_CA_CERTS',runtime+'/internal-smtp-ca.pem'):''),0o600]);
 changes.push([config+'/renderer.env',envLine('AUTH_PROVIDER','internal')+envLine('AUTH_PUBLIC_ORIGIN',web.origin)+envLine('DATABASE_URL',web.database)+envLine('REPORT_RENDERER_AUTH_BROKER_UID',String(principal.uid)),0o600]);
 const rendererDropin=units+'/aihr-report-renderer@.service.d';await mkdir(rendererDropin,{recursive:true,mode:0o755});await trusted(rendererDropin,true);
 changes.push([rendererDropin+'/internal.conf','[Service]\nEnvironmentFile=\nEnvironmentFile='+config+'/renderer.env\nInaccessiblePaths='+config+'\n',0o644]);
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup='/var/backups/aihr-internal-report-'+stamp;await mkdir(backup,{mode:0o700});await trusted(backup,true);
 const previous=new Map<string,string|null>();for(let i=0;i<changes.length;i++){const path=changes[i][0],copy=backup+'/'+i;try{await trusted(path);await copyFile(path,copy);await chmod(copy,0o600);previous.set(path,copy);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;previous.set(path,null);}}
 await writeFile(backup+'/manifest.json',JSON.stringify([...previous]),{mode:0o600});
 await withInternalReportGrantOwner(runnerDb.toString(),web.database,async owner=>{
 const oldGrants=(await owner.unsafe("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where n.nspname='identity_email' and p.proname in ('report_target','start_report','finish_report') and r.rolname='aihr_identity_email' and a.privilege_type='EXECUTE'")).map(row=>String(row.proname));
 const oldSchemaUsage=(await owner.unsafe("select has_schema_privilege('aihr_identity_email','identity_email','USAGE') as allowed"))[0]?.allowed===true;
 const listedUnits=new Set(systemctl('list-units','--all','--plain','--no-legend').split('\n').map(line=>line.trim().split(/\s+/)[0]));
 const stopWorkers=()=>{const owned=systemctl('list-units','--all','--plain','--no-legend').split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(unit=>['aihr-internal-report.socket','aihr-internal-report.service','aihr-report-auth.socket','aihr-report-renderer.socket'].includes(unit)||((unit.startsWith('aihr-report-auth@')||unit.startsWith('aihr-report-renderer@'))&&unit.endsWith('.service')));if(owned.length)systemctl('stop',...owned);};
 const oldActive=new Map<string,boolean>(),oldEnabled=new Map<string,boolean>();for(const socket of ['aihr-internal-report.socket','aihr-report-auth.socket','aihr-report-renderer.socket']){oldActive.set(socket,listedUnits.has(socket)&&systemctl('show',socket,'--property=ActiveState','--value').trim()==='active');let enabled=false;try{enabled=systemctl('is-enabled',socket).trim()==='enabled';}catch{}oldEnabled.set(socket,enabled);}
 if(systemctl('list-units','--state=active','--plain','--no-legend','aihr-report-auth@*.service','aihr-report-renderer@*.service').trim())throw new Error('Report requests are active; install only in an idle maintenance window.');
 oldActive.set('aihr-internal-report.service',listedUnits.has('aihr-internal-report.service')&&systemctl('show','aihr-internal-report.service','--property=ActiveState','--value').trim()==='active');
 try{
  // Direct revocation cannot remove inherited/PUBLIC authority. Refuse it rather than silently
  // changing global Auth grants; operator/root review must resolve that installation defect.
  await owner.begin(async tx=>{for(const grant of internalReportSenderGrants)await tx.unsafe(grant);});
  if((await owner.unsafe(forbiddenSenderFunctionsSql)).length)throw new Error('Sender retained forbidden PUBLIC/inherited/direct capabilities.');
  const tableAccess=await owner.unsafe("select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','f') and (has_table_privilege('aihr_identity_email',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('aihr_identity_email',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))");if(tableAccess.length)throw new Error('Sender retained HR/Auth table authority.');
  stopWorkers();
  for(const [path,value,mode]of changes)await atomic(path,value,mode);
  systemctl('daemon-reload');systemctl('enable','aihr-report-renderer.socket','aihr-report-auth.socket','aihr-internal-report.socket');systemctl('start','aihr-report-renderer.socket','aihr-report-auth.socket','aihr-internal-report.socket');
  command('runuser',['-u','aihr-identity-email','--','/usr/bin/python3','-I','-c',health]);
 }catch(error){
  try{stopWorkers();}catch{}
  for(const [path,,mode]of changes){const copy=previous.get(path);if(copy)await atomic(path,await readFile(copy),mode);else try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  // Restore only exact pre-existing direct compatibility grants on rollback, never global grants.
  if(oldGrants.includes('report_target'))await owner.unsafe('GRANT EXECUTE ON FUNCTION identity_email.report_target(uuid,uuid,text) TO aihr_identity_email');
  if(oldGrants.includes('start_report'))await owner.unsafe('GRANT EXECUTE ON FUNCTION identity_email.start_report(uuid,uuid,text,jsonb) TO aihr_identity_email');
  if(!oldGrants.includes('finish_report'))await owner.unsafe('REVOKE EXECUTE ON FUNCTION identity_email.finish_report(uuid,uuid,text,text,integer,uuid[]) FROM aihr_identity_email');
  if(!oldSchemaUsage)await owner.unsafe('REVOKE USAGE ON SCHEMA identity_email FROM aihr_identity_email');
  systemctl('daemon-reload');for(const [socket,enabled]of oldEnabled)if(!enabled)try{systemctl('disable',socket);}catch{}
  for(const [socket,active]of oldActive)if(active)systemctl('start',socket);throw error;
 }
 console.log('Internal report transport installed; no mail sent, consent changed or schedule enabled.');
 console.log('Relay readiness and actual delivery require their separate canonical setup and acceptance.');
 console.log('Root-private rollback snapshot: '+backup);
 console.log('Scheduling remains inactive. Review separate root scheduling --plan/--activate handoff after deployed guard/source proof and process drain.');
 console.log('Cron/dispatch marker were not changed. Uninstalled default provisioning remains key-bearing and dispatches reports; only the reviewed scheduling handoff suppresses its report stage.');
 });
}
main().catch(()=>{console.error('Internal report installation refused; inspect private service state. No secrets were printed.');process.exitCode=1;});
