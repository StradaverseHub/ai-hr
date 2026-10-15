/** Dedicated disposable Linux VM only. Source acceptance preparation; never an application entrypoint.
 * Compile/hash this reviewed file before root staging. See docs/design/managed-report-acceptance.md.
 */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {startReportSmtpSink,reportAttachment} from '../test/fixtures/managed-report-delivery/smtp-sink';
import type {SessionContext} from '../db/client';
const DATABASE='ai_hr_report_delivery_acceptance',STAGING='/root/aihr-report-acceptance',MARKER='/etc/aihr-report-acceptance.json';
const CANDIDATE='/srv/aihr-report-acceptance/candidate',SOCKET='/run/aihr-identity-email.sock',SMTP_PORT=24656;
const ISSUER='https://report-acceptance.invalid/identity/realms/ai-hr';
const EMAILS={owner:'owner@report-acceptance.invalid',recipient:'recipient@report-acceptance.invalid'};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
const command=(program:string,args:string[])=>execFileSync(program,args,{encoding:'utf8',timeout:30_000,stdio:['ignore','pipe','pipe']}).trim();
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const mode=process.argv[2];check(mode==='prepare'||mode==='verify','Choose prepare or verify; neither mode is a production command.');
let sink:Awaited<ReturnType<typeof startReportSmtpSink>>|undefined,owner:Awaited<ReturnType<(typeof import('../db/client'))['createDb']>>|undefined;
let appClient:{end(options?:{timeout?:number}):Promise<unknown>}|undefined,lock:Awaited<ReturnType<typeof fs.open>>|undefined;
const startedAt=Date.now();let bootTicks=0;
const children=new Set<ChildProcess>();let stopped=false,installed=false,cronStarted=false;let privateReceiptDirectory:string|undefined;let stage='preflight';
let memoryTimer:ReturnType<typeof setInterval>|undefined;const memory={aggregate:0,mail:0,renderer:0};
let cleanupPromise:Promise<void>|undefined;
function killChild(child:ChildProcess,signal:NodeJS.Signals){if(child.pid)try{process.kill(-child.pid,signal);}catch{}}
async function cleanup(){return cleanupPromise??=(async()=>{
 if(memoryTimer)clearInterval(memoryTimer);if(cronStarted){try{command('systemctl',['stop','cron.service']);await quiesceCron();}catch{process.exitCode=1;}}
 for(const child of children)killChild(child,'SIGTERM');
 if(installed)try{command('systemctl',['stop','aihr-identity-email.socket','aihr-identity-email.service','aihr-report-renderer.socket','aihr-report-renderer@*.service']);}catch{process.exitCode=1;}
 for(const child of children){await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(5000)]);killChild(child,'SIGKILL');}
 if(sink)await sink.close();if(owner)await owner.client.end({timeout:5});if(appClient)await appClient.end({timeout:5});if(lock){await lock.close();await fs.unlink('/run/aihr-report-acceptance.lock');}
})();}
const watchdog=setTimeout(()=>{stopped=true;process.exitCode=1;void cleanup().finally(()=>process.exit(1));},40*60_000);
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{stopped=true;process.exitCode=1;void cleanup().finally(()=>process.exit(1));});
async function ownedCronPids(since=bootTicks){
 const found:{pid:number;start:string}[]=[];
 for(const entry of await fs.readdir('/proc'))if(/^\d+$/.test(entry))try{
  const prefix='/proc/'+entry,stat=await fs.stat(prefix),args=(await fs.readFile(prefix+'/cmdline','utf8')).split('\0').filter(Boolean);
  if(stat.uid!==0||args.length!==5||args[0]!=='/usr/local/lib/aihr-identity-email/node'||args[1]!=='--env-file='+STAGING+'/runner.env'||args[2]!=='--import'||args[3]!=='tsx'||args[4]!=='scripts/provision-runner.ts'||await fs.readlink(prefix+'/cwd')!==CANDIDATE)continue;
  const raw=await fs.readFile(prefix+'/stat','utf8'),start=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)[19];
  if(Number(start)>=since)found.push({pid:Number(entry),start});
 }catch{}
 return found;
}
async function quiesceCron(){
 const owned=await ownedCronPids();for(const item of owned)try{process.kill(item.pid,'SIGTERM');}catch{}
 if(owned.length)await sleep(5000);
 for(const item of await ownedCronPids())if(owned.some(before=>before.pid===item.pid&&before.start===item.start))try{process.kill(item.pid,'SIGKILL');}catch{}
 await boundedWait(async()=>(await ownedCronPids()).length===0,Date.now()+10_000);
}
async function rootFile(filename:string,max=1_000_000){const stat=await fs.lstat(filename);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&(stat.mode&0o077)===0&&stat.size<=max,'Missing or unsafe root-only fixture prerequisite.');return fs.readFile(filename);}
function localDb(value:string,role?:string){const u=new URL(value);check(['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='127.0.0.1'&&(u.port||'5432')==='5432'&&u.pathname==='/'+DATABASE&&!u.search&&!u.hash&&!!u.password,'Only the named disposable loopback database is allowed.');if(role)check(decodeURIComponent(u.username)===role,'Unexpected database role.');return u;}
function envText(text:string){const out:Record<string,string>={};for(const line of text.split('\n')){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');check(at>0&&!Object.prototype.hasOwnProperty.call(out,line.slice(0,at)),'Invalid fixture environment.');out[line.slice(0,at)]=line.slice(at+1);}return out;}
async function boundedWait(probe:()=>Promise<boolean>,deadline:number){while(!await probe()){check(!stopped&&Date.now()<deadline,'Fixture stopped or timed out; preserve private evidence.');await sleep(250);}}
async function privateRequest(endpoint:string,body:unknown){
 return new Promise<unknown>((resolve,reject)=>{
  const req=request({socketPath:SOCKET,path:endpoint,method:'POST',headers:{'content-type':'application/json'},timeout:190_000},res=>{
   let text='';res.on('data',chunk=>{text+=chunk;if(text.length>8192)res.destroy();});res.on('error',reject);
   res.on('end',()=>{try{check(res.statusCode===200,'Private service refused.');resolve(JSON.parse(text));}catch(error){reject(error);}});
  });
  req.on('timeout',()=>req.destroy(new Error('Private service timeout.')));req.on('error',reject);req.end(JSON.stringify(body));
 });
}
async function renderer(body:unknown){
 // Kernel peer credential is the installed mail UID; root is deliberately not used as the peer.
 const program="import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(95);s.connect('/run/aihr-report-renderer.sock');s.sendall(sys.stdin.buffer.read(4097));s.shutdown(socket.SHUT_WR);b=b''\nwhile True:\n c=s.recv(4096)\n if not c:break\n b+=c\n if len(b)>4096:raise RuntimeError('oversized')\nsys.stdout.buffer.write(b)";
 return new Promise<Record<string,unknown>>((resolve,reject)=>{
  const child=spawn('/usr/sbin/runuser',['-u','aihr-identity-email','--','/usr/bin/python3','-I','-c',program],{stdio:['pipe','pipe','pipe'],detached:true});children.add(child);let text='';
  const timer=setTimeout(()=>killChild(child,'SIGTERM'),100_000);child.stdout.on('data',c=>{text+=c;if(text.length>4096)killChild(child,'SIGTERM');});child.stderr.resume();
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);children.delete(child);try{check(code===0,'Renderer fixture peer failed.');resolve(JSON.parse(text));}catch(error){reject(error);}});child.stdin.end(JSON.stringify(body));
 });
}
async function main(){
 check(/^v20\./.test(process.version),'The reviewed installed Node20 runtime is required.');
 check(process.platform==='linux'&&process.getuid?.()===0,'Dedicated Linux root execution required.');
 check(command('systemd-detect-virt',['--vm']).length>0,'A dedicated VM is required, not the developer host/container.');
 bootTicks=Math.floor(Number((await fs.readFile('/proc/uptime','utf8')).split(' ')[0])*Number(command('getconf',['CLK_TCK'])));check(Number.isSafeInteger(bootTicks)&&bootTicks>0,'Unable to bind owned cron process lifetime.');
 check(command('systemctl',['is-system-running'])==='running','Linux systemd must be fully running.');
 for(const service of ['cron.service','crond.service']){let active='';try{active=command('systemctl',['is-active',service]);}catch{}check(active!=='active','Stop scheduled jobs on the dedicated acceptance VM before running.');}
 const marker=JSON.parse((await rootFile(MARKER)).toString());
 check(marker.version===1&&marker.purpose==='disposable-managed-report-acceptance'&&marker.database===DATABASE&&marker.candidateRoot===CANDIDATE&&/^[0-9a-f-]{36}$/.test(marker.runId),'Explicit disposable-host marker required.');
 const candidateStat=await fs.lstat(CANDIDATE);check(candidateStat.isDirectory()&&!candidateStat.isSymbolicLink()&&candidateStat.uid===0&&(candidateStat.mode&0o022)===0,'Root-owned reviewed candidate required.');
 check(command('git',['-C',CANDIDATE,'rev-parse','HEAD'])===marker.candidateSha&&!command('git',['-C',CANDIDATE,'status','--porcelain']),'Clean reviewed candidate required.');
 check(process.argv[1]===STAGING+'/fixture.cjs'&&hash(await rootFile(process.argv[1],30_000_000))===marker.fixtureSha256,'Run only the reviewed root-staged fixture bundle.');
 check(hash(await rootFile(STAGING+'/report-upgrade.cjs',40_000_000))===marker.upgradeSha256,'Reviewed upgrade digest mismatch.');
 const ca=await rootFile(STAGING+'/ca.pem'),key=await rootFile(STAGING+'/server.key'),cert=await rootFile(STAGING+'/server.pem');check(hash(ca)===marker.caSha256,'Reviewed disposable CA required.');const publicCa='/usr/local/share/ca-certificates/aihr-report-acceptance.crt',publicStat=await fs.lstat(publicCa);check(publicStat.isFile()&&!publicStat.isSymbolicLink()&&publicStat.uid===0&&(publicStat.mode&0o022)===0&&hash(await fs.readFile(publicCa))===hash(ca),'Install the same public fixture CA at the reviewed readable path first.');check(command('systemctl',['show','aihr-identity-email.service','--property=Environment','--value']).includes('NODE_EXTRA_CA_CERTS='+publicCa),'Mail Node must trust the public fixture CA through its own explicit service environment.');
 check(process.env.NODE_EXTRA_CA_CERTS===STAGING+'/ca.pem','Fixture process must trust only the explicitly staged additional CA.');
 const appUrl=localDb(process.env.DATABASE_URL??'','ai_hr_app'),migrationUrl=localDb(process.env.MIGRATION_DATABASE_URL??'');check(appUrl.username!==migrationUrl.username,'Separate app/migration roles required.');
 const privateEnv=envText((await rootFile('/etc/aihr-keycloak/email-agent.env')).toString());localDb(privateEnv.IDENTITY_EMAIL_DATABASE_URL??'','aihr_identity_email');
 check(privateEnv.IDENTITY_EMAIL_TEST_RECIPIENT===EMAILS.owner&&privateEnv.WORKFLOW_EMAIL_ISSUER===ISSUER&&privateEnv.WORKFLOW_EMAIL_ORIGIN==='https://report-acceptance.invalid','Existing mail base installation is not the fictional acceptance installation.');
 process.env.AIHR_REPORT_RENDER_DATABASE_URL=appUrl.toString();
 const runnerEnv=envText((await rootFile(STAGING+'/runner.env')).toString());check(runnerEnv.DATABASE_URL===process.env.DATABASE_URL&&runnerEnv.MIGRATION_DATABASE_URL===process.env.MIGRATION_DATABASE_URL&&Object.keys(runnerEnv).every(key=>['DATABASE_URL','MIGRATION_DATABASE_URL','IDENTITY_EMAIL_SOCKET'].includes(key))&&(!runnerEnv.IDENTITY_EMAIL_SOCKET||runnerEnv.IDENTITY_EMAIL_SOCKET===SOCKET),'Cron runner must use exact private disposable credentials only.');
 const cronLine='* * * * * cd '+CANDIDATE+' && /usr/local/lib/aihr-identity-email/node --env-file='+STAGING+'/runner.env --import tsx scripts/provision-runner.ts >> /var/lib/aihr-report-acceptance/cron.log 2>&1';
 const cron=command('crontab',['-u','root','-l']).split('\n').filter(line=>line.trim()&&!line.trim().startsWith('#'));check(cron.length===1&&cron[0]===cronLine,'Preinstall only the exact fixture-owned canonical minute runner on the disposable VM.');
 for(const filename of ['.env.production','.env.local'])check(!await fs.lstat(CANDIDATE+'/'+filename).then(()=>true,()=>false),'Candidate environment files are forbidden; use the private fixed runner environment.');
 for(const user of ['ubuntu','postgres']){let value='';try{value=command('crontab',['-u',user,'-l']);}catch{}check(!value.split('\n').some(line=>line.trim()&&!line.trim().startsWith('#')),'Other user cron entries must be absent on this dedicated VM.');}
 check((await ownedCronPids(0)).length===0,'Another fixture minute runner is already active.');
 const timers=command('systemctl',['list-timers','--all','--no-legend','--plain']);check(!/aihr|provision|notification|report-delivery/i.test(timers),'Other managed jobs must be absent on this dedicated VM.');
 // Never select credentials from the application checkout or silently provision roles/VMs/providers.
 const out='/var/lib/aihr-report-acceptance/'+marker.runId;await fs.mkdir(out,{recursive:true,mode:0o700});privateReceiptDirectory=out;const outStat=await fs.lstat(out);check(outStat.isDirectory()&&!outStat.isSymbolicLink()&&outStat.uid===0&&(outStat.mode&0o077)===0,'Unsafe private receipt directory.');
 lock=await fs.open('/run/aihr-report-acceptance.lock',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await lock.writeFile(String(process.pid));
 check(!await fs.stat(out+'/verification-started').then(()=>true,()=>false),'A verification journey already started; do not reset or reseed it.');
 const dbModule=await import('../db/client'),s=await import('../db/schema'),q=await import('drizzle-orm');appClient=dbModule.client;owner=dbModule.createDb(migrationUrl.toString(),{max:2});
 const [role]=await dbModule.client`select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;check(role?.name==='ai_hr_app'&&!role.rolsuper&&!role.rolbypassrls,'Actual app role is privileged.');
 const [migrationRole]=await owner.client`select current_user name,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname=current_user`;check(migrationRole?.name===decodeURIComponent(migrationUrl.username)&&!migrationRole.rolsuper&&!migrationRole.rolbypassrls&&!migrationRole.rolcreaterole&&!migrationRole.rolcreatedb,'The actual restricted migration owner is required.');
 const [mailRole]=await owner.client`select rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,exists(select 1 from pg_auth_members m where m.member=r.oid) as member,exists(select 1 from pg_class c where c.relowner=r.oid) as owns_table,exists(select 1 from pg_namespace n where n.nspowner=r.oid) as owns_schema from pg_roles r where rolname='aihr_identity_email'`;check(mailRole&&!mailRole.rolsuper&&!mailRole.rolbypassrls&&!mailRole.rolcreaterole&&!mailRole.rolcreatedb&&!mailRole.rolreplication&&!mailRole.member&&!mailRole.owns_table&&!mailRole.owns_schema,'The actual private mail role is privileged.');
 const [db]=await owner.client`select current_database() name`;check(db?.name===DATABASE,'Connected to the wrong database.');
 for(const name of ['identity_email.queue_report(uuid,timestamptz,timestamptz)','identity_email.claim_reports(integer)','app.employee_master_render_context(uuid,uuid,text)']){const [row]=await owner.client`select to_regprocedure(${name}) present`;check(!!row?.present,'Apply reviewed0542/0546/0549 before fixture setup.');}
 const manifestPath=out+'/fixture.json',previous=await fs.readFile(manifestPath,'utf8').then(text=>JSON.parse(text),()=>null);
 const tenants=await owner.db.select({id:s.tenant.id,name:s.tenant.name}).from(s.tenant);const totalTenants=Number(command('/usr/sbin/runuser',['-u','postgres','--','psql','-d',DATABASE,'-At','-v','ON_ERROR_STOP=1','-c','select count(*) from public.tenant']));check(Number.isSafeInteger(totalTenants)&&totalTenants===tenants.length,'Restricted-owner tenant enumeration is incomplete; refuse rather than assuming the DB is empty.');check(tenants.every(t=>t.id===previous?.tenantId&&t.name==='Managed Reports acceptance fictional tenant'),'The named DB must be empty or contain exactly this receipt-bound fictional tenant. Do not seed demo/production tenants.');
 const providerToken=async()=>{const response=await fetch('http://127.0.0.1:8080/identity/realms/ai-hr/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:privateEnv.WORKFLOW_EMAIL_LOOKUP_CLIENT_ID,client_secret:privateEnv.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET}),redirect:'error',signal:AbortSignal.timeout(5000)});check(response.ok,'Actual local provider prerequisite unavailable.');const value=await response.json() as {access_token?:string};check(value.access_token,'Missing provider credential.');return value.access_token;};
 async function provider(method:string,relative:string,body?:unknown){check(/^users(?:\/[a-zA-Z0-9_-]+)?(?:\?username=[a-z-]+&exact=true)?$/.test(relative),'Fixed fixture provider resource only.');const token=await providerToken(),response=await fetch('http://127.0.0.1:8080/identity/admin/realms/ai-hr/'+relative,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});check(response.ok,'Actual fictional provider request refused.');return response.status===204?null:response.json();}
 const identities:Record<string,{subject:string;email:string}>={};
 for(const name of ['owner','recipient'] as const){const found=await provider('GET','users?username=report-delivery-'+name+'&exact=true') as Record<string,unknown>[];check(found.length===1,'Create the two exact fictional provider accounts first.');const a=found[0];check(a.username==='report-delivery-'+name&&a.email===EMAILS[name]&&a.enabled===true&&a.emailVerified===true&&!a.federationLink&&!a.serviceAccountClientId&&Array.isArray(a.requiredActions)&&a.requiredActions.length===0&&typeof a.id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(a.id),'Fictional provider identity is not eligible.');identities[name]={subject:a.id,email:EMAILS[name]};}
 const {provisionTenant}=await import('../db/provision'),{hireEmployee}=await import('../core/org'),{createDepartment}=await import('../core/admin'),{resolveEntitlementsTx}=await import('../core/entitlements'),{todayInKualaLumpur}=await import('../lib/hr-date');
 let base=previous;
 if(!base){
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:'Managed Reports acceptance fictional tenant',adminEmail:EMAILS.owner,country:'MY',modules:['notifications','payroll'],baseUrl:'https://report-acceptance.invalid'}));
  // Activation invitation is intentionally discarded; fixture logins are explicit isolated identities.
  const [user]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:made.personId,workosUserId:'report-acceptance:owner',onboardedAt:new Date()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:user.id,role:'super_admin',companyId:null});
  const ctx:SessionContext={tenantId:made.tenantId,userId:user.id,personId:made.personId,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,made.tenantId))};
  const dept=await createDepartment(ctx,{companyId:made.companyId,name:'Fictional report delivery team'}),date=todayInKualaLumpur();
  const employedOwner=await hireEmployee(ctx,{person:{id:made.personId},companyId:made.companyId,departmentId:dept.id,employeeCode:'REPORT-OWNER',employmentType:'full_time',hiredOn:date});
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional report recipient',primaryEmail:EMAILS.recipient},companyId:made.companyId,departmentId:dept.id,employeeCode:'REPORT-RECIPIENT',employmentType:'full_time',hiredOn:date});
  const [recipient]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:employee.personId,workosUserId:'report-acceptance:recipient',onboardedAt:new Date()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:recipient.id,role:'hr_admin',companyId:null});
  for(const [name,login]of [['owner',user],['recipient',recipient]] as const)await owner.db.insert(s.appExternalIdentity).values({issuer:ISSUER,subject:identities[name].subject,appUserId:login.id});
  await owner.db.insert(s.deploymentIdentityOperator).values({issuer:ISSUER,subject:identities.owner.subject,testEmail:EMAILS.owner});
  base={tenantId:made.tenantId,companyId:made.companyId,owner:{userId:user.id,personId:made.personId,employmentId:employedOwner.employmentId},recipient:{userId:recipient.id,personId:employee.personId,employmentId:employee.employmentId},date,identities};await fs.writeFile(manifestPath,JSON.stringify(base,null,2)+'\n',{mode:0o600,flag:'wx'});
 }
 check(base.date===todayInKualaLumpur(),'The prospective fixture crossed a KL date boundary; prepare a fresh disposable run.');
 check(JSON.stringify(base.identities)===JSON.stringify(identities),'Actual provider identities changed; preserve the receipt.');
 sink=await startReportSmtpSink({key,cert,port:SMTP_PORT,recipients:Object.values(EMAILS)});
 if(mode==='prepare'){
  console.log('Fictional setup ready. Use the real app Email settings as the enrolled owner to save/test/apply implicit TLS127.0.0.1:24656, auth off, from owner@report-acceptance.invalid. Stop using the owned stop file after configuration; no delivery verification has run.');
  await boundedWait(async()=>fs.stat(out+'/stop').then(()=>true,()=>false),startedAt+35*60_000);return;
 }
 const state=JSON.parse((await fs.readFile('/var/lib/aihr-identity-email/state.json','utf8')));check(state.active?.config.host==='127.0.0.1'&&state.active.config.port===SMTP_PORT&&state.active.config.auth===false&&state.active.config.from===EMAILS.owner&&state.active.config.security==='tls','Configure and test the canonical local-sink relay in prepare mode first.');
 await fs.writeFile(out+'/verification-started',marker.candidateSha+'\n',{mode:0o600,flag:'wx'});
 stage='installAndIsolation';installed=true;command('/usr/local/lib/aihr-identity-email/node',[STAGING+'/report-upgrade.cjs']);
 command('/usr/bin/python3',['-I','/usr/local/lib/aihr-identity-email/verify-report-isolation.py']);
 check((await privateRequest('/v1/reports',{op:'status'}) as {ready?:boolean}).ready===true,'Installed report agent not ready.');
 const contexts=async()=>{
  const make=async(which:'owner'|'recipient'):Promise<SessionContext>=>{const person=base[which],grants=await owner!.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(q.eq(s.roleAssignment.appUserId,person.userId)).orderBy(q.asc(s.roleAssignment.id));return {tenantId:base.tenantId,userId:person.userId,personId:person.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner!.db.transaction(tx=>resolveEntitlementsTx(tx,base.tenantId))};};return {admin:await make('owner'),recipient:await make('recipient')};
 };
 const {saveNotificationEmailPolicy,saveNotificationEmailPreferences}=await import('../core/notification-email'),{saveEmployeeMasterReport}=await import('../core/employee-master-reports'),{saveEmployeeMasterSchedule,getEmployeeMasterSchedule}=await import('../core/employee-master-schedules'),{defaultMasterColumn}=await import('../lib/employee-master-report'),{PERSONNEL_FIELDS}=await import('../lib/personnel-field-registry'),{setPayrollPermissionGrant}=await import('../packs/payroll/service');
 const {admin,recipient}=await contexts();const {setCompensation}=await import('../core/comp');for(const employee of [base.owner,base.recipient])await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:3500,currency:'MYR',effectiveFrom:base.date});await saveNotificationEmailPolicy(admin,['employee_master_reports']);
 const consent=()=>saveNotificationEmailPreferences(recipient,base.recipient.employmentId,['employee_master_reports'],'en',{issuer:ISSUER,subject:identities.recipient.subject,email:EMAILS.recipient,emailVerified:true});await consent();
 const field=(ownerName:string,ownerField:string)=>{const value=PERSONNEL_FIELDS.find(f=>f.owner===ownerName&&f.ownerField===ownerField&&f.report.enabled);check(value,'Canonical fixture report field unavailable.');return value;};
 const columns=[defaultMasterColumn(field('employment','employeeCode')),defaultMasterColumn(field('person','fullName'))];
 const due=new Date(Date.now()+180_000);due.setUTCSeconds(0,0);
 const cases:Record<string,{reportId:string;version:number;scheduleId:string;scheduled:Date}>={};
 const spec={v:2,asAt:base.date,companyIds:[base.companyId],includeDrafts:false,columns,expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 for(const name of ['attachment','consent','permission','identity','reportChanged','pendingCrash','startedCrash','smtpLost','smtpTemporary','oversized','artifactExpiry','cron',...Array.from({length:21},(_,i)=>'budget'+i)]){
  const saved=await saveEmployeeMasterReport(admin,[base.companyId],{name:'Acceptance '+name,description:'Fictional local report delivery outcome',sharedRoleIds:['hr_admin'],spec:name==='permission'?{...spec,columns:[columns[0],defaultMasterColumn(field('compensation','basicSalary'))]}:spec});
  const schedule=await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:saved.id,version:saved.version,enabled:true,config:{frequency:'weekly',day:due.getUTCDay(),hour:due.getUTCHours(),minute:due.getUTCMinutes(),timezone:'UTC'},recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});
  const live=await getEmployeeMasterSchedule(admin,saved.id);check(live?.nextRunAt&&new Date(live.nextRunAt).getTime()===due.getTime(),'Setup crossed its real scheduled minute; preserve and use a fresh disposable run.');cases[name]={reportId:saved.id,version:saved.version,scheduleId:schedule.id,scheduled:due};
 }
 const receipt:{candidate:string;database:string;environment:{platform:string;arch:string;node:string};results:{name:string;status:'VERIFIED';details:Record<string,unknown>}[];limitations:string[]}={candidate:marker.candidateSha,database:DATABASE,environment:{platform:process.platform,arch:process.arch,node:process.version},results:[],limitations:[]};
 const record=(name:string,details:Record<string,unknown>={})=>{receipt.results.push({name,status:'VERIFIED',details});};
 const slice=command('systemctl',['show','aihrmanagedmail.slice','--property=ControlGroup','--value']);check(/^\/[-a-zA-Z0-9_.\/]+$/.test(slice)&&!slice.includes('..'),'Unexpected memory cgroup.');
 const cgroup='/sys/fs/cgroup'+slice;
 const sampleMemory=async()=>{try{memory.aggregate=Math.max(memory.aggregate,Number((await fs.readFile(cgroup+'/memory.peak','utf8')).trim()));for(const entry of await fs.readdir(cgroup)){const kind=entry==='aihr-identity-email.service'?'mail':entry.startsWith('aihr-report-renderer@')?'renderer':null;if(kind)try{memory[kind]=Math.max(memory[kind],Number((await fs.readFile(cgroup+'/'+entry+'/memory.peak','utf8')).trim()));}catch{}}}catch{}};
 let memorySampling=false;memoryTimer=setInterval(()=>{if(memorySampling)return;memorySampling=true;void sampleMemory().finally(()=>{memorySampling=false;});},100);
 const queuedNames=new Set<string>();let scheduleFloor=0;
 await boundedWait(async()=>Date.now()>=due.getTime(),Date.now()+200_000);
 async function queue(name:string){
  check(!stopped,'Fixture stopped.');check(todayInKualaLumpur()===base.date,'Journey crossed a KL date boundary; preserve it.');stage=name;
  if(cases[name].scheduled.getTime()<scheduleFloor){
   const next=new Date(Date.now()+90_000);next.setUTCSeconds(0,0);
   for(const [key,item]of Object.entries(cases))if(!queuedNames.has(key)){await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:item.reportId,version:item.version,enabled:true,config:{frequency:'weekly',day:next.getUTCDay(),hour:next.getUTCHours(),minute:next.getUTCMinutes(),timezone:'UTC'},recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});item.scheduled=next;}
   await boundedWait(async()=>Date.now()>=next.getTime(),Date.now()+100_000);
  }
  queuedNames.add(name);const item=cases[name];const [r]=await owner!.client`select identity_email.queue_report(${item.scheduleId}::uuid,${item.scheduled.toISOString()}::timestamptz,${new Date(Date.now()+7*86400000).toISOString()}::timestamptz) added`;check(r.added===1,'Canonical queue refused this fixture occurrence.');const [job]=await owner!.client`select * from identity_email.claim_reports(1)`;check(job?.tenant_id===base.tenantId,'Unexpected claim.');const [row]=await owner!.client`select report_id from custom_report_occurrence where id=${job.id}::uuid`;check(row.report_id===item.reportId,'Claim is not the exact queued report.');return {id:String(job.id),token:String(job.lease_token)};}
 const outcome=async(job:{id:string})=>(await owner!.client`select status,reason,row_count,lease_until from custom_report_occurrence where id=${job.id}::uuid and tenant_id=${base.tenantId}::uuid`)[0];
 const deliver=(job:{id:string;token:string})=>privateRequest('/v1/reports',{op:'sendReport',occurrenceId:job.id,leaseToken:job.token});
 const target=async(job:{id:string;token:string})=>(await owner!.client`select identity_email.report_target(${job.id}::uuid,${job.token}::uuid,${ISSUER}) target`)[0].target;
 const render=async(job:{id:string;token:string})=>{const value=await target(job);check(value,'Canonical private target refused.');return renderer({phase:'render',occurrenceId:job.id,leaseToken:job.token,expectedAccessStamp:value.accessStamp});};
 const remove=(job:{id:string;token:string})=>renderer({phase:'remove',occurrenceId:job.id,leaseToken:job.token});
 async function noResend(job:{id:string}){const count=sink!.messages.length;const claims=await owner!.client`select * from identity_email.claim_reports(1)`;check(claims.length===0,'Terminal occurrence was reclaimed or unexpected work remained.');check(sink!.messages.length===count,'Unexpected extra SMTP data.');}
 const attachment=await queue('attachment');check((await deliver(attachment) as {outcome?:string}).outcome==='sent','Actual attachment was not sent.');const message=sink.messages.at(-1);check(message&&JSON.stringify(message.recipients)===JSON.stringify([EMAILS.recipient]),'Wrong SMTP envelope.');const bytes=reportAttachment(message.raw),XLSX=await import('xlsx'),book=XLSX.read(bytes,{type:'buffer'});const cells=book.SheetNames.flatMap(name=>XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name],{header:1,raw:true}).flatMap(row=>row.map(value=>String(value))));check(cells.includes('REPORT-RECIPIENT')&&cells.includes('Fictional report recipient'),'Canonical workbook cells missing.');check(!cells.some(value=>/salary|passport|bank account/i.test(value)),'Unselected sensitive content leaked.');check((await outcome(attachment)).status==='sent','Durable sent result missing.');await noResend(attachment);record('realWorkbookAndOneRecipient',{bytes:bytes.length,sha256:hash(bytes)});
 for(const name of ['consent','permission','identity','reportChanged'] as const){
  const job=await queue(name);check((await render(job)).ok===true,'Actual pre-revocation generation failed.');
  if(name==='consent')await saveNotificationEmailPreferences(recipient,base.recipient.employmentId,[],'en',null);
  if(name==='permission')await setPayrollPermissionGrant(admin,{companyId:base.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
  if(name==='identity')await provider('PUT','users/'+identities.recipient.subject,{emailVerified:false});
  if(name==='reportChanged')await saveEmployeeMasterReport(admin,[base.companyId],{id:cases[name].reportId,version:cases[name].version,name:'Acceptance changed after generation',description:'Changed',sharedRoleIds:['hr_admin'],spec});
  const before=sink.messages.length,result=await deliver(job) as {outcome?:string};check(result.outcome==='skipped'&&sink.messages.length===before,'Revoked authority still sent SMTP.');check((await outcome(job)).status==='skipped','Revocation audit missing.');record('afterGeneration-'+name);
  if(name==='consent'){await consent();scheduleFloor=Date.now();}if(name==='permission')await setPayrollPermissionGrant(admin,{companyId:base.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:true});if(name==='identity')await provider('PUT','users/'+identities.recipient.subject,{emailVerified:true});
 }
 const lost=await queue('smtpLost');sink.setMode('lost');check((await deliver(lost) as {outcome?:string}).outcome==='uncertain','Lost SMTP ACK must remain uncertain.');sink.setMode('accept');await noResend(lost);record('smtpLostAcknowledgementNoRetry');
 const temporary=await queue('smtpTemporary');sink.setMode('temporary');check((await deliver(temporary) as {outcome?:string}).outcome==='failed','Rejected report SMTP must be terminal failed.');sink.setMode('accept');await noResend(temporary);record('smtpTemporaryFailureNoAutomaticRetry');
 const pending=await queue('pendingCrash');const pendingUntil=(await outcome(pending)).lease_until;check(pendingUntil,'Missing pending lease expiry.');await boundedWait(async()=>Date.now()>new Date(pendingUntil).getTime(),Date.now()+190_000);const [reclaimed]=await owner.client`select * from identity_email.claim_reports(1)`;check(String(reclaimed?.id)===pending.id&&reclaimed.lease_token!==pending.token,'Pending crash did not reclaim a fresh nonce.');const pendingNew={id:pending.id,token:String(reclaimed.lease_token)};check(await target(pending)===null,'Old nonce remained valid.');check((await deliver(pendingNew) as {outcome?:string}).outcome==='sent','Reclaimed never-started work did not send exactly once.');record('unstartedLeaseReclaimsOnlyFreshNonce');
 const crash=await queue('startedCrash');sink.setMode('hold');const count=sink.messages.length,promise=deliver(crash).catch(()=>null);await boundedWait(async()=>sink!.messages.length===count+1&&((await outcome(crash)).status==='started'),Date.now()+100_000);command('systemctl',['kill','--kill-whom=main','--signal=KILL','aihr-identity-email.service']);sink.disconnect();await promise;sink.setMode('accept');command('systemctl',['start','aihr-identity-email.service']);const crashUntil=(await outcome(crash)).lease_until;await boundedWait(async()=>Date.now()>new Date(crashUntil).getTime(),Date.now()+190_000);await noResend(crash);check((await outcome(crash)).status==='uncertain','Abandoned started send did not become uncertain.');record('actualMailProcessCrashNoRetry');
 // A real generated artifact survives client loss, then request-driven cleanup removes it after ten minutes.
 const expiry=await queue('artifactExpiry');check((await render(expiry)).ok===true,'Actual artifact generation failed.');const artifact='/var/lib/aihr-report-renderer/render/'+expiry.id+'-'+expiry.token+'.xlsx';const original=await fs.lstat(artifact);check(original.isFile(),'Generated crash artifact missing.');await boundedWait(async()=>Date.now()-original.mtimeMs>601_000,Date.now()+610_000);check((await renderer({phase:'status'})).ready===true,'Renderer cleanup request failed.');check(!await fs.lstat(artifact).then(()=>true,()=>false),'Crash artifact outlived expiry cleanup.');record('actualArtifactCrashExpiry');
 // Expired never-started artifact occurrence must finish before budget cases can claim their own rows.
 const [expiredJob]=await owner.client`select * from identity_email.claim_reports(1)`;check(String(expiredJob?.id)===expiry.id,'Unexpected artifact reclaim.');await owner.client`select identity_email.finish_report(${expiry.id}::uuid,${expiredJob.lease_token}::uuid,'skipped','notEligible')`;
 const artifacts:{id:string;token:string}[]=[];try{for(let i=0;i<21;i++){const job=await queue('budget'+i);artifacts.push(job);const result=await render(job);check(i<20?result.ok===true:result.ok===false,'Artifact budget boundary was not enforced.');await owner.client`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'skipped','notEligible')`;}}finally{for(const job of artifacts)await remove(job);}record('twentyArtifactBudgetAndOwnedCleanup');
 // Large cells are created through the Family owner, never direct report/HR row inserts.
 stage='oversizedCanonicalSetup';const {addDependentTx}=await import('../core/dependents');await dbModule.withTenant(admin,async tx=>{for(let i=0;i<1000;i++){check(!stopped,'Fixture stopped.');await addDependentTx(tx,admin,base.recipient.personId,{fullName:'Fictional large row '+i,relationship:'child',remarks:randomBytes(22500).toString('base64')});}});
 const large=cases.oversized,largeSpec={...spec,columns:[{...defaultMasterColumn(field('dependent','remarks')),records:'all'}]};const updated=await saveEmployeeMasterReport(admin,[base.companyId],{id:large.reportId,version:large.version,name:'Acceptance oversized actual data',description:'Canonical Family-only oversized workbook',sharedRoleIds:['hr_admin'],spec:largeSpec});
 // Re-review schedules after editing; use a real future minute rather than mutating due/consent rows.
 const largeDue=new Date(Date.now()+90_000);largeDue.setUTCSeconds(0,0);await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:large.reportId,version:updated.version,enabled:true,config:{frequency:'weekly',day:largeDue.getUTCDay(),hour:largeDue.getUTCHours(),minute:largeDue.getUTCMinutes(),timezone:'UTC'},recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});large.version=updated.version;large.scheduled=largeDue;await boundedWait(async()=>Date.now()>=largeDue.getTime(),Date.now()+100_000);const oversized=await queue('oversized'),before=sink.messages.length;check((await deliver(oversized) as {outcome?:string}).outcome==='failed'&&(await outcome(oversized)).reason==='attachmentTooLarge'&&sink.messages.length===before,'Actual20MB refusal missing or sent SMTP.');record('actualOversizedWorkbookRefused');
 // Exercise the existing installed one-minute runner, not a new report scheduler or direct send substitute.
 stage='actualMinuteCron';const cronCase=cases.cron,cronDue=new Date(Date.now()+90_000);cronDue.setUTCSeconds(0,0);
 await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:cronCase.reportId,version:cronCase.version,enabled:true,config:{frequency:'weekly',day:cronDue.getUTCDay(),hour:cronDue.getUTCHours(),minute:cronDue.getUTCMinutes(),timezone:'UTC'},recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});
 const cronBefore=sink.messages.length;cronStarted=true;command('systemctl',['start','cron.service']);
 await boundedWait(async()=>{const rows=await owner!.client`select status from custom_report_occurrence where report_id=${cronCase.reportId}::uuid and tenant_id=${base.tenantId}::uuid`;return rows.length===1&&rows[0].status==='sent';},Date.now()+240_000);
 await boundedWait(async()=>{const rows=await owner!.client`select count(*)::integer count from job_run where job_key='reports.employee-master.deliver' and ran_at>=${cronDue.toISOString()}::timestamptz`;return Number(rows[0].count)>=2;},Date.now()+150_000);
 command('systemctl',['stop','cron.service']);await quiesceCron();cronStarted=false;check(sink.messages.length===cronBefore+1,'The second real cron tick sent a duplicate.');record('actualMinuteCronAndSecondTickNoDuplicate');
 await sampleMemory();for(const [kind,limit]of [['aggregate',768],['mail',192],['renderer',512]] as const){check(Number.isSafeInteger(memory[kind])&&memory[kind]>0&&memory[kind]<=limit*1024*1024,'Actual memory peak proof unavailable or exceeded.');}const events=await fs.readFile(cgroup+'/memory.events','utf8');check(/^oom_kill 0$/m.test(events),'Managed slice recorded an OOM kill.');record('actualCgroupPeaks',{...memory});
 receipt.limitations.push('No production host, real mail, browser/UI acceptance or full release gate is covered. The actual provider and the installed separate UID/RLS/renderer/SMTP paths above are covered only on this named disposable VM.');return {receipt,path:out+'/verification.json'};
}
main().then(async completed=>{await cleanup();check(!stopped&&!process.exitCode,'Owned-resource cleanup failed or deadline expired.');if(completed){await fs.writeFile(completed.path,JSON.stringify({...completed.receipt,cleanup:'VERIFIED'},null,2)+'\n',{mode:0o600,flag:'wx'});console.log('Controlled managed report receipt saved privately after owned-resource cleanup. This is not a production release receipt.');}}).catch(async error=>{if(privateReceiptDirectory)await fs.writeFile(privateReceiptDirectory+'/failure.json',JSON.stringify({status:'FAILED',stage,code:typeof error?.code==='string'&&/^[a-zA-Z0-9_]{1,64}$/.test(error.code)?error.code:null})+'\n',{mode:0o600});console.error('Managed report acceptance REFUSED/FAILED. Preserve the named disposable VM and private logs; no completion claim.');process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);try{await cleanup();}finally{process.exit(stopped||process.exitCode?1:0);}});
