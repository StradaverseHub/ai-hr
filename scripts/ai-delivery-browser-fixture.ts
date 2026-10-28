/** Import-safe fictional fixture preparation. Explicit CLI only; NEVER creates/resets/migrates a DB,
 * starts a service, sends mail, configures a provider or acquires/kills another owner's resources. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
export const AI_DELIVERY_BROWSER_TARGET=Object.freeze({database:'aihr_ai_delivery_browser_v4_20261027',namespace:'ai_delivery_browser_v4_20261027',port:3177,leaseName:'ai-delivery-browser-v4-20261027',scratchpad:'scratchpad/ai-delivery-browser-v4-20261027'});
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
 const {createDb,client}=await import('../db/client'),s=await import('../db/schema'),{SYSTEM_TENANT_ID}=await import('../db/seed-guard');
 const owner=createDb(urls[1].toString(),{max:1});
 try{
  const [app]=await client`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  const [physical]=await owner.client`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,rolsuper or rolbypassrls as full_visibility from pg_roles where rolname=current_user`;
  for(const proof of [app,physical])if(proof?.database!==t.database||proof.port!==5433||!['127.0.0.1','::1'].includes(proof.address))throw refusal();
  if(app.name!=='ai_hr_app'||app.rolsuper||app.rolbypassrls||physical.name!==decodeURIComponent(urls[1].username)||!physical.full_visibility)throw refusal();
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);if(tenants.some(row=>row.id!==SYSTEM_TENANT_ID))throw refusal();
  const [controls]=await owner.client`select to_regprocedure('app.ai_action_unpaused(text,boolean)') is not null as ready,to_regprocedure('app.assistant_own_leave_review_complete(uuid,text,uuid,uuid)') is not null as custody`;
  if(!controls?.ready||!controls.custody)throw refusal();
  const {populateAiDeliveryFullFixture}=await import('./fixtures/ai-delivery-full-fixture');
  const full=await populateAiDeliveryFullFixture(owner);
  assertAiDeliveryBrowserAdmission();if(git(['rev-parse','HEAD'])!==candidate||git(['status','--porcelain','--untracked-files=all']))throw refusal();
  const manifest={...full,candidate,target:t,provider:'No configuration/key/network activation; capability and delivery unverified',auth:'Existing local dev_user selector only; notification verified identity still unavailable; not production authentication proof'};
  fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify(manifest,null,2)+'\n',0,'utf8');fs.fsyncSync(fd);console.log('Private full-module native fixture prepared; no browser or release PASS claimed.');return manifestPath;
 }catch(error){
  // Private admitted fixture diagnostics only. Never send native SQL/error details to the product UI.
  const capture=(value:unknown,depth=0):unknown=>depth>8?{truncated:true}:value instanceof Error?{name:value.name,message:value.message,stack:value.stack,cause:value.cause===undefined?undefined:capture(value.cause,depth+1)}:{kind:typeof value};
  fs.writeFileSync(path.join(output,'fixture.failure.json'),JSON.stringify({candidate,state:'failed_no_acceptance',error:capture(error)},null,2)+'\n',{flag:'wx',mode:0o600});throw error;
 }finally{fs.closeSync(fd);await owner.client.end();await client.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareAiDeliveryBrowserFixture().catch(()=>{console.error('AI delivery browser fixture refused or failed; preserve private receipt and target.');process.exitCode=1;});
