/** UNINSTALLED/nonpackaged LOGIN/receipt lifecycle only; no service DTO claim. */
import postgres from 'postgres';
import {z} from 'zod';
if(process.env.NODE_ENV!=='test'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||!process.send)throw Error('Owned hosted policy child required');
const allowed=new Set(['NODE_ENV','PATH','TZ','LANG','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY']);if(Object.keys(process.env).some(key=>!allowed.has(key)))throw Error('Closed policy child environment required');
globalThis.fetch=async()=>{throw Error('Policy child cannot invoke providers/network');};
const base={database:z.string().regex(/^ai_hr_test_w[1-9][0-9]*(?:_[a-z0-9][a-z0-9_]{0,19})?$/),readerUrl:z.string(),tenantId:z.guid(),userId:z.guid(),roles:z.array(z.string()).max(16),grants:z.array(z.object({role:z.string(),companyId:z.guid().nullable()}).strict()).max(32)};
const request=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('read'),year:z.number().int(),pause:z.enum(['before-commit','after-commit'])}).strict(),
 z.object({...base,kind:z.literal('reconcile'),receiptId:z.guid()}).strict(),
]);
const send=(message:object)=>new Promise<void>((resolve,reject)=>{process.send!(message,error=>error?reject(error):resolve());});
let used=false,release:(()=>void)|undefined;
process.on('message',async message=>{
 if(message&&typeof message==='object'&&'kind'in message&&message.kind==='continue'&&Object.keys(message).length===1){release?.();return;}
 if(used){process.exitCode=1;return;}used=true;let connection:ReturnType<typeof postgres>|undefined;
 try{
  const input=request.parse(message),url=new URL(input.readerUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!=='ai_hr_reward_audit_read'||!url.password||url.pathname!=='/'+input.database||url.search||url.hash)throw Error('Exact dedicated reader required');
  connection=postgres(url.toString(),{max:1,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300}});
  const pause=()=>new Promise<void>(resolve=>{release=resolve;});
  const result=await connection.begin(input.kind==='read'?'isolation level repeatable read read write':'isolation level repeatable read read only',async tx=>{
   await tx`select set_config('app.tenant_id',${input.tenantId},true),set_config('app.user_id',${input.userId},true),set_config('app.roles',${input.roles.join(',')},true),set_config('app.grants',${JSON.stringify(input.grants)},true),set_config('app.agent_principal_id','',true)`;
   const [identity]=await tx`select session_user,current_user,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,current_database()as database,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock`;
   if(identity.session_user!=='ai_hr_reward_audit_read'||identity.current_user!=='ai_hr_reward_audit_read'||identity.database!==input.database||identity.statement!=='20s'||identity.lock!=='300ms')throw Error('Actual native reader carrier required');
   if(input.kind==='reconcile')return{kind:'reconciled',value:(await tx`select reward_audit_read.reconcile_receipt(${input.receiptId}::uuid)as value`)[0].value,...identity};
   const [admission]=await tx`select reward_audit_read.begin_read('libraries','salary',${input.year})as id`;
   const [receipt]=await tx`select * from reward_audit_read.finalize_read(${admission.id}::uuid)`;
   if(input.pause==='before-commit'){const wait=pause();await send({kind:'finalized',receiptId:receipt.id,...identity});await wait;}
   return{kind:'committed',receiptId:receipt.id,...identity};
  });
  const wait=input.kind==='read'&&input.pause==='after-commit'?pause():undefined;
  await send(result);await wait;process.exitCode=0;
 }catch{process.exitCode=1;await send({kind:'refused'});}
 finally{await connection?.end({timeout:0});process.disconnect();}
});
void send({kind:'ready'}).catch(()=>{process.exitCode=1;process.disconnect();});
