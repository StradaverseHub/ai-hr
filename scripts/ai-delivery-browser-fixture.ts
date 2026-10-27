/** Import-safe fictional fixture preparation. Explicit CLI only; NEVER creates/resets/migrates a DB,
 * starts a service, sends mail, configures a provider or acquires/kills another owner's resources. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {and,asc,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
export const AI_DELIVERY_BROWSER_TARGET=Object.freeze({database:'aihr_ai_delivery_browser_v2_20261027',namespace:'ai_delivery_browser_v2_20261027',port:3177,leaseName:'ai-delivery-browser-v2-20261027',scratchpad:'scratchpad/ai-delivery-browser-v2-20261027'});
const root=fileURLToPath(new URL('..',import.meta.url));
const refusal=()=>new Error('AI delivery browser fixture refused; preserve existing resources and inspect private preparation evidence.');
/** Metadata alone is insufficient: require one actual live ancestor atomic coordinator, the complete
 * fixed set, the same nonce/PID on all three records, and its exact local coordinator invocation. */
export function assertAiDeliveryBrowserAdmission(){
 const target=AI_DELIVERY_BROWSER_TARGET,state=path.join(os.homedir(),'.aihr-gate-state');
 const ancestors=new Set<number>();let pid=process.ppid;
 for(let n=0;pid>1&&n<64;n++){if(ancestors.has(pid))throw refusal();ancestors.add(pid);pid=Number(execFileSync('ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'}).trim());if(!Number.isSafeInteger(pid)||pid<0)throw refusal();}
 const records:{schema:number;pid:number;token:string;name:string}[]=[];
 for(const relative of ['locks/slot.1','locks/slot.2','devdb-locks/slot.1']){
  const directory=path.join(state,relative),stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(directory)!==directory||stat.uid!==process.getuid?.())throw refusal();
  const file=path.join(directory,'lease.json'),recordStat=fs.lstatSync(file);if(!recordStat.isFile()||recordStat.isSymbolicLink()||recordStat.nlink!==1||recordStat.size>1024||recordStat.uid!==process.getuid?.())throw refusal();
  const record=JSON.parse(fs.readFileSync(file,'utf8')) as {schema:number;pid:number;token:string;name:string};
  if(record.schema!==1||!Number.isSafeInteger(record.pid)||!ancestors.has(record.pid)||record.name!==target.leaseName||!/^[a-f0-9]{32}$/.test(record.token)||fs.readFileSync(path.join(directory,'pid'),'utf8').trim()!==String(record.pid)||fs.readFileSync(path.join(directory,'name'),'utf8').trim()!==target.leaseName)throw refusal();
  process.kill(record.pid,0);records.push(record);
 }
 if(records.some(record=>record.pid!==records[0].pid||record.token!==records[0].token))throw refusal();
 const command=execFileSync('ps',['-o','command=','-p',String(records[0].pid)],{encoding:'utf8'});
 const coordinator=path.join(root,'scripts/local-resource-lock.py');
 if(!command.includes(coordinator)||!command.includes('--test-slots 2')||!command.includes('--database')||!command.includes(target.leaseName)||command.includes('--state-root'))throw refusal();
 if(process.env.AIHR_LOCK_DIR!==path.join(state,'locks')||process.env.AIHR_TEST_SLOTS!=='2')throw refusal();
}
function targetUrls(){
 const t=AI_DELIVERY_BROWSER_TARGET;
 if(process.env.NODE_ENV!=='development'||process.env.AUTH_PROVIDER!=='workos'||process.env.ALLOW_DEMO_SESSION!=='true'||process.env.TEST_DB_NAMESPACE!==t.namespace||process.env.PORT!==String(t.port)||process.env.NEXT_PUBLIC_APP_URL!==`http://127.0.0.1:${t.port}`)throw refusal();
 const urls=[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL].map(raw=>{const u=new URL(raw??'');if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.port!=='5433'||u.pathname!=='/'+t.database||u.hash||[...u.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))throw refusal();return u;});
 if(decodeURIComponent(urls[0].username)!=='ai_hr_app'||urls[0].username===urls[1].username)throw refusal();return urls;
}
/** Parent must hold the COMPLETE reservation for preparation AND the later server/browser lifetime.
 * This function never accepts a caller-selected database or actor context. */
export async function prepareAiDeliveryBrowserFixture(){
 assertAiDeliveryBrowserAdmission();const urls=targetUrls(),t=AI_DELIVERY_BROWSER_TARGET;
 const git=(args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',cwd:'/Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt'}).trim();
 if(git(['status','--porcelain','--untracked-files=all']))throw refusal();const candidate=git(['rev-parse','HEAD']);
 const output=path.join(root,t.scratchpad);fs.mkdirSync(output,{recursive:true,mode:0o700});if(fs.realpathSync(output)!==output||fs.lstatSync(output).isSymbolicLink())throw refusal();
 const manifestPath=path.join(output,'fixture.json'),fd=fs.openSync(manifestPath,'wx',0o600);
 fs.writeFileSync(fd,JSON.stringify({state:'preparation_started',candidate,database:t.database,warning:'Partial failure may leave canonical fixture facts. Do not reset or automatically retry.'}));
 const {createDb,client,withTenant}=await import('../db/client'),s=await import('../db/schema'),{SYSTEM_TENANT_ID}=await import('../db/seed-guard');
 const owner=createDb(urls[1].toString(),{max:1});
 try{
  const [app]=await client`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  const [physical]=await owner.client`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,rolsuper or rolbypassrls as full_visibility from pg_roles where rolname=current_user`;
  for(const proof of [app,physical])if(proof?.database!==t.database||proof.port!==5433||!['127.0.0.1','::1'].includes(proof.address))throw refusal();
  if(app.name!=='ai_hr_app'||app.rolsuper||app.rolbypassrls||physical.name!==decodeURIComponent(urls[1].username)||!physical.full_visibility)throw refusal();
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);if(tenants.some(row=>row.id!==SYSTEM_TENANT_ID))throw refusal();
  const [controls]=await owner.client`select to_regprocedure('app.ai_action_unpaused(text,boolean)') is not null as ready,to_regprocedure('app.assistant_own_leave_review_complete(uuid,text,uuid,uuid)') is not null as custody`;
  if(!controls?.ready||!controls.custody)throw refusal();
  const {provisionTenant}=await import('../db/provision'),{resolveEntitlementsTx}=await import('../core/entitlements'),{createDepartment,updateLeaveType,setLeaveTypeRules}=await import('../core/admin'),{createEntitlementTemplate,setLeaveTypeDefaultTemplate}=await import('../core/entitlement-template'),{hireEmployee}=await import('../core/org'),{grantAssistant,revokeAssistant}=await import('../core/assistant-grant'),{readOwnLeaveCandidateTx}=await import('../core/assistant-actions/own-leave-candidate'),{withAssistantRead}=await import('../core/assistant-read-session'),{todayInKualaLumpur}=await import('../lib/hr-date');
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:'Fictional AI Delivery Browser Only',adminEmail:'ai-browser-admin@example.test',country:'MY',modules:['assistant','country-my'],baseUrl:`http://127.0.0.1:${t.port}`}));
  // Identity/role fixtures only: same dev_user/principal path as existing local browser runners.
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:made.appUserId,companyId:null,role:'hr_admin'}).onConflictDoNothing();
  async function context(userId:string,personId:string|null):Promise<SessionContext>{const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,made.tenantId),eq(s.roleAssignment.appUserId,userId))).orderBy(asc(s.roleAssignment.id));return{tenantId:made.tenantId,userId,personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,made.tenantId))};}
  const hr=await context(made.appUserId,made.personId);await grantAssistant(hr,{appUserId:made.appUserId});
  const department=await createDepartment(hr,{companyId:made.companyId,name:'Fictional AI Browser Department'}),today=todayInKualaLumpur(),yearStart=today.slice(0,4)+'-01-01';
  const [annual]=await owner.db.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId,made.tenantId),eq(s.leaveType.code,'ANNUAL'))).limit(1);if(!annual)throw refusal();
  await updateLeaveType(hr,{id:annual.id,name:annual.name,employeeRemarkRequired:true});
  const template=await createEntitlementTemplate(hr,{leaveTypeId:annual.id,name:'Fictional AI Browser Annual 20',validFrom:yearStart,serviceBands:[{fromYears:0,toYears:null,days:20,carryForwardDays:0,maxBalanceDays:20}]});
  // Creating a table alone neither selects its lineage nor configures an earning method.
  // These are explicit fictional HR policy choices through the actual canonical owners, before hire.
  const selectedTemplate=await setLeaveTypeDefaultTemplate(hr,{leaveTypeId:annual.id,templateLineageId:template.lineageId});
  if(selectedTemplate.leaveTypeId!==annual.id||selectedTemplate.defaultTemplateLineageId!==template.lineageId)throw refusal();
  await setLeaveTypeRules(hr,{id:annual.id,accrualMethod:'lump_sum'});
  const [configured]=await owner.db.select({lineage:s.leaveType.defaultEntitlementTemplateLineageId,method:s.leaveType.accrualMethod}).from(s.leaveType).where(and(eq(s.leaveType.tenantId,made.tenantId),eq(s.leaveType.id,annual.id)));
  if(configured?.lineage!==template.lineageId||configured.method!=='lump_sum')throw refusal();
  const actors:Record<string,{userId:string;personId:string|null;employmentId:string|null}>={hr:{userId:made.appUserId,personId:made.personId,employmentId:null}};
  for(const [key,code]of [['own','AI-BROWSER-OWN'],['peer','AI-BROWSER-PEER'],['revoked','AI-BROWSER-REVOKED']] as const){
   const hired=await hireEmployee(hr,{person:{fullName:`Fictional AI Browser ${key}`,primaryEmail:`ai-browser-${key}@example.test`},companyId:made.companyId,departmentId:department.id,employeeCode:code,employmentType:'full_time',hiredOn:yearStart,grantLeaveTypes:[{id:annual.id,code:annual.code,yearCycleOverride:annual.yearCycleOverride}]});
   const [user]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:hired.personId,workosUserId:'ai-delivery-browser:'+key,onboardedAt:new Date()}).returning({id:s.appUser.id});await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:user.id,companyId:null,role:'employee'});await grantAssistant(hr,{appUserId:user.id});if(key==='revoked')await revokeAssistant(hr,{appUserId:user.id});actors[key]={userId:user.id,personId:hired.personId,employmentId:hired.employmentId};
  }
  const [standalone]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:null,workosUserId:'ai-delivery-browser:standalone',onboardedAt:new Date()}).returning({id:s.appUser.id});await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:standalone.id,companyId:null,role:'hr_admin'});await grantAssistant(hr,{appUserId:standalone.id});actors.standalone={userId:standalone.id,personId:null,employmentId:null};
  const own=actors.own,ownCtx=await context(own.userId,own.personId),selection={employmentId:own.employmentId!,leaveTypeId:annual.id},humanText={reason:'Fictional personal appointment entered by the human',employeeRemark:'Fictional browser review only'};
  // Ask the actual candidate owner; a guessed weekday is not canonical eligibility proof.
  let checked:Awaited<ReturnType<typeof readOwnLeaveCandidateTx>>|undefined,requestedDate='';const date=new Date(today+'T00:00:00Z');
  for(let n=0;n<31;n++){date.setUTCDate(date.getUTCDate()+1);requestedDate=date.toISOString().slice(0,10);const nomination={action:'leave.apply',contractVersion:1,employmentId:own.employmentId!,leaveTypeId:annual.id,date:requestedDate,durationType:'full_day'};checked=await withTenant(ownCtx,tx=>readOwnLeaveCandidateTx(tx,ownCtx,nomination,selection,humanText,'en'));if(checked.kind==='candidate'&&checked.candidate.deductionDays===1&&typeof checked.candidate.availableBalance==='number'&&Number.isFinite(checked.candidate.availableBalance)&&checked.candidate.availableBalance>=1)break;}
  if(checked?.kind!=='candidate'||checked.candidate.deductionDays!==1||typeof checked.candidate.availableBalance!=='number'||!Number.isFinite(checked.candidate.availableBalance)||checked.candidate.availableBalance<1)throw refusal();
  const workspace:Record<string,unknown>={};for(const module of ['employees','leave','ess'] as const)workspace[module]=await withAssistantRead(ownCtx,module,read=>read.moduleWork(module));
  const [counts]=await owner.client`select (select count(*)::int from leave_request where tenant_id=${made.tenantId}::uuid) as leave_requests,(select count(*)::int from domain_event where tenant_id=${made.tenantId}::uuid and event_type='leave-request.submitted') as submitted_events`;
  if(counts.leave_requests!==0||counts.submitted_events!==0)throw refusal();
  assertAiDeliveryBrowserAdmission();if(git(['rev-parse','HEAD'])!==candidate||git(['status','--porcelain','--untracked-files=all']))throw refusal();
  const manifest={state:'prepared_not_experienced',candidate,target:t,tenantId:made.tenantId,companyId:made.companyId,actors,annualTypeId:annual.id,today,requestedDate,humanText,expectedNative:{before:counts,deductionDays:checked.candidate.deductionDays,availableBalance:checked.candidate.availableBalance},workspace,provider:'No configuration/key/network activation; capability and delivery unverified',auth:'Existing local dev_user selector only; not production authentication proof'};
  fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify(manifest,null,2)+'\n',0,'utf8');fs.fsyncSync(fd);console.log('Private fictional fixture prepared; no browser or release PASS claimed.');return manifestPath;
 }finally{fs.closeSync(fd);await owner.client.end();await client.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareAiDeliveryBrowserFixture().catch(()=>{console.error('AI delivery browser fixture refused or failed; preserve private receipt and target.');process.exitCode=1;});
