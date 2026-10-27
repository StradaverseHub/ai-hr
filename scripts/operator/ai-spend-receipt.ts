/** Standalone operator CLI. NEVER import db/client (its singleton application pools are unrelated). */
import {constants} from 'node:fs';
import {lstat,readFile,open,realpath,rename,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import postgres from 'postgres';
import {prepareReceipt,type ReceiptFiles,type ReceiptDatabase,type Pair,type Preparation} from './ai-spend-receipt-core';
const refuse=():never=>{throw Error('Receipt preparation refused. No route was activated. Consult the private recovery record and release operator.');};
export function parseReceiptArguments(args:readonly string[]):Preparation&{recoveryDirectory:string}{
 const value=new Map<string,string>();let apply=false,recover=false;
 for(let i=0;i<args.length;i++){
  const key=args[i];if(key==='--apply'){if(apply)refuse();apply=true;continue;}if(key==='--recover'){if(recover)refuse();recover=true;continue;}
  if(!['--environment','--env-file','--recovery-directory','--release-window-evidence'].includes(key)||value.has(key)||!args[i+1]||args[i+1].startsWith('--'))refuse();value.set(key,args[++i]);
 }
 if(apply&&value.get('--environment')!=='staging')refuse();
 const envPath=value.get('--env-file')??'',recoveryDirectory=value.get('--recovery-directory')??'';
 if(!isAbsolute(envPath)||resolve(envPath)!==envPath||!isAbsolute(recoveryDirectory)||resolve(recoveryDirectory)!==recoveryDirectory)refuse();
 return{environment:value.get('--environment')??'staging',envPath,recoveryDirectory,apply,recover,releaseWindowEvidence:value.get('--release-window-evidence')};
}
/** Reject links, public permissions and foreign-owned files. Never shell-source environment text. */
export async function privateReceiptFiles(envPath:string,recoveryDirectory:string):Promise<ReceiptFiles>{
 const uid=process.getuid?.();if(uid===undefined)refuse();
 const secureDirectory=async(path:string)=>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0||await realpath(path)!==path)refuse();};
 const secureFile=async(path:string)=>{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size>4*1024*1024)refuse();};
 const outsideGit=async(path:string)=>{let directory=path;while(true){try{await lstat(join(directory,'.git'));refuse();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const parent=dirname(directory);if(parent===directory)break;directory=parent;}};
 await outsideGit(dirname(envPath));await outsideGit(recoveryDirectory);
 if(await realpath(dirname(envPath))!==dirname(envPath))refuse();const parent=await lstat(dirname(envPath));if(!parent.isDirectory()||(parent.uid!==uid&&parent.uid!==0)||(parent.mode&0o022)!==0)refuse();await secureFile(envPath);
 // Recovery is deliberately outside the application/repository/environment directory.
 if(recoveryDirectory===dirname(envPath)||recoveryDirectory.startsWith(dirname(envPath)+'/'))refuse();
 await secureDirectory(recoveryDirectory);
 const pending=join(recoveryDirectory,'ai-spend-receipt.pending.json'),lockPath=join(recoveryDirectory,'ai-spend-receipt.lock');
 const readSecure=async(path:string)=>{await secureFile(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(stat.uid!==uid||!stat.isFile()||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size>4*1024*1024)refuse();return new TextDecoder('utf-8',{fatal:true}).decode(await handle.readFile());}finally{await handle.close();}};
 const syncDirectory=async(path:string)=>{const handle=await open(path,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}};
 return{
  readEnvironment:()=>readSecure(envPath),
  async readPending(){try{return await readSecure(pending);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
  async createPending(value){const handle=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(value,'utf8');await handle.sync();}finally{await handle.close();}await syncDirectory(recoveryDirectory);},
  async lock(){const handle=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(String(process.pid)+'\n');await handle.sync();}finally{await handle.close();}return async()=>{await unlink(lockPath);await syncDirectory(recoveryDirectory);};},
  async replaceEnvironment(expected,replacement){
   if(await readSecure(envPath)!==expected)refuse();const temporary=envPath+'.receipt-pending';
   const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(replacement,'utf8');await handle.sync();}finally{await handle.close();}
   // Recheck immediately before rename; operators MUST serialize all environment writers in window.
   if(await readSecure(envPath)!==expected)refuse();await rename(temporary,envPath);await syncDirectory(dirname(envPath));
  }
 };
}
export function receiptDatabase(connection:ReturnType<typeof postgres>):ReceiptDatabase{
 return{
  async inspect(){
   const [r]=await connection`select current_database() as database,current_user as actor,inet_server_addr()::text as address,inet_server_port() as port,
    c.relowner=(select oid from pg_roles where rolname=current_user) as owns,
    (select datdba=(select oid from pg_roles where rolname=current_user) from pg_database where datname=current_database()) as database_owner,c.relrowsecurity as rls,
    to_regprocedure('public.hmac(bytea,bytea,text)') is not null and to_regprocedure('public.digest(bytea,text)') is not null as crypto
    from pg_class c where c.oid=to_regclass('app.ai_spend_receipt_verifier')`;
   if(!r?.owns||!r.database_owner||!r.rls||!r.crypto)refuse();
   // Read the ACTUAL required columns; missing/incompatible migrations refuse, never auto-create.
   await connection`select key_id,secret,enabled,valid_from,retired_at from app.ai_spend_receipt_verifier where false`;
   const [count]=await connection`select count(*)::integer as total from app.ai_spend_receipt_verifier where enabled and retired_at is null`;
   const [permissions]=await connection`select has_table_privilege('ai_hr_app','app.ai_spend_receipt_verifier','SELECT') or has_table_privilege('ai_hr_app','app.ai_spend_receipt_verifier','INSERT') or has_table_privilege('ai_hr_app','app.ai_spend_receipt_verifier','UPDATE') or has_table_privilege('ai_hr_app','app.ai_spend_receipt_verifier','DELETE') as exposed`;
   const [column]=await connection`select has_any_column_privilege('ai_hr_app','app.ai_spend_receipt_verifier','SELECT') or has_any_column_privilege('ai_hr_app','app.ai_spend_receipt_verifier','INSERT') or has_any_column_privilege('ai_hr_app','app.ai_spend_receipt_verifier','UPDATE') as exposed`;
   if(permissions?.exposed||column?.exposed)refuse();
   const [shape]=await connection`select to_regprocedure('app.ai_spend_reconcile_receipt(text,text)') is not null as reconciler,
    exists(select 1 from pg_constraint where conrelid='app.ai_spend_receipt_verifier'::regclass and contype='p') as primary_key,
    exists(select 1 from pg_constraint where conrelid='app.ai_spend_receipt_verifier'::regclass and contype='c' and pg_get_constraintdef(oid) like '%octet_length(secret) = 32%') as key_size`;
   if(!shape?.reconciler||!shape.primary_key||!shape.key_size)refuse();
   return{identity:createHash('sha256').update(JSON.stringify([r.database,r.actor,r.address,r.port])).digest('hex'),activeKeys:count.total};
  },
  async find(id){const [r]=await connection`select key_id as id,encode(secret,'hex') as secret,enabled,(valid_from<=now() and retired_at is null) as usable from app.ai_spend_receipt_verifier where key_id=${id}`;return r?{id:r.id,secret:r.secret,enabled:r.enabled,usable:r.usable}:null;},
  async insert(pair:Pair){await connection.begin(async tx=>{
   await tx`lock table app.ai_spend_receipt_verifier in exclusive mode nowait`;
   const [r]=await tx`select count(*)::integer as total from app.ai_spend_receipt_verifier where enabled and retired_at is null`;if(r.total!==0)refuse();
   await tx`insert into app.ai_spend_receipt_verifier(key_id,secret) values(${pair.id},decode(${pair.secret},'hex'))`;
  });}
 };
}
export async function receiptMain(args:readonly string[]):Promise<void>{
 let connection:ReturnType<typeof postgres>|undefined;
 try{
  const options=parseReceiptArguments(args);if(options.environment!=='staging')refuse();
  if(options.apply){const evidence=options.releaseWindowEvidence;if(!evidence||!isAbsolute(evidence)||await realpath(evidence)!==evidence)refuse();const stat=await lstat(evidence);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size===0||stat.size>1024*1024)refuse();}
  const url=process.env.AI_SPEND_OWNER_DATABASE_URL;if(!url)refuse();
  const files=await privateReceiptFiles(options.envPath,options.recoveryDirectory);
  // Dedicated one-connection owner client; no application pool, notices, retries or SQL logging.
  connection=postgres(url,{max:1,connect_timeout:5,idle_timeout:5,onnotice:()=>{}});
  const result=await prepareReceipt(options,files,receiptDatabase(connection));
  process.stdout.write(JSON.stringify({status:result.status,writes:result.writes,environment:'staging',routeActivated:false})+'\n');
 }catch{process.stderr.write('Receipt preparation refused. No route was activated. Consult the private recovery record and release operator.\n');process.exitCode=1;}
 finally{try{await connection?.end({timeout:5});}catch{process.exitCode=1;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void receiptMain(process.argv.slice(2));
